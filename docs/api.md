# Local CLI Agent API

Default base URL:

```text
http://localhost:17624
```

Only loopback access is supported in v1.

## Public Health

```http
GET /health
```

No pairing required.

```json
{
  "ok": true,
  "service": "local-cli-agent",
  "version": "0.1.0",
  "host": "localhost",
  "port": 17624,
  "pairingRequired": true
}
```

## Pairing

```http
POST /v1/pair/request
Content-Type: application/json
```

```json
{
  "clientName": "Example Client",
  "clientType": "web-app",
  "origin": "https://example.com",
  "requestedCapabilities": ["llm.chat", "llm.stream", "llm.listProviders"],
  "requestedProviders": ["claude", "codex", "ollama"],
  "clientNonce": "high_entropy_random_nonce"
}
```

The sidecar returns a pending `requestId`. The macOS app must approve or deny it through the admin API.

```http
GET /v1/pair/status?requestId=pair_req_xxx&clientNonce=nonce
```

Allowed status returns `clientId` and `credential` exactly once. The Agent stores only a `scrypt` hash of the credential.

## Authenticated Client Headers

All sensitive v1 routes require:

```http
X-Local-Agent-Client-Id: client_xxx
Authorization: Bearer internal_secret_xxx
```

Browser requests with an `Origin` header must match the stored pairing origin.

## Providers

```http
GET /v1/providers
```

Requires `llm.listProviders`.

```json
{
  "providers": [
    { "id": "claude", "name": "Claude CLI", "installed": false, "ready": false, "message": "Not installed" },
    { "id": "ollama", "name": "Ollama", "installed": true, "ready": true, "models": ["llama3.2"] }
  ]
}
```

## Chat

```http
POST /v1/chat
Content-Type: application/json
```

Requires `llm.chat`. `stream: true` also requires `llm.stream`.

```json
{
  "provider": "ollama",
  "stream": true,
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello" }
  ]
}
```

By default `/v1/chat` is stateless. Pairing authenticates the caller; it does not implicitly attach conversation state.

Validation:

- `messages`: 1-50 items.
- `role`: `system`, `user`, or `assistant`.
- `content`: string only.
- Total content limit: 100000 characters.
- Provider defaults to the client's `defaultProvider`.
- Provider must be in the client's `allowedProviders`.
- `session` is optional. Omit it for one-shot stateless calls.

Non-streaming response:

```json
{
  "requestId": "req_xxx",
  "provider": "ollama",
  "content": "...",
  "finishReason": "stop"
}
```

Streaming response:

```text
Content-Type: text/event-stream

data: {"type":"start","requestId":"req_xxx","provider":"ollama"}

data: {"type":"delta","content":"..."}

data: {"type":"done","finishReason":"stop"}
```

Session convenience:

```json
{
  "provider": "codex",
  "stream": true,
  "session": { "create": true, "mode": "auto" },
  "messages": [
    { "role": "user", "content": "Start a new conversation." }
  ]
}
```

Continue the same conversation:

```json
{
  "stream": true,
  "session": { "id": "session_xxx" },
  "messages": [
    { "role": "user", "content": "Continue from the previous turn." }
  ]
}
```

Rules:

- `session.create: true` starts a new session and sends the current messages as the first turn.
- `session.id` continues an existing session owned by the same paired client.
- `session.create` and `session.id` are mutually exclusive.
- If `provider` is present with `session.id`, it must match the session provider.
- `session.mode` and `session.workingDirectory` are only valid with `session.create`.

Session-bound non-streaming `/v1/chat` responses add session metadata:

```json
{
  "requestId": "req_xxx",
  "sessionId": "session_xxx",
  "provider": "codex",
  "content": "...",
  "finishReason": "stop",
  "session": {
    "sessionId": "session_xxx",
    "mode": "native",
    "nativeSessionState": "ready",
    "messageCount": 2
  }
}
```

Session-bound streaming responses include session metadata in `start` and updated metadata in `done`:

```text
data: {"type":"start","requestId":"req_xxx","provider":"codex","sessionId":"session_xxx","session":{...}}

data: {"type":"delta","content":"..."}

data: {"type":"done","finishReason":"stop","sessionId":"session_xxx","session":{...}}
```

Cancel:

```http
POST /v1/requests/{requestId}/cancel
```

## Sessions

Sessions are localhost-only conversation handles scoped to the paired `clientId`. Another paired client cannot read, delete, or chat through a session it did not create.

Session mode controls where conversation continuity lives:

- `auto` (default): Claude and Codex use native CLI sessions; other providers use local sessions.
- `native`: requires provider support. The sidecar stores only metadata plus the provider native session mapping. Prompt, completion, bootstrap messages, raw stdout, and raw stderr are not written to SQLite, logs, diagnostics, or admin status.
- `local`: keeps recent message history in memory only. Message contents are not written to SQLite and are lost when the sidecar restarts; restored local session summaries reset `messageCount` to 0.

Create a session:

```http
POST /v1/sessions
Content-Type: application/json
```

```json
{
  "provider": "claude",
  "mode": "auto",
  "workingDirectory": "/Users/example/project",
  "messages": [
    { "role": "system", "content": "You are concise." }
  ]
}
```

`provider` defaults to the client's `defaultProvider`. `mode` defaults to `auto`.

For most clients, prefer the `/v1/chat` `session.create` convenience form above. Use `/v1/sessions` when you need to list, inspect, delete, pre-create, or explicitly manage session lifecycle.

`messages` is optional and may contain 0-50 initial messages for local sessions. Native sessions reject non-empty `messages`; send the first turn through `POST /v1/sessions/{sessionId}/chat`.

`workingDirectory` is optional and is only accepted for no-Origin local clients such as CLI/desktop clients. Browser-origin clients receive `403 working_directory_not_allowed`. The path must be absolute, exist, be a directory, and is saved after `realpath`.

Response:

```json
{
  "ok": true,
  "session": {
    "sessionId": "session_xxx",
    "clientId": "client_xxx",
    "provider": "claude",
    "mode": "native",
    "workingDirectory": "/Users/example/project",
    "nativeSessionState": "ready",
    "createdAt": "2026-06-30T12:00:00.000Z",
    "updatedAt": "2026-06-30T12:00:00.000Z",
    "expiresAt": "2026-06-30T12:30:00.000Z",
    "messageCount": 0
  }
}
```

Native provider session ids are never returned to regular clients.

Continue a session:

```http
POST /v1/sessions/{sessionId}/chat
Content-Type: application/json
```

```json
{
  "stream": false,
  "messages": [
    { "role": "user", "content": "Continue from the last turn." }
  ]
}
```

The provider and mode are fixed at session creation time. In native mode, each chat request sends only the current request messages to the provider CLI; continuity is handled by the provider native session. In local mode, on a successful `finishReason: "stop"` response, the request messages and assistant output are appended to the in-memory session. If a local session grows beyond 50 messages or 100000 characters, the oldest messages are trimmed before the provider call.

Only `finishReason: "stop"` updates `messageCount` or native session ready state. Cancelled and timed-out requests do not advance the session.

Non-streaming response:

```json
{
  "requestId": "req_xxx",
  "sessionId": "session_xxx",
  "provider": "ollama",
  "content": "...",
  "finishReason": "stop",
  "session": {
    "sessionId": "session_xxx",
    "messageCount": 3
  }
}
```

Streaming responses use the same session-bound SSE shape as `/v1/chat`: `start` includes `sessionId/session`, `delta` streams text, and `done` includes the updated `session`.

List sessions:

```http
GET /v1/sessions
```

Delete a session:

```http
DELETE /v1/sessions/{sessionId}
```

Limits:

- Default TTL: 30 minutes since last activity.
- Default active sessions per paired client: 20.
- One session can process only one chat request at a time. Concurrent writes return `429 session_busy`.
- `DELETE /v1/sessions/{sessionId}` returns `429 session_busy` while a request is active.
- Active sessions are not removed by TTL until the active request completes.
- Session summaries do not include message content.

Session-specific errors:

- `native_session_unsupported`: provider or current CLI version cannot safely support native sessions.
- `native_session_unavailable`: an existing native session mapping is missing or failed closed.
- `working_directory_not_allowed`: browser-origin pairing tried to set `workingDirectory`.
- `invalid_working_directory`: path is not absolute, does not exist, is not a directory, or `realpath` failed.

## OpenAI-Compatible API

The compatibility layer keeps the same pairing credentials. Sensitive routes still require:

```http
X-Local-Agent-Client-Id: client_xxx
Authorization: Bearer internal_secret_xxx
```

List models:

```http
GET /openai/v1/models
```

Model IDs use either `provider` or `provider:model`. CLI providers expose the provider id. Providers with model lists, such as Ollama and the fake provider, expose `provider:model`.

Chat completions:

```http
POST /openai/v1/chat/completions
Content-Type: application/json
```

```json
{
  "model": "fake:fake-echo",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

Streaming responses follow OpenAI-style SSE chunks and end with:

```text
data: [DONE]
```

`usage` exposes best-effort character counts (`prompt_chars`, `completion_chars`, `total_chars`) instead of token counts.

## Admin API

The macOS app starts the sidecar with a one-time admin token and sends:

```http
X-Local-Agent-Admin-Token: token
```

Implemented admin routes:

- `GET /admin/status`
- `GET /admin/settings`
- `PATCH /admin/settings`
- `GET /admin/providers`
- `GET /admin/diagnostics`
- `GET /admin/clients`
- `PATCH /admin/clients/{clientId}`
- `DELETE /admin/clients/{clientId}`
- `GET /admin/logs`
- `POST /admin/logs/clear`
- `GET /admin/events`
- `POST /admin/pairing/{requestId}/allow`
- `POST /admin/pairing/{requestId}/deny`

`PATCH /admin/settings` supports `port`, `logRetentionDays`, `logsEnabled`, and `startAtLogin`. The sidecar keeps `host` fixed to `localhost`; port changes are persisted and require service restart to take effect.

## Errors

Errors use:

```json
{
  "ok": false,
  "code": "not_paired",
  "message": "Client is not paired."
}
```

Request logs intentionally omit full prompts, model output, stdout/stderr, and credentials.

## Diagnostics Redaction

`GET /admin/diagnostics` returns an allowlisted local report for troubleshooting. It may include service status, uptime, redacted runtime paths, provider statuses, provider command paths, provider versions, and recent request error codes.

It must not include prompts, completions, credentials, credential hashes, admin tokens, raw stdout/stderr, full environment variables, or unredacted home-directory paths.
