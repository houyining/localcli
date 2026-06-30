# Provider Adapter Notes

The sidecar implements the common adapter interface:

```text
detect()
getVersion()
getModels()
buildInput(messages)
spawn(input)
parseOutput(stream)
cancel(requestId)
```

## Implemented Baseline

- `fake`: development/test provider, enabled only through `--enable-fake-provider` or `LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER=1`.
- `ollama`: uses local HTTP APIs at `http://127.0.0.1:11434`.
- `claude`: whitelisted command adapter, `claude -p <prompt>`, `shell: false`.
- `codex`: whitelisted command adapter, `codex exec --skip-git-repo-check <prompt>`, `shell: false`.
- `gemini`: whitelisted command adapter, `gemini -p <prompt>`, `shell: false`.

## Required CLI Spikes Before Public Release

Run each installed CLI through:

- Non-interactive one-shot prompt.
- Streaming stdout behavior.
- Failed login / not ready behavior.
- Timeout and SIGTERM cancellation.
- Large prompt handling.

If a CLI changes its non-interactive syntax, update only its adapter. Client input must never control executable names, paths, shell arguments, or working directories.
