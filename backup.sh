#!/bin/bash
set -euo pipefail

default_db="$HOME/Library/Application Support/EasyWAR Control/state/center.sqlite3"
local_db="$(cd "$(dirname "$0")" && pwd)/state/center.sqlite3"
database="${EASYWAR_CENTER_DB:-$default_db}"

if [[ ! -f "$database" && -f "$local_db" ]]; then
  database="$local_db"
fi

if [[ ! -f "$database" ]]; then
  echo "Базу центру ще не знайдено: $database" >&2
  exit 1
fi

destination="${EASYWAR_BACKUP_DIR:-$HOME/Documents/EasyWAR-Control-Backups}"
mkdir -p "$destination"
chmod 700 "$destination"

file="$destination/center-$(date +%Y%m%d-%H%M%S).sqlite3"
python3 - "$database" "$file" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1])
backup = sqlite3.connect(sys.argv[2])
try:
    source.backup(backup)
finally:
    backup.close()
    source.close()
PY
chmod 600 "$file"
echo "Резервна копія створена: $file"
