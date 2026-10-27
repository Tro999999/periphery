#!/usr/bin/env bash
# Package extension/ into dist/periphery-<version>.zip (manifest.json at the zip root,
# ready for "Load unpacked" after extracting, or for Chrome Web Store upload).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
OUT="dist/periphery-${VERSION}.zip"
rm -f "$OUT"
(cd extension && zip -qr "../$OUT" . -x "*.DS_Store")
echo "Built $OUT"
