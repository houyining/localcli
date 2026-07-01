#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/Local CLI Agent.app"
DMG_PATH="$DIST_DIR/Local-CLI-Agent-0.1.0.dmg"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

"$ROOT_DIR/scripts/package-macos.sh"

if [[ -n "${LOCAL_CLI_AGENT_CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime \
    --sign "$LOCAL_CLI_AGENT_CODESIGN_IDENTITY" \
    "$APP_DIR"
elif [[ "$DRY_RUN" == "0" ]]; then
  echo "Set LOCAL_CLI_AGENT_CODESIGN_IDENTITY or pass --dry-run." >&2
  exit 1
else
  echo "Dry run: skipping codesign."
fi

rm -f "$DMG_PATH"
hdiutil create -volname "Local CLI Agent" \
  -srcfolder "$APP_DIR" \
  -ov -format UDZO "$DMG_PATH"

shasum -a 256 "$DMG_PATH" > "$DMG_PATH.sha256"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: skipping notarization."
else
  : "${APPLE_ID:?APPLE_ID is required}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait
  xcrun stapler staple "$DMG_PATH"
fi

echo "Created: $DMG_PATH"
echo "Checksum: $DMG_PATH.sha256"
