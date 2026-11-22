#!/usr/bin/env bash
# Builds the app icons (Zeyd/icons/) from one square logo on a light background.
# To change the icon: replace brand/app-icon-source.jpg (or pass another file), run this script, deploy.
#   bash tools/make-icons.sh [source-image]
# Needs ffmpeg. CROP is the square area around the logo, as "size:x:y" in source pixels (default fits the
# current 736x736 logo); MASK_PAD is the white canvas the maskable icon is centred on (Android round icons).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-brand/app-icon-source.jpg}"
CROP="${CROP:-600:600:68:68}"
MASK_PAD="${MASK_PAD:-800}"
FFMPEG="${FFMPEG:-ffmpeg}"
OUT=Zeyd/icons
mkdir -p "$OUT"

icon() { # size crop output
    "$FFMPEG" -v error -y -i "$SRC" -vf "crop=$2,scale=$1:$1:flags=lanczos" -frames:v 1 "$OUT/$3"
}
icon 512 "$CROP" icon-512.png
icon 192 "$CROP" icon-192.png
icon 180 "$CROP" apple-touch-icon.png
icon 48 "$CROP" favicon-48.png
# Maskable: the whole logo inside the central safe circle, on white
"$FFMPEG" -v error -y -i "$SRC" \
    -vf "pad=$MASK_PAD:$MASK_PAD:(ow-iw)/2:(oh-ih)/2:white,scale=512:512:flags=lanczos" -frames:v 1 \
    "$OUT/icon-maskable-512.png"
ls -l "$OUT"
