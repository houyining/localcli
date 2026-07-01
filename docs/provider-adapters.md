# Provider Adapter Notes

The sidecar implements the common adapter interface:

```text
detect()
getVersion()
getModels()
buildInput(messages)
spawn(input)
supportsNativeSessions
createNativeSession()
sendNativeSessionMessage(input, context, session)
parseOutput(stream)
cancel(requestId)
diagnostics()
```

## Implemented Baseline

- `fake`: development/test provider, enabled only through `--enable-fake-provider` or `LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER=1`.
- `ollama`: uses local HTTP APIs at `http://127.0.0.1:11434`.
- `claude`: whitelisted command adapter, `claude -p`, prompt sent through stdin, `shell: false`. Native sessions use `claude -p --session-id <uuid>`.
- `codex`: whitelisted command adapter, `codex exec --skip-git-repo-check`, prompt sent through stdin, `shell: false`. Native sessions bootstrap with `codex exec --json --skip-git-repo-check -` and resume with `codex exec resume <session-id> --json --skip-git-repo-check -`.
- `gemini`: whitelisted command adapter, `gemini -p`, prompt sent through stdin, `shell: false`.

## Execution Safety

CLI adapters must use static executable names and static argument arrays. Client input must never affect executable names, shell usage, working directories, or argv. Prompt text must use the configured input channel, currently stdin for CLI providers.

If a provider cannot be run through a safe non-interactive input channel, mark it unavailable with `secure_input_unsupported` instead of exposing it as ready.

## Native Session Contract

Only adapters with `supportsNativeSessions === true` may be selected for `mode: "native"` sessions. `mode: "auto"` uses native sessions for Claude and Codex, then falls back to local sessions for providers without native support.

Native session adapters must obey the same safety rules as one-shot CLI execution:

- Prompt and completion content must not enter argv, request logs, diagnostics, or persisted SQLite metadata.
- Client input must not affect executable, shell usage, provider command path, or non-whitelisted flags.
- `workingDirectory` may be used only after server-side origin checks and `realpath` validation.
- If the CLI cannot prove a stable native session mapping, return `native_session_unsupported` or `native_session_unavailable` instead of silently downgrading to local context.

Claude native sessions create a local UUID at session creation time and pass it through `--session-id`. Codex native sessions start in `pending` state and become `ready` only after a resumable session id is extracted from JSONL output. Codex streaming buffers text until that id is known; if extraction fails, the stream sends an error without flushing partial deltas.

## Required CLI Spikes Before Public Release

Run each installed CLI through:

- Non-interactive one-shot prompt through stdin or another reviewed safe input channel.
- Streaming stdout behavior.
- Failed login / not ready behavior.
- Timeout and SIGTERM cancellation.
- Large prompt handling.

If a CLI changes its non-interactive syntax, update only its adapter. Client input must never control executable names, paths, shell arguments, or working directories.
