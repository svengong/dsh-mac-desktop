#!/usr/bin/env bash
# Re-generates build/icon.icns + PNGs from apps/web/public/favicon.svg.
#
# Requires Google Chrome or Microsoft Edge for the transparent SVG raster.
# The committed icons are checked in, so this only needs to run when the
# favicon changes.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(cd "$(dirname "$0")/../deepseek-harness" && pwd)"
SVG="$ROOT/apps/web/public/favicon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  if [ -x "$candidate" ]; then
    CHROME="$candidate"
    break
  fi
done
if [ -z "$CHROME" ]; then
  echo "error: Google Chrome or Microsoft Edge is required to rasterize the SVG icon" >&2
  exit 1
fi

cat > "$TMP/wrapper.html" <<EOF
<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head>
<body><img src="file://$SVG" style="width:1024px;height:1024px;display:block"></body></html>
EOF

cat > "$TMP/wrapper-pressed.html" <<EOF
<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head>
<body><img src="file://$SVG" style="width:1024px;height:1024px;display:block;opacity:0.55;transform:scale(0.94);transform-origin:center"></body></html>
EOF

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$TMP/icon-1024.png" "file://$TMP/wrapper.html" >/dev/null 2>&1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$TMP/icon-pressed-1024.png" "file://$TMP/wrapper-pressed.html" >/dev/null 2>&1

mkdir -p build "$TMP/icon.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$TMP/icon-1024.png" --out "$TMP/icon.iconset/icon_${size}x${size}.png" >/dev/null
done
for size in 32 64 256 512 1024; do
  half=$((size / 2))
  sips -z "$size" "$size" "$TMP/icon-1024.png" --out "$TMP/icon.iconset/icon_${half}x${half}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o build/icon.icns
sips -z 512 512 "$TMP/icon-1024.png" --out build/icon.png >/dev/null
sips -z 512 512 "$TMP/icon-pressed-1024.png" --out build/iconPressed.png >/dev/null
sips -z 16 16 "$TMP/icon-1024.png" --out build/trayTemplate.png >/dev/null
sips -z 32 32 "$TMP/icon-1024.png" --out build/trayTemplate@2x.png >/dev/null
echo "icons written to build/"
