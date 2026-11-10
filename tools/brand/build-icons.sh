#!/bin/bash
# Regenerate every shipped icon from tools/brand/icon.svg and icon-dark.svg.
#
# Needs only macOS built-ins (sips) and the Tauri CLI from node_modules: no
# Xcode, no actool. The result is a flat icon; the Liquid Glass pipeline in
# docs/icon/ (upstream's) needs full Xcode and is not used by this fork.
#
#   tools/brand/build-icons.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/oz-icons.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

# render <svg> <png>: 1024x1024 PNG with an alpha channel, or fail loudly.
render() {
  sips -s format png "$1" --out "$2" >/dev/null 2>&1 || true
  local w h a
  w="$(sips -g pixelWidth "$2" 2>/dev/null | awk '/pixelWidth/ {print $2}')"
  h="$(sips -g pixelHeight "$2" 2>/dev/null | awk '/pixelHeight/ {print $2}')"
  a="$(sips -g hasAlpha "$2" 2>/dev/null | awk '/hasAlpha/ {print $2}')"
  if [ "$w" != "1024" ] || [ "$h" != "1024" ] || [ "$a" != "yes" ]; then
    echo "error: could not rasterize $1 to a 1024x1024 PNG with alpha (got ${w:-?}x${h:-?}, alpha ${a:-?})." >&2
    echo "       Export it by hand to 1024x1024 PNG and re-run with: ICON_PNG=<light.png> ICON_DARK_PNG=<dark.png> $0" >&2
    exit 1
  fi
}

LIGHT="${ICON_PNG:-$OUT/light.png}"
DARK="${ICON_DARK_PNG:-$OUT/dark.png}"
[ -n "${ICON_PNG:-}" ] || render "$HERE/icon.svg" "$LIGHT"
[ -n "${ICON_DARK_PNG:-}" ] || render "$HERE/icon-dark.svg" "$DARK"

# Every platform size (png, icns, ico, iOS, Android) from the light icon.
"$ROOT/node_modules/.bin/tauri" icon "$LIGHT" --output "$ROOT/src-tauri/icons" >/dev/null

# Browser tab / dev favicon.
cp "$ROOT/src-tauri/icons/32x32.png" "$ROOT/static/favicon.png"

# About modal, both appearances. 256 px is past any real display density for
# an 80 px image and keeps the two files out of the bundle-size budget.
sips -Z 256 "$LIGHT" --out "$ROOT/src/lib/assets/app-icon.png" >/dev/null
sips -Z 256 "$DARK" --out "$ROOT/src/lib/assets/app-icon-dark.png" >/dev/null

echo "Icons regenerated from $HERE/icon.svg"
