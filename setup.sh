#!/usr/bin/env bash
# Tab Thrashing setup for macOS (also works on Linux).
#   ./setup.sh                    interactive setup, then start the server
# Options:
#   --autostart                   start the server automatically at login (no prompt)
#   --remove-autostart            undo --autostart and exit
#   --no-start                    set up only; do not start the server now
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$ROOT/extension"
SERVER="$ROOT/live/server.js"
URL="http://127.0.0.1:4870"
LABEL="com.tabthrashing.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OS="$(uname -s)"

AUTOSTART=0; NOSTART=0
for arg in "$@"; do
  case "$arg" in
    --autostart) AUTOSTART=1 ;;
    --no-start) NOSTART=1 ;;
    --remove-autostart)
      if [ -f "$PLIST" ]; then
        launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"; echo "Autostart removed."
      else
        echo "Autostart was not set up."
      fi
      exit 0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; cyan=$'\033[36m'; off=$'\033[0m'
ask() { # ask "question" default(y|n)
  local hint="[y/N]"; [ "$2" = y ] && hint="[Y/n]"
  local a=""; read -r -p "$1 $hint " a </dev/tty || true
  [ -z "$a" ] && a="$2"
  [[ "$a" =~ ^[yY] ]]
}

echo
echo "${cyan}${bold}Tab Thrashing setup${off}"
echo "${cyan}-------------------${off}"

# 1. Node.js 18+
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
major="$(node_major)"
if [ "$major" -lt 18 ]; then
  if [ "$major" -gt 0 ]; then echo "${yellow}Node.js $major is too old; version 18 or newer is needed.${off}"; else echo "${yellow}Node.js was not found.${off}"; fi
  if command -v brew >/dev/null 2>&1 && ask "Install Node.js with Homebrew now?" y; then
    brew install node
    major="$(node_major)"
  fi
  if [ "$major" -lt 18 ]; then
    echo "${red}Install Node.js 18 or newer from https://nodejs.org, then run setup again.${off}"
    exit 1
  fi
fi
echo "${green}[ok]${off} Node.js $(node --version)"

# 2. Data folder
mkdir -p "$ROOT/live/data"
echo "${green}[ok]${off} Events will be stored in $ROOT/live/data"

# 3. Browser extension (browsers do not let scripts install unpacked extensions, so this step is manual)
copied=""
if command -v pbcopy >/dev/null 2>&1; then printf %s "$EXT" | pbcopy && copied=" (copied to clipboard)"; fi
echo
echo "${cyan}Load the browser extension once:${off}"
echo "  1. Open chrome://extensions  (Edge: edge://extensions, Brave: brave://extensions)"
echo "  2. Turn on Developer mode"
echo "  3. Click \"Load unpacked\" and choose this folder$copied:"
echo "     ${bold}$EXT${off}"
if [ "$OS" = Darwin ] && ask "Open the extensions page now?" y; then
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null \
    || open -a "Microsoft Edge" "edge://extensions" 2>/dev/null \
    || open -a "Brave Browser" "brave://extensions" 2>/dev/null \
    || echo "${yellow}  Could not find Chrome, Edge or Brave. Open the extensions page yourself.${off}"
fi

# 4. Optional autostart (macOS LaunchAgent)
if [ "$OS" = Darwin ] && [ ! -f "$PLIST" ] && { [ "$AUTOSTART" = 1 ] || ask "Start the server automatically at login?" n; }; then
  mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v node)</string><string>$SERVER</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/tab-thrashing.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/tab-thrashing.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
  echo "${green}[ok]${off} Autostart added. Remove it with: ./setup.sh --remove-autostart"
fi

# 5. Start
open_url() { if command -v open >/dev/null 2>&1; then open "$1"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1; fi; }
if [ "$NOSTART" = 1 ]; then echo; echo "${cyan}Setup done. Start later with ./start.sh${off}"; exit 0; fi
echo
if curl -sf "$URL/api/health" >/dev/null 2>&1; then
  echo "${cyan}The server is already running. Opening $URL${off}"
  open_url "$URL"
else
  echo "${cyan}Starting the server on $URL  (Ctrl+C to stop)${off}"
  (sleep 1; open_url "$URL") &
  exec node "$SERVER"
fi
