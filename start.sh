#!/usr/bin/env bash
# Starts Laudi on the Raspberry Pi and restarts him if he stops (unless he was stopped on purpose).
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is missing. Run ./install-laudi.sh"; read -r; exit 1; }
[ -f local-settings.txt ] || { echo "local-settings.txt is missing: copy it from your PC's tiktok-bot folder into $(pwd)"; read -r; exit 1; }
[ -d node_modules ] || npm install --omit=dev --legacy-peer-deps --no-audit --no-fund || exit 1
mkdir -p data
while true; do
  node src/tiktok.js
  if [ -f data/stop.flag ]; then rm -f data/stop.flag; echo "Laudi was stopped."; exit 0; fi
  echo "Laudi stopped. Restarting in 10 seconds... (close this window to quit)"
  sleep 10
done
