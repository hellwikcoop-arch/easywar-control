#!/bin/bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
target_dir="$HOME/Library/Application Support/EasyWAR Control"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/local.easywar.control.plist"
python_bin="$(command -v python3 || true)"

if [[ -z "$python_bin" ]]; then
  echo "Потрібен Python 3. Встановіть його й запустіть інсталятор знову." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Інсталятор LaunchAgent призначений для macOS." >&2
  echo "Для локального запуску на цій системі виконайте: python3 \"$source_dir/server.py\"" >&2
  exit 1
fi

mkdir -p "$target_dir/public" "$target_dir/state" "$agent_dir"
chmod 700 "$target_dir/state"

rm -rf "$target_dir/public/screens"
cp -R "$source_dir/public/." "$target_dir/public/"
cp "$source_dir/server.py" "$target_dir/server.py"
cp "$source_dir/backup.sh" "$target_dir/backup.sh"
cp "$source_dir/uninstall.sh" "$target_dir/uninstall.sh"
chmod +x "$target_dir/server.py" "$target_dir/backup.sh" "$target_dir/uninstall.sh"

EASYWAR_CENTER_PYTHON="$python_bin" EASYWAR_CENTER_TARGET="$target_dir" EASYWAR_CENTER_PLIST="$agent_file" \
  "$python_bin" - <<'PY'
import os
import plistlib
from pathlib import Path

target = Path(os.environ["EASYWAR_CENTER_TARGET"])
plist = {
    "Label": "local.easywar.control",
    "ProgramArguments": [os.environ["EASYWAR_CENTER_PYTHON"], str(target / "server.py")],
    "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": str(target / "server.log"),
    "StandardErrorPath": str(target / "server-error.log"),
}
Path(os.environ["EASYWAR_CENTER_PLIST"]).write_bytes(plistlib.dumps(plist))
PY

launchctl bootout "gui/$(id -u)" "$agent_file" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_file"
launchctl kickstart -k "gui/$(id -u)/local.easywar.control"

echo "Центр контролю EasyWAR запущено: http://127.0.0.1:8787"
echo "Перевірка стану: http://127.0.0.1:8787/health"
echo "Резервна копія бази: bash \"$target_dir/backup.sh\""
