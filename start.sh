#!/usr/bin/env bash
# Start the Tab Thrashing live server and open the dashboard (macOS / Linux).
cd "$(dirname "${BASH_SOURCE[0]}")"
URL="http://127.0.0.1:4870"
echo "Tab Thrashing: starting the live server on $URL (Ctrl+C to stop)"
( sleep 1; if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi ) &
exec node live/server.js
