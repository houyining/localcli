# Release Notes and Packaging

V1 distribution target:

- macOS `.dmg`
- Drag into `/Applications`
- Manual first launch
- No auto-update
- No App Store release

## Current Build Commands

Run sidecar tests:

```sh
npm test
```

Build the macOS executable:

```sh
swift build -c release --package-path apps/macos
```

Create a development `.app` bundle:

```sh
./scripts/package-macos.sh
```

The script copies the Swift executable, sidecar TypeScript source, and current Node 22 executable into `dist/Local CLI Agent.app`. The app prefers `Contents/Resources/node/bin/node` when launching the sidecar.

## Production Packaging Work

Before external distribution, consider replacing the development TypeScript sidecar resource with one of:

- Node SEA executable built from a JavaScript bundle.
- Bundled Node runtime plus compiled sidecar JavaScript.

The public API and Swift-side sidecar launch boundary are already isolated so this swap does not change clients.

## Signing and Notarization

After producing the final `.app`:

```sh
codesign --force --deep --options runtime \
  --sign "Developer ID Application: TEAM NAME (TEAMID)" \
  "dist/Local CLI Agent.app"
```

Create the DMG:

```sh
hdiutil create -volname "Local CLI Agent" \
  -srcfolder "dist/Local CLI Agent.app" \
  -ov -format UDZO "dist/Local-CLI-Agent-0.1.0.dmg"
```

Notarize:

```sh
xcrun notarytool submit "dist/Local-CLI-Agent-0.1.0.dmg" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
```

Staple:

```sh
xcrun stapler staple "dist/Local-CLI-Agent-0.1.0.dmg"
```

Publish with:

- Version number
- SHA-256 checksum
- Install instructions
- Provider installation/login prerequisites
