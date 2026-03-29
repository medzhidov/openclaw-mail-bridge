#!/bin/sh

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$PROJECT_DIR/launchd/com.openclaw.mail-bridge.plist.template"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.openclaw.mail-bridge.plist"
NODE_PATH="$(command -v node)"

if [ -z "$NODE_PATH" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" \
  -e "s#__NODE_PATH__#$NODE_PATH#g" \
  "$PLIST_TEMPLATE" > "$PLIST_TARGET"

launchctl unload "$PLIST_TARGET" >/dev/null 2>&1 || true
launchctl load "$PLIST_TARGET"

printf 'Installed %s\n' "$PLIST_TARGET"
