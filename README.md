# Local CLI Agent

Local CLI Agent is a macOS localhost provider broker for local LLM tools such as Claude CLI, Codex CLI, Gemini CLI, and Ollama.

This repository contains:

- `sidecar/`: TypeScript/Node localhost API service.
- `apps/macos/`: native AppKit menu bar app skeleton that starts and manages the sidecar.
- `demo/web/`: generic browser demo client.
- `docs/`: API and release notes.

## Quick Start

```sh
npm run sidecar:dev
```

The sidecar listens on `http://localhost:17624` by default. Development mode enables the fake provider so the API can be exercised without a real provider installed.

Run tests:

```sh
npm test
```

Serve the web demo:

```sh
npm run demo:serve
```

Then open `http://localhost:17625`.

## Status

This is the first runnable v1 baseline. The sidecar implements the public API, admin API, pairing, credential hashing, CORS/origin checks, SQLite-backed storage, request logs, SSE, cancellation, fake/Ollama/CLI provider adapters, and tests for the core flows. The macOS app is a native Swift/AppKit skeleton ready to package the sidecar as a bundled resource.
