import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseClaudeStreamJson, parseCodexJsonl, ProviderExecutionError } from "../src/providers.ts";

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

async function* lines(...items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

describe("native provider parsers", () => {
  it("parses Claude stream-json using whitelisted event shapes", async () => {
    const chunks = await collect(parseClaudeStreamJson(lines(
      JSON.stringify({ type: "system", subtype: "init" }) + "\n",
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hel" } }) + "\n",
      JSON.stringify({ type: "assistant_delta", delta: { text: "lo" } }) + "\n",
      JSON.stringify({ type: "unknown", message: "ignored" }) + "\n",
    )));

    assert.deepEqual(chunks, ["hel", "lo"]);
  });

  it("maps Claude auth errors and malformed JSON to safe provider errors", async () => {
    await assert.rejects(
      collect(parseClaudeStreamJson(lines(JSON.stringify({ type: "error", error: { message: "Please login first" } }) + "\n"))),
      (error: unknown) => error instanceof ProviderExecutionError && error.code === "provider_not_authenticated",
    );

    await assert.rejects(
      collect(parseClaudeStreamJson(lines("{not-json}\n"))),
      (error: unknown) => error instanceof ProviderExecutionError && error.code === "provider_error",
    );
  });

  it("buffers Codex bootstrap output until a native session id is captured", async () => {
    let captured: string | null = null;
    const chunks = await collect(parseCodexJsonl(lines(
      JSON.stringify({ type: "message.delta", delta: "hidden until session" }) + "\n",
      JSON.stringify({ type: "session.created", session_id: "codex-session-1" }) + "\n",
      JSON.stringify({ type: "message.delta", delta: " visible" }) + "\n",
    ), {
      requireSessionId: true,
      onSessionId: (sessionId) => {
        captured = sessionId;
      },
    }));

    assert.equal(captured, "codex-session-1");
    assert.deepEqual(chunks, ["hidden until session", " visible"]);
  });

  it("fails closed when Codex bootstrap never reports a native session id", async () => {
    await assert.rejects(
      collect(parseCodexJsonl(lines(
        JSON.stringify({ type: "message.delta", delta: "partial" }) + "\n",
      ), {
        requireSessionId: true,
        onSessionId: () => undefined,
      })),
      (error: unknown) => error instanceof ProviderExecutionError && error.code === "native_session_unsupported",
    );
  });

  it("parses Codex assistant messages and provider errors from whitelisted fields", async () => {
    const chunks = await collect(parseCodexJsonl(lines(
      JSON.stringify({ type: "item.completed", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }) + "\n",
      JSON.stringify({ type: "unknown", content: "ignored" }) + "\n",
    ), {
      requireSessionId: false,
      onSessionId: () => undefined,
    }));

    assert.deepEqual(chunks, ["done"]);

    await assert.rejects(
      collect(parseCodexJsonl(lines(JSON.stringify({ type: "error", message: "unauthorized" }) + "\n"), {
        requireSessionId: false,
        onSessionId: () => undefined,
      })),
      (error: unknown) => error instanceof ProviderExecutionError && error.code === "provider_not_authenticated",
    );
  });
});
