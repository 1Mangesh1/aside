#!/bin/sh
# Starts aside in the background if it is not already running, then opens the page.
# Usage: aside [stop|log]
cd "$(dirname "$0")" || exit 1
URL=http://127.0.0.1:4318
LOG="$HOME/Library/Logs/aside.log"
pid() { lsof -tiTCP:4318 -sTCP:LISTEN 2>/dev/null; }

case "$1" in
  stop) if [ -n "$(pid)" ]; then kill $(pid) && echo "aside stopped"; else echo "aside is not running"; fi; exit 0 ;;
  log) tail -n 40 "$LOG"; exit 0 ;;
esac

if [ -z "$(pid)" ]; then
  [ -d node_modules ] || npm install --silent
  [ -x bin/aside-capture ] || npm run -s build:capture
  nohup node server.mjs >> "$LOG" 2>&1 &
  i=0
  while [ -z "$(pid)" ] && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  [ -n "$(pid)" ] || { echo "aside did not start. See: aside log"; exit 1; }
  echo "aside started (log: $LOG)"
fi
open "$URL"
