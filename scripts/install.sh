#!/usr/bin/env bash
# Install the built app bundle into /Applications (replaces any older copy).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$(find dist -maxdepth 3 -name 'DeepSeek Harness.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "error: no app bundle found; run scripts/build.sh first" >&2
  exit 1
fi
if [ -d "/Applications/DeepSeek Harness.app" ]; then
  rm -rf "/Applications/DeepSeek Harness.app"
fi
ditto "$APP" "/Applications/DeepSeek Harness.app"
echo "Installed: /Applications/DeepSeek Harness.app"
