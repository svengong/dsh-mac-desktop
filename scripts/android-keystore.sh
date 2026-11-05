#!/usr/bin/env bash
#
# One-time: create the Android signing keystore that EVERY release is signed
# with, and print the two values GitHub needs.
#
# Why this exists: an APK's identity is its signing certificate. Android only
# accepts an update in place when the new package's certificate matches the
# installed one; a different keypair fails with
#   INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match
# Release builds used to run `keytool -genkeypair` on every CI run, so every
# version got a fresh key and could never be installed over the previous one.
# Measured: v0.10.11, v0.10.13 and v0.10.14 each had a different SHA-256.
#
# Run ONCE, then keep the .jks somewhere safe (password manager). Losing it
# means losing the ability to update installed copies — they would have to be
# uninstalled first, losing their local settings.
#
# Usage:
#   scripts/android-keystore.sh            # create ./dsh-android-release.jks
#   scripts/android-keystore.sh --show     # just print the values for an existing file
set -euo pipefail

KEYSTORE="${ANDROID_KEYSTORE_PATH:-$PWD/dsh-android-release.jks}"
ALIAS="${ANDROID_KEY_ALIAS:-dsh-release}"
STOREPASS="${ANDROID_KEYSTORE_PASSWORD:-}"
DAYS=10000

show() {
  keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass "$STOREPASS" 2>/dev/null \
    | sed -n 's/^[[:space:]]*SHA256: //p' \
    | tr -d ':' | tr 'A-F' 'a-f'
}

if [ "${1:-}" = "--show" ]; then
  [ -f "$KEYSTORE" ] || { echo "no keystore at $KEYSTORE" >&2; exit 1; }
  [ -n "$STOREPASS" ] || { echo "set ANDROID_KEYSTORE_PASSWORD to read the keystore" >&2; exit 1; }
  echo "SHA-256: $(show)"
  exit 0
fi

if [ -f "$KEYSTORE" ]; then
  echo "refusing to overwrite $KEYSTORE — an existing key must never be replaced;" >&2
  echo "doing so would orphan every installed copy. Use --show to read it." >&2
  exit 1
fi

if [ -z "$STOREPASS" ]; then
  echo "set ANDROID_KEYSTORE_PASSWORD (a password you choose, stored in the secret too):" >&2
  echo "  ANDROID_KEYSTORE_PASSWORD='…' scripts/android-keystore.sh" >&2
  exit 1
fi

keytool -genkeypair \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -storepass "$STOREPASS" -keypass "$STOREPASS" \
  -keyalg RSA -keysize 2048 -validity "$DAYS" \
  -dname "CN=DeepSeek Harness, O=DeepSeek Harness, C=US"

echo
echo "Created $KEYSTORE"
echo "SHA-256: $(show)"
echo
echo "Now store it in GitHub (replace <owner>/<repo>, and keep the .jks file safe):"
echo
echo "  base64 < \"$KEYSTORE\" | tr -d '\\n' | gh secret set ANDROID_KEYSTORE_BASE64"
echo "  printf '%s' \"$STOREPASS\"   | gh secret set ANDROID_KEYSTORE_PASSWORD"
echo "  gh variable set ANDROID_SIGNING_SHA256 --body \"$(show)\""
echo
echo "The workflow refuses to build when ANDROID_KEYSTORE_BASE64 is missing, and"
echo "fails when the produced APK's certificate differs from ANDROID_SIGNING_SHA256."
