import http.client
import importlib
import io
import json
import os
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        os.environ["EASYWAR_CENTER_STATE_DIR"] = str(Path(self.tmp_dir.name) / "state")
        os.environ["EASYWAR_QUIET_LOGS"] = "1"
        os.environ["EASYWAR_DISABLE_GH_CLI"] = "1"
        os.environ["EASYWAR_GITHUB_TOKEN"] = ""
        os.environ["EASYWAR_FORCE_COOLDOWN"] = "3"

        import server as srv

        self.srv = importlib.reload(srv)
        self.srv.last_attempt = 0.0
        self.srv.last_force_attempt = 0.0
        self.srv.last_result = None

        self.httpd = self.srv.ReusableThreadingHTTPServer(("127.0.0.1", 0), self.srv.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.tmp_dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = dict(headers or {})
        raw_body = None
        if body is not None:
            raw_body = json.dumps(body).encode("utf-8") if isinstance(body, (dict, list)) else body
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=raw_body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        resp_headers = dict(resp.getheaders())
        conn.close()
        return resp.status, resp_headers, data

    def get_csrf(self):
        status, _, data = self.request("GET", "/api/session")
        self.assertEqual(status, 200)
        payload = json.loads(data)
        self.assertTrue(payload["readOnlyGithub"])
        return payload["csrfToken"]

    def test_health_and_static_security(self):
        status, headers, data = self.request("GET", "/health")
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["mode"], "read-only")

        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Content-Security-Policy", headers)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

        status, _, data = self.request("GET", "/../server.py")
        self.assertEqual(status, 404)
        self.assertIn("Ресурс не знайдено", json.loads(data)["error"])

        status, _, _ = self.request("GET", "/live-screens/EasyWAR/abc/1/manifest.json")
        self.assertEqual(status, 404)

    def test_records_csrf_optimistic_concurrency_and_bool_rejection(self):
        csrf = self.get_csrf()

        # Відхилення без CSRF
        status, _, _ = self.request("PUT", "/api/records", {"revision": 0, "records": []})
        self.assertEqual(status, 400)

        # Відхилення boolean як ревізії (виправлення бага Python isinstance(True, int))
        status, _, _ = self.request(
            "PUT",
            "/api/records",
            {"revision": False, "records": []},
            headers={"X-EasyWAR-CSRF": csrf},
        )
        self.assertEqual(status, 400)

        # Валідний запис
        sample = [
            {"id": "task-1", "kind": "task", "title": "Синтетичне завдання", "status": "У роботі"},
        ]
        status, _, data = self.request(
            "PUT",
            "/api/records",
            {"revision": 0, "records": sample},
            headers={"X-EasyWAR-CSRF": csrf},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["revision"], 1)

        # Повторний запис зі старою ревізією -> 409 Conflict
        status, _, data = self.request(
            "PUT",
            "/api/records",
            {"revision": 0, "records": sample},
            headers={"X-EasyWAR-CSRF": csrf},
        )
        self.assertEqual(status, 409)
        self.assertIn("Записи змінено", json.loads(data)["error"])

        # Читання назад
        status, _, data = self.request("GET", "/api/records")
        self.assertEqual(status, 200)
        parsed = json.loads(data)
        self.assertEqual(parsed["revision"], 1)
        self.assertEqual(parsed["records"][0]["id"], "task-1")

    def test_agent_tasks_full_crud_and_delete(self):
        csrf = self.get_csrf()
        hdrs = {"X-EasyWAR-CSRF": csrf}

        # Create
        status, _, data = self.request(
            "POST",
            "/api/agent-tasks",
            {
                "title": "Перевірити синтетичний PR",
                "instruction": "Провести рев’ю змін і перевірити тести.",
                "role": "J5",
                "repo": "EasyWAR",
                "prRef": "#999",
                "sha": "abcdef1",
            },
            headers=hdrs,
        )
        self.assertEqual(status, 201)
        created = json.loads(data)
        task_id = created["id"]
        self.assertEqual(created["prRef"], "#999")
        self.assertEqual(created["sha"], "abcdef1")

        # Update
        status, _, data = self.request(
            "PATCH",
            f"/api/agent-tasks/{task_id}",
            {
                "title": "Оновлена назва",
                "instruction": "Оновлена інструкція.",
                "role": "J3",
                "repo": "EasyWAR",
                "status": "На перевірці",
                "result": "Тести пройшли успішно.",
            },
            headers=hdrs,
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["status"], "На перевірці")

        # Backup endpoint includes tasks and records
        status, headers, data = self.request("GET", "/api/backup")
        self.assertEqual(status, 200)
        self.assertIn("attachment; filename=", headers.get("Content-Disposition", ""))
        backup = json.loads(data)
        self.assertEqual(len(backup["agentTasks"]), 1)

        # Delete
        status, _, data = self.request("DELETE", f"/api/agent-tasks/{task_id}", headers=hdrs)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["deleted"], task_id)

        # Delete again -> 404
        status, _, _ = self.request("DELETE", f"/api/agent-tasks/{task_id}", headers=hdrs)
        self.assertEqual(status, 404)

    def test_unsupported_post_returns_ukrainian_405(self):
        csrf = self.get_csrf()
        status, _, data = self.request("POST", "/api/github/merge", {}, headers={"X-EasyWAR-CSRF": csrf})
        self.assertEqual(status, 405)
        self.assertIn("вимкнено", json.loads(data)["error"])

    def test_live_refresh_and_snapshot_mapping(self):
        csrf = self.get_csrf()
        synthetic_snapshot = {
            "refreshedAt": "2026-11-21T06:00:00+00:00",
            "owner": "hellwikcoop-arch",
            "configuredRepos": ["EasyWAR"],
            "repos": [{"repo": "EasyWAR", "defaultBranch": "main", "private": False}],
            "branches": [{"repo": "EasyWAR", "branch": "main", "sha": "a" * 40, "default": True, "protected": True}],
            "pulls": [
                {
                    "repo": "EasyWAR",
                    "number": 101,
                    "title": "Синтетичний PR",
                    "draft": False,
                    "state": "open",
                    "merged": False,
                    "head": "feat/demo",
                    "sha": "b" * 40,
                    "base": "main",
                    "baseSha": "a" * 40,
                    "url": "https://github.com/hellwikcoop-arch/EasyWAR/pull/101",
                    "updatedAt": "2026-11-21T05:50:00Z",
                    "additions": 42,
                    "deletions": 7,
                    "changedFiles": 3,
                    "checks": [],
                }
            ],
            "commits": [],
            "runs": [],
            "releases": [],
            "screens": [],
            "warnings": [],
            "rateLimit": {"remaining": 55, "limit": 60, "resetAt": None, "authenticated": False},
            "stale": False,
        }

        with mock.patch.object(self.srv, "fetch_snapshot", return_value=synthetic_snapshot) as mocked:
            status, _, data = self.request("POST", "/api/live/refresh", headers={"X-EasyWAR-CSRF": csrf})
            self.assertEqual(status, 200)
            payload = json.loads(data)
            self.assertEqual(payload["pulls"][0]["number"], 101)
            self.assertEqual(mocked.call_count, 1)

            # Повторне натискання протягом cooldown не робить зайвого запиту в GitHub
            status, _, data = self.request("POST", "/api/live/refresh", headers={"X-EasyWAR-CSRF": csrf})
            self.assertEqual(status, 200)
            payload = json.loads(data)
            self.assertTrue(payload.get("cooldown"))
            self.assertEqual(mocked.call_count, 1)

    def test_extract_screens_validates_magic_bytes(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("valid.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
            zf.writestr("fake.png", b"NOT_A_PNG_PAYLOAD")
        raw_zip = buf.getvalue()

        artifact = {
            "id": 777,
            "name": "easywar-screens-mac",
            "created_at": "2026-11-21T05:00:00Z",
            "workflow_run": {"head_sha": "a" * 40},
        }
        tmp_public = Path(self.tmp_dir.name) / "public"
        tmp_public.mkdir()
        with mock.patch.object(self.srv, "PUBLIC", tmp_public), mock.patch.object(
            self.srv, "github_request", return_value=(raw_zip, {})
        ):
            found = self.srv.extract_screens("EasyWAR", artifact, token="synthetic")
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]["platform"], "mac")
            self.assertTrue((tmp_public / "live-screens/EasyWAR" / ("a" * 40) / "777/00.png").exists())


if __name__ == "__main__":
    unittest.main()
