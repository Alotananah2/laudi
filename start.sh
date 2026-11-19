#!/usr/bin/env bash
# Manual start (normally systemd runs Laudi - see install.sh). Uses a virtual screen if there is none.
cd "$(dirname "$0")"
mkdir -p data
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ] && command -v xvfb-run >/dev/null; then
  exec xvfb-run -a -s "-screen 0 1366x900x24" node src/tiktok.js
fi
exec node src/tiktok.js
