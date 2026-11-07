#!/bin/sh
# Build the Chrome Web Store upload: dist/kendali-extension-<version>.zip
set -e
cd "$(dirname "$0")/.."
v=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist && rm -f "dist/kendali-extension-$v.zip"
(cd extension && zip -qr -X "../dist/kendali-extension-$v.zip" . -x '.*' -x '*/.*')
echo "dist/kendali-extension-$v.zip"
