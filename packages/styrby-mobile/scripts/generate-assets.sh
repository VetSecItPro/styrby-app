#!/usr/bin/env bash
# =============================================================================
# generate-assets.sh — Generate placeholder app icons for Styrby Mobile
# =============================================================================
#
# THESE ARE PLACEHOLDER ASSETS. Replace them with real branding assets from the
# design team before submitting to the App Store / Google Play.
#
# Prerequisites:
#   brew install imagemagick
#
# Usage:
#   ./scripts/generate-assets.sh
#
# Generated files (referenced by app.json):
#   assets/icon.png           — 1024x1024  App icon (iOS/Android)
#   assets/splash.png         — 1024x1024  Splash screen image
#   assets/adaptive-icon.png  — 1024x1024  Android adaptive icon foreground
#   assets/favicon.png        —   48x48    Web favicon
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"

# Styrby brand orange
BG_COLOR="#f97316"
TEXT_COLOR="white"

echo "Generating placeholder assets in $ASSETS_DIR ..."

# icon.png — 1024x1024 app icon
convert -size 1024x1024 xc:"$BG_COLOR" \
  -gravity center -fill "$TEXT_COLOR" -font Helvetica-Bold \
  -pointsize 600 -annotate +0+0 "S" \
  "$ASSETS_DIR/icon.png"
echo "  Created icon.png (1024x1024)"

# splash.png — 1024x1024 splash screen image (displayed at 200px width per app.json)
convert -size 1024x1024 xc:"$BG_COLOR" \
  -gravity center -fill "$TEXT_COLOR" -font Helvetica-Bold \
  -pointsize 600 -annotate +0+0 "S" \
  "$ASSETS_DIR/splash.png"
echo "  Created splash.png (1024x1024)"

# adaptive-icon.png — 1024x1024 Android adaptive icon foreground
convert -size 1024x1024 xc:"$BG_COLOR" \
  -gravity center -fill "$TEXT_COLOR" -font Helvetica-Bold \
  -pointsize 600 -annotate +0+0 "S" \
  "$ASSETS_DIR/adaptive-icon.png"
echo "  Created adaptive-icon.png (1024x1024)"

# favicon.png — 48x48 web favicon
convert -size 48x48 xc:"$BG_COLOR" \
  -gravity center -fill "$TEXT_COLOR" -font Helvetica-Bold \
  -pointsize 30 -annotate +0+0 "S" \
  "$ASSETS_DIR/favicon.png"
echo "  Created favicon.png (48x48)"

echo ""
echo "Done! All placeholder assets generated."
echo ""
echo "NOTE: These are solid-orange placeholders with a white 'S' letter."
echo "Replace them with real branding assets before publishing to app stores."
