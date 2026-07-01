# Local CLI Agent

Local CLI Agent is a localhost-only broker for local LLM tools. It lets browser apps, desktop apps, plugins, and local services call trusted local providers such as Claude Code, Codex CLI, Gemini CLI, and Ollama through one paired API.

The project is currently aimed at internal dogfood and local-first integrations. It is not a hosted gateway, not a remote tunneling service, and does not expose your local CLIs to the network.

## Features

- macOS menu bar supervisor that starts and monitors the sidecar service.
- Localhost HTTP API with pairing-based authentication.
- Provider discovery for Claude Code, Codex CLI, Gemini CLI, Ollama, and a fake test provider.
- Stateless `/v1/chat` for one-shot requests.
- Explicit session support for continuous conversations:
  - Claude/Codex use native CLI sessions when available.
  - Other providers fall back to lightweight local sessions.
  - Pairing never creates hidden session state by itself.
- OpenAI-compatible `/openai/v1/models` and `/openai/v1/chat/completions`.
- Server-Sent Events streaming and request cancellation.
- SQLite-backed pairing, settings, request logs, and session metadata.
- Redacted diagnostics for local debugging.
- Local web test console for exercising all public, paired-client, session, OpenAI-compatible, and admin APIs.

## Architecture

```text
client app / test console / local service
        |
        | localhost + pairing headers
        v
TypeScript sidecar API
        |
        | provider adapters
        v
Claude Code / Codex CLI / Gemini CLI / Ollama

macOS menu bar app
        |
        | supervises sidecar, status, diagnostics, logs
        v
Local CLI Agent.app
```

The sidecar binds to `127.0.0.1` by default. The macOS app supervises the sidecar and provides a native menu bar UI for status, providers, paired clients, logs, diagnostics, restart, and quit.

## Security Model

Local CLI Agent is designed around explicit local trust:

- Only loopback access is supported.
- Sensitive endpoints require a paired `clientId` and bearer credential.
- Browser requests must match the origin approved during pairing.
- Prompts are sent to CLI providers through stdin or provider-specific safe input channels, not shell-expanded argv.
- Prompt text, completions, raw stdout/stderr, credential material, and native provider session ids are not written to normal logs or diagnostics.
- `workingDirectory` is treated as a privileged capability and is only accepted for no-Origin local clients.
- Sessions are scoped to the paired client that created them.

## Requirements

- macOS for the menu bar app.
- Node.js 22.6 or newer for the sidecar development workflow.
- Swift toolchain for building the macOS app.
- Optional provider CLIs:
  - Claude Code CLI
  - Codex CLI
  - Gemini CLI
  - Ollama

## Quick Start

Install dependencies if needed, then start the sidecar in development mode:

```sh
npm run sidecar:dev
```

Development mode enables the fake provider so the API and test console can be exercised without a real LLM provider.

Start the web test console:

```sh
npm run console:serve
```

`npm run demo:serve` is kept as a compatibility alias.

Open:

```text
http://localhost:17625
```

The sidecar listens on:

```text
http://localhost:17624
```

## Pairing

Clients must pair before using sensitive APIs.

1. The client calls `POST /v1/pair/request`.
2. The macOS app shows the pending request.
3. The user approves the request.
4. The client polls `GET /v1/pair/status`.
5. The approved response returns `clientId` and `credential` exactly once.

Sensitive requests then use:

```http
X-Local-Agent-Client-Id: client_xxx
Authorization: Bearer internal_secret_xxx
```

## Chat API

One-shot stateless chat:

```json
POST /v1/chat
{
  "provider": "codex",
  "stream": false,
  "messages": [
    { "role": "user", "content": "Summarize this project." }
  ]
}
```

Start a new explicit session and send the first turn:

```json
POST /v1/chat
{
  "provider": "codex",
  "stream": true,
  "session": {
    "create": true,
    "mode": "auto"
  },
  "messages": [
    { "role": "user", "content": "Hi, remember that I am testing native sessions." }
  ]
}
```

Continue that session:

```json
POST /v1/chat
{
  "stream": true,
  "session": {
    "id": "session_xxx"
  },
  "messages": [
    { "role": "user", "content": "What did I ask you to remember?" }
  ]
}
```

Important session rules:

- Omitting `session` keeps `/v1/chat` stateless.
- Pairing does not imply a session.
- `session.create: true` starts a new session.
- `session.id` continues an existing session owned by the same paired client.
- `session.create` and `session.id` are mutually exclusive.
- Use `DELETE /v1/sessions/{sessionId}` to explicitly end a session.

The older explicit lifecycle API remains available:

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/{sessionId}`
- `POST /v1/sessions/{sessionId}/chat`
- `DELETE /v1/sessions/{sessionId}`

## OpenAI-Compatible API

The OpenAI-compatible layer uses the same pairing headers:

```http
GET /openai/v1/models
POST /openai/v1/chat/completions
```

Model names use either `provider` or `provider:model`, for example:

```json
{
  "model": "fake:fake-echo",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

The OpenAI-compatible API is currently stateless. Use `/v1/chat` for native/local sessions.

## Development

Run sidecar tests:

```sh
npm test
```

Run Swift tests:

```sh
swift test --package-path apps/macos
```

Build the macOS app:

```sh
swift build --package-path apps/macos
```

Package the dogfood app:

```sh
./scripts/package-macos.sh
```

Create a release dry run:

```sh
npm run release:macos:dry-run
```

## Repository Layout

```text
sidecar/      TypeScript localhost API service
apps/macos/  Swift/AppKit menu bar supervisor
demo/web/    Static web test console
docs/        API, provider adapter, and release documentation
scripts/     Packaging and release scripts
```

## Documentation

- [API reference](docs/api.md)
- [Provider adapter notes](docs/provider-adapters.md)
- [Release notes](docs/release.md)

## Current Status

This repository is a v1 dogfood baseline. The core local broker, pairing, provider adapters, native Claude/Codex session bridge, OpenAI-compatible layer, diagnostics, menu bar supervisor, tests, and packaging scripts are present. Expect API details to continue tightening as real provider compatibility and dogfood feedback improve.

## Contributing

Keep changes small, local-first, and explicit about trust boundaries. Provider support should fail closed when safe non-interactive execution cannot be verified. Tests should cover both happy paths and failure modes that could leak prompts, credentials, raw provider output, or cross-client session state.
