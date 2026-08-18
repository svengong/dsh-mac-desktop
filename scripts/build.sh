#!/usr/bin/env bash
# Build the macOS app bundle into dist/. Run install.sh to copy it to
# /Applications afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
bash scripts/gen-icons.sh
# Unsigned local build: never pick up a keychain identity by accident.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir
echo
echo "Built: $(find dist -maxdepth 3 -name 'DeepSeek Harness.app' -print -quit)"
echo "Versioned DMG/ZIP (GitHub Release artifacts): npm run dist:dmg"
