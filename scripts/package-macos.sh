#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/Local CLI Agent.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

swift build -c release --package-path "$ROOT_DIR/apps/macos"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR/sidecar"
mkdir -p "$RESOURCES_DIR/node/bin"

cp "$ROOT_DIR/apps/macos/.build/release/LocalCLIAgent" "$MACOS_DIR/LocalCLIAgent"
cp -R "$ROOT_DIR/sidecar/src" "$RESOURCES_DIR/sidecar/src"
NODE_BIN="$(node -p 'process.execPath')"
cp "$NODE_BIN" "$RESOURCES_DIR/node/bin/node"
chmod +x "$RESOURCES_DIR/node/bin/node"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>LocalCLIAgent</string>
  <key>CFBundleIdentifier</key>
  <string>dev.local-cli-agent.app</string>
  <key>CFBundleName</key>
  <string>Local CLI Agent</string>
  <key>CFBundleDisplayName</key>
  <string>Local CLI Agent</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "Created: $APP_DIR"
echo "Bundled Node: $NODE_BIN"
