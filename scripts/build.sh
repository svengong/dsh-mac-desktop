#!/usr/bin/env bash
# Build the macOS app bundle into dist/. Run install.sh to copy it to
# /Applications afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
bash scripts/gen-icons.sh
# electron-builder pulls the Electron dist zip from GitHub releases by
# default, which this network resets (read ECONNRESET). Route both
# electron-builder downloads through the npmmirror CDN instead; the npm
# registry itself already resolves via the Tencent mirror in ~/.npmrc.
# Overridable: ELECTRON_MIRROR=... ./scripts/build.sh
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
# Unsigned local build: never pick up a keychain identity by accident.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir
echo
echo "Built: $(find dist -maxdepth 3 -name 'DeepSeek Harness.app' -print -quit)"
echo "Versioned DMG/ZIP (GitHub Release artifacts): npm run dist:dmg"
