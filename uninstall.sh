#!/bin/bash
set -euo pipefail

target_dir="$HOME/Library/Application Support/EasyWAR Control"
agent_file="$HOME/Library/LaunchAgents/local.easywar.control.plist"
purge="${1:-}"

if [[ "$(uname -s)" == "Darwin" && -f "$agent_file" ]]; then
  launchctl bootout "gui/$(id -u)" "$agent_file" 2>/dev/null || true
  rm -f "$agent_file"
  echo "Фоновий сервіс local.easywar.control зупинено та видалено."
fi

if [[ "$purge" == "--purge" ]]; then
  rm -rf "$target_dir"
  echo "Папку програми та локальну базу видалено: $target_dir"
else
  echo "Локальну базу збережено в: $target_dir/state/center.sqlite3"
  echo "Щоб видалити також базу даних, запустіть: bash uninstall.sh --purge"
fi
