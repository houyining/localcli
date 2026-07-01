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

Create a dogfood DMG dry run:

```sh
npm run release:macos:dry-run
```

The dry run packages the app, skips codesign/notarization, creates `dist/Local-CLI-Agent-0.1.0.dmg`, and writes a SHA-256 checksum next to it.

## Production Packaging Work

Current dogfood builds still run the bundled TypeScript sidecar with Node 22 type stripping. Before external distribution, replace that development resource with one of:

- Node SEA executable built from a JavaScript bundle.
- Bundled Node runtime plus compiled sidecar JavaScript.

The public API and Swift-side sidecar launch boundary are already isolated so this swap does not change clients.

## Signing and Notarization

After producing the final `.app`:

```sh
LOCAL_CLI_AGENT_CODESIGN_IDENTITY="Developer ID Application: TEAM NAME (TEAMID)" \
  scripts/release-macos.sh
```

Publish with:

- Version number
- SHA-256 checksum
- Install instructions
- Provider installation/login prerequisites
