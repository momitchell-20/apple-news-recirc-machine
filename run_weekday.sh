#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/output/weekday-runs/cron.log"
VENV="/Users/mmitchell/Desktop/coconut/.venv"
PYTHON="$VENV/bin/python3"

if [ ! -x "$PYTHON" ]; then
  echo "Missing virtualenv python at $PYTHON" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
source "$VENV/bin/activate"

mkdir -p "$SCRIPT_DIR/output/weekday-runs"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] cron: starting apple-news weekday run" >> "$LOG_FILE"

"$PYTHON" "$SCRIPT_DIR/run_weekday.py" >> "$LOG_FILE" 2>&1
