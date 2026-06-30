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

Validation:

- `messages`: 1-50 items.
- `role`: `system`, `user`, or `assistant`.
- `content`: string only.
- Total content limit: 100000 characters.
- Provider defaults to the client's `defaultProvider`.
- Provider must be in the client's `allowedProviders`.

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

Cancel:

```http
POST /v1/requests/{requestId}/cancel
```

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
