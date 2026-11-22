#!/usr/bin/env bash
# Builds the app icons (Zeyd/icons/) from one square image.
# To change the icon: put the new image in brand/ (or pass its path), run this script, deploy.
#   bash tools/make-icons.sh [source-image]
# Default source: brand/app-icon-source.png, rendered from brand/app-icon.svg (full-bleed, so it is also
# used as the maskable icon). For a logo on a white background, set CROP="size:x:y" (the square around
# the logo, in source pixels) and MASK_PAD=<canvas size> so Android's round mask does not cut it.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-brand/app-icon-source.png}"
CROP="${CROP:-}"
MASK_PAD="${MASK_PAD:-}"
FFMPEG="${FFMPEG:-ffmpeg}"
OUT=Zeyd/icons
mkdir -p "$OUT"

icon() { # size output
    local filter="scale=$1:$1:flags=lanczos"
    [ -n "$CROP" ] && filter="crop=$CROP,$filter"
    "$FFMPEG" -v error -y -i "$SRC" -vf "$filter" -frames:v 1 "$OUT/$2"
}
icon 512 icon-512.png
icon 192 icon-192.png
icon 180 apple-touch-icon.png
icon 48 favicon-48.png
if [ -n "$MASK_PAD" ]; then
    "$FFMPEG" -v error -y -i "$SRC" \
        -vf "pad=$MASK_PAD:$MASK_PAD:(ow-iw)/2:(oh-ih)/2:white,scale=512:512:flags=lanczos" -frames:v 1 \
        "$OUT/icon-maskable-512.png"
else
    cp "$OUT/icon-512.png" "$OUT/icon-maskable-512.png"
fi
ls -l "$OUT"
