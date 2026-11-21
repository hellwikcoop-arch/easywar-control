#!/usr/bin/env python3
"""Локальний сервер Центру контролю EasyWAR (режим лише читання GitHub)."""
from __future__ import annotations

import getpass
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "4.0.0"
ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
STATE = Path(os.environ.get("EASYWAR_CENTER_STATE_DIR", str(ROOT / "state"))).resolve()
DB = STATE / "center.sqlite3"

OWNER = os.environ.get("EASYWAR_GITHUB_OWNER", "hellwikcoop-arch").strip() or "hellwikcoop-arch"
REPOS = tuple(
    item.strip()
    for item in os.environ.get("EASYWAR_GITHUB_REPOS", "EasyWAR,easywar-staff,easywar-releases").split(",")
    if item.strip()
) or ("EasyWAR",)

REFRESH_SECONDS = max(60, int(os.environ.get("EASYWAR_REFRESH_SECONDS", "900")))
FORCE_COOLDOWN_SECONDS = max(3, int(os.environ.get("EASYWAR_FORCE_COOLDOWN", "10")))
MAX_ARTIFACT_BYTES = 30 * 1024 * 1024
MAX_JSON_BODY_BYTES = 1024 * 1024
ARTIFACT_PREFIX = "easywar-screens-"

ALLOWED_RECORD_KINDS = frozenset({
    "cycle",
    "checklist",
    "task",
    "decision",
    "question",
    "next",
    "budget",
    "log",
})

ALLOWED_AGENT_ROLES = ("J5", "J3", "J4", "C5.1", "Власник")
ALLOWED_AGENT_STATUSES = (
    "Чернетка · очікує передачі агенту",
    "Передано вручну",
    "На перевірці",
    "Виконано",
    "Заблоковано",
)

LOCK = threading.Lock()
WRITE_LOCK = threading.Lock()
CSRF_TOKEN = secrets.token_urlsafe(32)
last_attempt = 0.0
last_force_attempt = 0.0
last_result = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_github_token() -> str:
    explicit = os.environ.get("EASYWAR_GITHUB_TOKEN", "").strip()
    if explicit:
        return explicit
    if Path("/usr/bin/security").exists():
        try:
            result = subprocess.run(
                [
                    "/usr/bin/security",
                    "find-generic-password",
                    "-w",
                    "-s",
                    "easywar-control-github",
                    "-a",
                    getpass.getuser(),
                ],
                check=True,
                text=True,
                capture_output=True,
                timeout=6,
            )
            token = result.stdout.strip()
            if token:
                return token
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            pass
    if os.environ.get("EASYWAR_DISABLE_GH_CLI", "") != "1":
        try:
            result = subprocess.run(
                ["gh", "auth", "token"],
                check=True,
                text=True,
                capture_output=True,
                timeout=4,
            )
            token = result.stdout.strip()
            if token:
                return token
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
    return ""


def translate_network_error(error: BaseException) -> str:
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 401:
            return "Помилка авторизації GitHub (401). Перевірте токен читання."
        if error.code == 403:
            remaining = error.headers.get("X-RateLimit-Remaining") if error.headers else None
            if remaining == "0":
                return "Вичерпано ліміт запитів GitHub API. Додайте токен читання або повторіть пізніше."
            return "Доступ до GitHub API обмежено (403). Перевірте права токена."
        if error.code == 404:
            return "Репозиторій або ресурс не знайдено на GitHub (404)."
        return f"Помилка відповіді GitHub (код {error.code})."
    if isinstance(error, TimeoutError):
        return "Перевищено час очікування відповіді від GitHub."
    if isinstance(error, urllib.error.URLError):
        return "Немає з’єднання з GitHub. Перевірте інтернет-підключення."
    if isinstance(error, zipfile.BadZipFile):
        return "Пошкоджений архів артефакту знімків."
    return "Тимчасова помилка отримання даних із GitHub."


def database() -> sqlite3.Connection:
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(STATE, 0o700)
    except OSError:
        pass
    db = sqlite3.connect(DB)
    try:
        DB.chmod(0o600)
    except OSError:
        pass
    db.execute("PRAGMA busy_timeout = 3000")
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("CREATE TABLE IF NOT EXISTS snapshot (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute(
        "CREATE TABLE IF NOT EXISTS manual_records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS agent_tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, value TEXT NOT NULL)"
    )
    db.commit()
    return db


def cached_snapshot():
    with closing(database()) as db:
        row = db.execute("SELECT value FROM snapshot WHERE key = 'github'").fetchone()
    return json.loads(row[0]) if row else None


def save_snapshot(value: dict) -> None:
    with closing(database()) as db:
        with db:
            db.execute(
                "INSERT OR REPLACE INTO snapshot VALUES ('github', ?)",
                (json.dumps(value, ensure_ascii=False),),
            )


def read_records() -> dict:
    with closing(database()) as db:
        row = db.execute("SELECT revision, value FROM manual_records WHERE key = 'owner'").fetchone()
    return {"revision": row[0], "records": json.loads(row[1])} if row else {"revision": 0, "records": None}


def write_records(expected_revision, records):
    if type(expected_revision) is not int or expected_revision < 0:
        raise ValueError("Недійсний номер ревізії")
    if not isinstance(records, list) or len(records) > 1500:
        raise ValueError("Недійсний список записів")
    for record in records:
        if (
            not isinstance(record, dict)
            or record.get("kind") not in ALLOWED_RECORD_KINDS
            or record.get("githubManaged")
            or not isinstance(record.get("id"), str)
            or not (1 <= len(record["id"]) <= 128)
        ):
            raise ValueError("Недійсний формат запису")
    with WRITE_LOCK:
        with closing(database()) as db:
            current = db.execute("SELECT revision FROM manual_records WHERE key = 'owner'").fetchone()
            revision = current[0] if current else 0
            if expected_revision != revision:
                return None
            with db:
                db.execute(
                    "INSERT OR REPLACE INTO manual_records VALUES ('owner', ?, ?)",
                    (revision + 1, json.dumps(records, ensure_ascii=False)),
                )
            return revision + 1


def read_tasks() -> list[dict]:
    with closing(database()) as db:
        rows = db.execute("SELECT value FROM agent_tasks ORDER BY created_at DESC LIMIT 200").fetchall()
    return [json.loads(row[0]) for row in rows]


def _validate_task_fields(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Недійсний формат доручення")
    title = str(payload.get("title", "")).strip()
    instruction = str(payload.get("instruction", "")).strip()
    role = payload.get("role")
    repo = payload.get("repo")
    sha = str(payload.get("sha", "")).strip()
    pr_ref = str(payload.get("prRef", "")).strip()[:64]
    status = payload.get("status", ALLOWED_AGENT_STATUSES[0])
    result = str(payload.get("result", "")).strip()
    if (
        not (1 <= len(title) <= 160)
        or not (1 <= len(instruction) <= 5000)
        or role not in ALLOWED_AGENT_ROLES
        or repo not in REPOS
        or (sha and not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha))
        or status not in ALLOWED_AGENT_STATUSES
        or len(result) > 10000
    ):
        raise ValueError("Недійсні поля доручення")
    return {
        "title": title,
        "instruction": instruction,
        "role": role,
        "repo": repo,
        "sha": sha.lower(),
        "prRef": pr_ref,
        "status": status,
        "result": result,
    }


def create_task(payload: dict) -> dict:
    fields = _validate_task_fields(payload)
    now = utc_now()
    task = {
        "id": secrets.token_hex(12),
        "createdAt": now,
        "updatedAt": now,
        **fields,
        "agentRunId": None,
    }
    with WRITE_LOCK:
        with closing(database()) as db:
            with db:
                db.execute(
                    "INSERT INTO agent_tasks VALUES (?, ?, ?)",
                    (task["id"], task["createdAt"], json.dumps(task, ensure_ascii=False)),
                )
    return task


def update_task(task_id: str, payload: dict):
    if not re.fullmatch(r"[0-9a-f]{24}", task_id):
        return None
    fields = _validate_task_fields(payload)
    with WRITE_LOCK:
        with closing(database()) as db:
            row = db.execute("SELECT value FROM agent_tasks WHERE id = ?", (task_id,)).fetchone()
            if not row:
                return None
            task = {**json.loads(row[0]), **fields, "updatedAt": utc_now()}
            with db:
                db.execute(
                    "UPDATE agent_tasks SET value = ? WHERE id = ?",
                    (json.dumps(task, ensure_ascii=False), task_id),
                )
            return task


def delete_task(task_id: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{24}", task_id):
        return False
    with WRITE_LOCK:
        with closing(database()) as db:
            with db:
                cursor = db.execute("DELETE FROM agent_tasks WHERE id = ?", (task_id,))
            return cursor.rowcount > 0


def github_request(path: str, *, token: str = "", binary: bool = False):
    url = "https://api.github.com" + path
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"EasyWAR-Control-Center/{VERSION}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token

    req = urllib.request.Request(url, headers=headers)

    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, hdrs, newurl):
            parsed = urllib.parse.urlsplit(newurl)
            if parsed.scheme != "https":
                raise urllib.error.HTTPError(newurl, code, "Відхилено не-HTTPS перенаправлення", hdrs, fp)
            redirected = super().redirect_request(request, fp, code, message, hdrs, newurl)
            if urllib.parse.urlsplit(request.full_url).netloc != parsed.netloc:
                redirected.remove_header("Authorization")
            return redirected

    with urllib.request.build_opener(SafeRedirect()).open(req, timeout=18) as response:
        rate = {
            "remaining": _safe_int(response.headers.get("X-RateLimit-Remaining")),
            "limit": _safe_int(response.headers.get("X-RateLimit-Limit")),
            "resetAt": _epoch_to_iso(response.headers.get("X-RateLimit-Reset")),
        }
        body = response.read(MAX_ARTIFACT_BYTES + 1 if binary else 4 * 1024 * 1024)
        if binary and len(body) > MAX_ARTIFACT_BYTES:
            raise ValueError("Розмір артефакту перевищує дозволений ліміт")
        return (body if binary else json.loads(body)), rate


def _safe_int(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _epoch_to_iso(value):
    ts = _safe_int(value)
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def safe_repo(repo: str) -> str:
    if repo not in REPOS:
        raise ValueError("Недозволений репозиторій")
    return urllib.parse.quote(repo, safe="")


def paginated(path: str, *, token: str = "", limit: int = 2, per_page: int = 100):
    rows = []
    last_rate = {}
    for page in range(1, limit + 1):
        suffix = "&" if "?" in path else "?"
        batch, last_rate = github_request(f"{path}{suffix}per_page={per_page}&page={page}", token=token)
        rows.extend(batch)
        if len(batch) < per_page:
            return rows, False, last_rate
    return rows, True, last_rate


def workflow_summary(runs: list[dict], sha: str) -> list[dict]:
    matching = [run for run in runs if run.get("head_sha") == sha]
    latest = {}
    for run in sorted(matching, key=lambda item: item.get("created_at", ""), reverse=True):
        latest.setdefault(run.get("workflow_id", run.get("name")), run)
    return [
        {
            "id": run.get("id"),
            "name": run.get("name", ""),
            "status": run.get("status", ""),
            "conclusion": run.get("conclusion"),
            "url": run.get("html_url", ""),
            "updatedAt": run.get("updated_at", ""),
            "sha": sha,
        }
        for run in latest.values()
    ]


def extract_screens(repo: str, artifact: dict, *, token: str) -> list[dict]:
    """Імпортує лише перевірені зображення з артефактів easywar-screens-*."""
    name = artifact.get("name", "")
    sha = (artifact.get("workflow_run") or {}).get("head_sha", "")
    if not name.startswith(ARTIFACT_PREFIX) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        return []
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int:
        return []
    destination = PUBLIC / "live-screens" / repo / sha / str(artifact_id)
    manifest = destination / "manifest.json"
    if manifest.exists():
        return json.loads(manifest.read_text(encoding="utf-8"))
    raw, _ = github_request(
        f"/repos/{OWNER}/{safe_repo(repo)}/actions/artifacts/{artifact_id}/zip",
        token=token,
        binary=True,
    )
    found = []
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        images = [
            item
            for item in archive.infolist()
            if not item.is_dir() and Path(item.filename).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        ]
        if len(images) > 60 or sum(item.file_size for item in images) > MAX_ARTIFACT_BYTES:
            raise ValueError("Артефакт містить забагато або надто великі зображення")
        for index, item in enumerate(images):
            suffix = Path(item.filename).suffix.lower()
            filename = f"{index:02d}{suffix}"
            data = archive.read(item)
            valid = (
                (suffix == ".png" and data.startswith(b"\x89PNG\r\n\x1a\n"))
                or (suffix in (".jpg", ".jpeg") and data.startswith(b"\xff\xd8\xff"))
                or (suffix == ".webp" and data.startswith(b"RIFF") and data[8:12] == b"WEBP")
            )
            if not valid:
                continue
            (destination / filename).write_bytes(data)
            found.append(
                {
                    "title": Path(item.filename).stem[:100],
                    "repo": repo,
                    "sha": sha,
                    "platform": name[len(ARTIFACT_PREFIX) :][:40] or "невідомо",
                    "createdAt": artifact.get("created_at", ""),
                    "src": f"/live-screens/{repo}/{sha}/{artifact_id}/{filename}",
                }
            )
    manifest.write_text(json.dumps(found, ensure_ascii=False), encoding="utf-8")
    return found


def fetch_snapshot() -> dict:
    token = _resolve_github_token()
    repos_meta = []
    branches = []
    pulls = []
    commits = []
    all_runs = []
    releases = []
    screens = []
    warnings = []
    rate_info = {"remaining": None, "limit": None, "resetAt": None, "authenticated": bool(token)}

    # Перевірка валідності токена: якщо токен повернув 401 на першому запиті — повторити анонімно для публічних репо
    first_repo = REPOS[0]
    try:
        _, rate_info_probe = github_request(f"/repos/{OWNER}/{safe_repo(first_repo)}", token=token)
        rate_info.update(rate_info_probe)
    except urllib.error.HTTPError as err:
        if err.code == 401 and token:
            token = ""
            rate_info["authenticated"] = False
            warnings.append("Локальний токен GitHub відхилено (401); використано публічний режим читання.")
        else:
            raise

    max_branch_pages = 3 if token else 1
    max_pr_pages = 2 if token else 1

    for repo in REPOS:
        encoded = safe_repo(repo)
        try:
            metadata, rate = github_request(f"/repos/{OWNER}/{encoded}", token=token)
            rate_info.update({k: v for k, v in rate.items() if v is not None})
        except urllib.error.HTTPError as err:
            warnings.append(f"{repo}: {translate_network_error(err)}")
            continue

        default_branch = metadata.get("default_branch", "main")
        repos_meta.append(
            {
                "repo": repo,
                "defaultBranch": default_branch,
                "private": bool(metadata.get("private")),
                "url": metadata.get("html_url", f"https://github.com/{OWNER}/{repo}"),
                "pushedAt": metadata.get("pushed_at"),
                "openIssues": metadata.get("open_issues_count", 0),
                "description": metadata.get("description") or "",
            }
        )

        branch_rows, _, rate = paginated(
            f"/repos/{OWNER}/{encoded}/branches", token=token, limit=max_branch_pages, per_page=100
        )
        rate_info.update({k: v for k, v in rate.items() if v is not None})

        pr_rows, _, rate = paginated(
            f"/repos/{OWNER}/{encoded}/pulls?state=all&sort=updated&direction=desc",
            token=token,
            limit=max_pr_pages,
            per_page=50,
        )
        rate_info.update({k: v for k, v in rate.items() if v is not None})

        runs = []
        try:
            runs_resp, rate = github_request(f"/repos/{OWNER}/{encoded}/actions/runs?per_page=30", token=token)
            rate_info.update({k: v for k, v in rate.items() if v is not None})
            runs = runs_resp.get("workflow_runs", [])
        except (urllib.error.URLError, KeyError, ValueError):
            warnings.append(f"{repo}: запуски GitHub Actions тимчасово недоступні.")

        for run in runs[:20]:
            all_runs.append(
                {
                    "id": run.get("id"),
                    "repo": repo,
                    "name": run.get("name", ""),
                    "displayTitle": run.get("display_title") or run.get("name", ""),
                    "branch": run.get("head_branch") or "",
                    "sha": run.get("head_sha") or "",
                    "event": run.get("event") or "",
                    "status": run.get("status") or "",
                    "conclusion": run.get("conclusion"),
                    "url": run.get("html_url") or "",
                    "createdAt": run.get("created_at") or "",
                    "updatedAt": run.get("updated_at") or "",
                }
            )

        for branch in branch_rows:
            branches.append(
                {
                    "repo": repo,
                    "branch": branch["name"],
                    "sha": branch["commit"]["sha"],
                    "default": branch["name"] == default_branch,
                    "protected": bool(branch.get("protected")),
                }
            )

        open_detail_budget = 8 if token else 4
        for pr in pr_rows:
            additions = None
            deletions = None
            changed_files = None
            if pr.get("state") == "open" and open_detail_budget > 0:
                open_detail_budget -= 1
                try:
                    detail, rate = github_request(f"/repos/{OWNER}/{encoded}/pulls/{pr['number']}", token=token)
                    rate_info.update({k: v for k, v in rate.items() if v is not None})
                    additions = detail.get("additions")
                    deletions = detail.get("deletions")
                    changed_files = detail.get("changed_files")
                except (urllib.error.URLError, KeyError, ValueError):
                    pass

            pulls.append(
                {
                    "repo": repo,
                    "number": pr["number"],
                    "title": pr["title"],
                    "draft": bool(pr.get("draft")),
                    "state": pr["state"],
                    "merged": bool(pr.get("merged_at")),
                    "mergedAt": pr.get("merged_at"),
                    "author": (pr.get("user") or {}).get("login", ""),
                    "head": pr["head"]["ref"],
                    "sha": pr["head"]["sha"],
                    "base": pr["base"]["ref"],
                    "baseSha": pr["base"]["sha"],
                    "url": pr["html_url"],
                    "createdAt": pr.get("created_at"),
                    "updatedAt": pr.get("updated_at"),
                    "additions": additions,
                    "deletions": deletions,
                    "changedFiles": changed_files,
                    "labels": [label.get("name", "") for label in pr.get("labels") or [] if label.get("name")],
                    "checks": workflow_summary(runs, pr["head"]["sha"]),
                }
            )

        try:
            commit_rows, rate = github_request(
                f"/repos/{OWNER}/{encoded}/commits?sha={urllib.parse.quote(default_branch, safe='')}&per_page=15",
                token=token,
            )
            rate_info.update({k: v for k, v in rate.items() if v is not None})
            for item in commit_rows:
                commit_obj = item.get("commit") or {}
                author_obj = commit_obj.get("author") or {}
                raw_msg = (commit_obj.get("message") or "").splitlines()
                commits.append(
                    {
                        "repo": repo,
                        "branch": default_branch,
                        "sha": item.get("sha", ""),
                        "message": (raw_msg[0] if raw_msg else "")[:180],
                        "author": (item.get("author") or {}).get("login") or author_obj.get("name") or "",
                        "date": author_obj.get("date") or "",
                        "url": item.get("html_url") or "",
                    }
                )
        except (urllib.error.URLError, KeyError, ValueError):
            warnings.append(f"{repo}: останні коміти тимчасово недоступні.")

        try:
            release_rows, rate = github_request(f"/repos/{OWNER}/{encoded}/releases?per_page=10", token=token)
            rate_info.update({k: v for k, v in rate.items() if v is not None})
            for rel in release_rows:
                releases.append(
                    {
                        "repo": repo,
                        "tag": rel.get("tag_name") or "",
                        "name": rel.get("name") or rel.get("tag_name") or "",
                        "draft": bool(rel.get("draft")),
                        "prerelease": bool(rel.get("prerelease")),
                        "publishedAt": rel.get("published_at") or rel.get("created_at") or "",
                        "url": rel.get("html_url") or "",
                        "assets": [
                            {
                                "name": asset.get("name", ""),
                                "size": asset.get("size", 0),
                                "downloads": asset.get("download_count", 0),
                            }
                            for asset in (rel.get("assets") or [])[:12]
                        ],
                    }
                )
        except (urllib.error.URLError, KeyError, ValueError):
            warnings.append(f"{repo}: список релізів тимчасово недоступний.")

        if token:
            try:
                artifacts_resp, rate = github_request(
                    f"/repos/{OWNER}/{encoded}/actions/artifacts?per_page=60", token=token
                )
                rate_info.update({k: v for k, v in rate.items() if v is not None})
                artifacts = artifacts_resp.get("artifacts", [])
                matching = [
                    item
                    for item in artifacts
                    if item.get("name", "").startswith(ARTIFACT_PREFIX) and not item.get("expired")
                ]
                for item in matching[:3]:
                    screens.extend(extract_screens(repo, item, token=token))
            except (urllib.error.HTTPError, ValueError, zipfile.BadZipFile, KeyError) as err:
                warnings.append(f"{repo}: знімки Actions недоступні ({translate_network_error(err)})")

    all_runs.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
    commits.sort(key=lambda item: item.get("date", ""), reverse=True)
    releases.sort(key=lambda item: item.get("publishedAt", ""), reverse=True)

    return {
        "refreshedAt": utc_now(),
        "owner": OWNER,
        "configuredRepos": list(REPOS),
        "repos": repos_meta,
        "branches": branches,
        "pulls": pulls,
        "commits": commits,
        "runs": all_runs,
        "releases": releases,
        "screens": screens,
        "warnings": warnings,
        "rateLimit": rate_info,
        "stale": False,
    }


def live_snapshot(force: bool = False) -> tuple[dict, bool]:
    """Повертає (snapshot, cooldown_hit)."""
    global last_attempt, last_force_attempt, last_result
    with LOCK:
        now = time.time()
        previous = cached_snapshot()
        if force:
            if last_result and now - last_force_attempt < FORCE_COOLDOWN_SECONDS:
                return last_result, True
            last_force_attempt = now
        else:
            if last_result and now - last_attempt < REFRESH_SECONDS:
                return last_result, False
        last_attempt = now
        try:
            value = fetch_snapshot()
            save_snapshot(value)
            last_result = value
            return value, False
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError) as err:
            reason = translate_network_error(err)
            if previous:
                last_result = {
                    **previous,
                    "stale": True,
                    "error": f"{reason} Показано останні збережені дані.",
                }
            else:
                last_result = {
                    "refreshedAt": None,
                    "owner": OWNER,
                    "configuredRepos": list(REPOS),
                    "repos": [],
                    "branches": [],
                    "pulls": [],
                    "commits": [],
                    "runs": [],
                    "releases": [],
                    "screens": [],
                    "warnings": [],
                    "rateLimit": {"remaining": None, "limit": None, "resetAt": None, "authenticated": False},
                    "stale": True,
                    "error": reason,
                }
            return last_result, False


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        if os.environ.get("EASYWAR_QUIET_LOGS") == "1":
            return
        super().log_message(format, *args)

    def send_json(self, status: int, value: dict, *, extra_headers: dict | None = None) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _verify_csrf(self) -> None:
        if not hmac.compare_digest(self.headers.get("X-EasyWAR-CSRF", ""), CSRF_TOKEN):
            raise ValueError("Недійсний CSRF-токен")

    def request_json(self):
        self._verify_csrf()
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_type != "application/json" or not (0 < content_length <= MAX_JSON_BODY_BYTES):
            raise ValueError("Недійсний запит на запис")
        return json.loads(self.rfile.read(content_length))

    def do_GET(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if route == "/api/live":
            snapshot, _ = live_snapshot(force=False)
            self.send_json(200, snapshot)
            return
        if route == "/api/session":
            self.send_json(
                200,
                {
                    "csrfToken": CSRF_TOKEN,
                    "version": VERSION,
                    "readOnlyGithub": True,
                    "owner": OWNER,
                    "repos": list(REPOS),
                },
            )
            return
        if route == "/api/records":
            self.send_json(200, read_records())
            return
        if route == "/api/agent-tasks":
            self.send_json(200, {"tasks": read_tasks(), "executionEnabled": False})
            return
        if route == "/api/backup":
            rec = read_records()
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            self.send_json(
                200,
                {
                    "exportedAt": utc_now(),
                    "version": VERSION,
                    "revision": rec["revision"],
                    "records": rec["records"] or [],
                    "agentTasks": read_tasks(),
                },
                extra_headers={
                    "Content-Disposition": f'attachment; filename="easywar-control-backup-{stamp}.json"'
                },
            )
            return
        if route == "/health":
            self.send_json(
                200,
                {"service": "easywar-control", "version": VERSION, "status": "ok", "mode": "read-only"},
            )
            return

        rel_path = "index.html" if route == "/" else route.lstrip("/")
        requested = (PUBLIC / rel_path).resolve()
        public_root = PUBLIC.resolve()
        if not requested.is_relative_to(public_root) or not requested.is_file() or requested.name == "manifest.json":
            self.send_json(404, {"error": "Ресурс не знайдено."})
            return

        body = requested.read_bytes()
        mime_type = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        if requested.suffix == ".js":
            mime_type = "application/javascript; charset=utf-8"
        elif requested.suffix == ".css":
            mime_type = "text/css; charset=utf-8"
        elif requested.suffix == ".html":
            mime_type = "text/html; charset=utf-8"
        elif requested.suffix == ".svg":
            mime_type = "image/svg+xml"
        elif requested.suffix == ".ttf":
            mime_type = "font/ttf"

        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self) -> None:
        if urllib.parse.urlsplit(self.path).path != "/api/records":
            self.send_json(405, {"error": "Метод не підтримується."})
            return
        try:
            payload = self.request_json()
            if not isinstance(payload, dict):
                raise ValueError("Недійсне тіло запиту")
            result = write_records(payload.get("revision"), payload.get("records"))
        except (ValueError, TypeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Недійсний запит на збереження записів."})
            return
        if result is None:
            self.send_json(
                409,
                {"error": "Записи змінено з іншого пристрою. Оберіть дію для розв’язання конфлікту."},
            )
            return
        self.send_json(200, {"revision": result})

    def do_POST(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if route == "/api/live/refresh":
            try:
                self._verify_csrf()
            except ValueError:
                self.send_json(400, {"error": "Недійсний CSRF-токен для оновлення."})
                return
            snapshot, cooldown = live_snapshot(force=True)
            if cooldown:
                self.send_json(
                    200,
                    {
                        **snapshot,
                        "cooldown": True,
                        "cooldownNotice": f"Оновлення вже виконувалося щойно. Повторіть через {FORCE_COOLDOWN_SECONDS} с.",
                    },
                )
                return
            self.send_json(200, snapshot)
            return

        if route != "/api/agent-tasks":
            self.send_json(405, {"error": "Запис у GitHub та автоматичний запуск агентів вимкнено."})
            return
        try:
            task = create_task(self.request_json())
        except (ValueError, TypeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Перевірте поля доручення."})
            return
        self.send_json(201, task)

    def do_PATCH(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if not route.startswith("/api/agent-tasks/"):
            self.send_json(405, {"error": "Метод не підтримується."})
            return
        try:
            task = update_task(route.rsplit("/", 1)[-1], self.request_json())
        except (ValueError, TypeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Перевірте поля доручення."})
            return
        if task:
            self.send_json(200, task)
        else:
            self.send_json(404, {"error": "Доручення не знайдено."})

    def do_DELETE(self) -> None:
        route = urllib.parse.urlsplit(self.path).path
        if not route.startswith("/api/agent-tasks/"):
            self.send_json(405, {"error": "Метод не підтримується."})
            return
        try:
            self._verify_csrf()
        except ValueError:
            self.send_json(400, {"error": "Недійсний CSRF-токен."})
            return
        task_id = route.rsplit("/", 1)[-1]
        if delete_task(task_id):
            self.send_json(200, {"deleted": task_id})
        else:
            self.send_json(404, {"error": "Доручення не знайдено."})


def main() -> None:
    host = "127.0.0.1"
    port = int(os.environ.get("EASYWAR_CENTER_PORT", "8787"))
    print(f"Центр контролю EasyWAR v{VERSION}: http://{host}:{port} (GitHub лише читання)", flush=True)
    ReusableThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
