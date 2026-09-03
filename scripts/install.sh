#!/usr/bin/env bash
# Build (when needed), install the .app into /Applications, and optionally
# preconfigure the installed app for one SSH device so the first launch is
# fully hands-off.
#
#   bash scripts/install.sh
#   bash scripts/install.sh --ssh <your-ssh-alias>
#
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST=""
REMOTE_REPO_URL="https://github.com/deepseek-ai/deepseek-harness.git"
REMOTE_REPO_DIR="~/deepseek-harness"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh) SSH_HOST="${2:?--ssh requires a host}"; shift 2 ;;
    --remote-repo-url) REMOTE_REPO_URL="${2:?--remote-repo-url requires a URL}"; shift 2 ;;
    --remote-dir) REMOTE_REPO_DIR="${2:?--remote-dir requires a path}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Only look ONE level below dist/: electron-builder emits dist/mac-arm64/ and
# dist/mac/. A deeper search also matches dist/.old/<timestamp>/… (stale builds
# parked there to work around the safe-delete guard), and directory order puts
# `.old` first — that silently installed a days-old bundle over a fresh build.
APP="$(find dist -mindepth 2 -maxdepth 2 -name 'DeepSeek Harness.app' -print -quit 2>/dev/null || true)"
if [ -z "$APP" ]; then
  echo "No app bundle found; running scripts/build.sh first..."
  bash scripts/build.sh
  APP="$(find dist -mindepth 2 -maxdepth 2 -name 'DeepSeek Harness.app' -print -quit)"
fi
if [ -z "$APP" ]; then
  echo "error: no 'DeepSeek Harness.app' under dist/<target>/ after build." >&2
  exit 1
fi
# Stale builds parked under dist/.old are a landmine: say which bundle is going
# in, and refuse to install one that is not freshly built.
APP_AGE_MIN=$(( ( $(date +%s) - $(stat -f %m "$APP") ) / 60 ))
echo "Installing: $APP (built ${APP_AGE_MIN} min ago)"
if [ "$APP_AGE_MIN" -gt 120 ]; then
  echo "error: refusing to install a bundle built ${APP_AGE_MIN} min ago." >&2
  echo "       Rebuild with 'npm run dist', or clear dist/.old if it is stale." >&2
  exit 1
fi

if [ -d "/Applications/DeepSeek Harness.app" ]; then
  rm -rf "/Applications/DeepSeek Harness.app"
fi
ditto "$APP" "/Applications/DeepSeek Harness.app"
echo "Installed: /Applications/DeepSeek Harness.app"

if [ -n "$SSH_HOST" ]; then
  SSH_HOST="$SSH_HOST" \
  REMOTE_REPO_URL="$REMOTE_REPO_URL" \
  REMOTE_REPO_DIR="$REMOTE_REPO_DIR" \
  node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { SettingsStore } = require('./src/settings')
const userData = path.join(os.homedir(), 'Library', 'Application Support', 'DeepSeek Harness')
fs.mkdirSync(userData, { recursive: true })
const settingsFile = path.join(userData, 'settings.json')
const store = new SettingsStore(settingsFile)
const saved = store.load()
const key = `ssh:${process.env.SSH_HOST}`
const previous = saved.devices[key] ?? {}
const device = {
  mode: 'ssh',
  local: previous.local ?? saved.local,
  ssh: {
    host: process.env.SSH_HOST,
    remoteRepoUrl: previous.ssh?.remoteRepoUrl || process.env.REMOTE_REPO_URL,
    remoteRepoDir: previous.ssh?.remoteRepoDir || process.env.REMOTE_REPO_DIR,
    remotePort: previous.ssh?.remotePort ?? 3080,
    localPort: previous.ssh?.localPort ?? 3080,
  },
  update: previous.update ?? saved.update,
}
store.save({
  activeDeviceId: key,
  devices: { ...saved.devices, [key]: device },
  toolPaths: saved.toolPaths,
})
const windowState = path.join(userData, 'window-state.json')
let restored = {
  version: 1,
  lastActiveDeviceKey: key,
  lastActiveWorkspaceId: null,
  windows: {},
}
try {
  const previous = JSON.parse(fs.readFileSync(windowState, 'utf8'))
  restored = { ...restored, ...previous, lastActiveDeviceKey: key }
} catch {
  // Fresh install: use the empty state above.
}
fs.writeFileSync(windowState, JSON.stringify(restored, null, 2))
console.log(`Configured installed app for ${key}`)
NODE
fi

echo "Done. Launch: open '/Applications/DeepSeek Harness.app'"
