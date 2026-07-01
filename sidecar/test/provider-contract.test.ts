import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultProviders } from "../src/providers.ts";
import { AgentServer } from "../src/server.ts";
import { SQLiteStore } from "../src/storage.ts";
import type { ProviderId } from "../src/types.ts";

const providerIds = (process.env.LOCAL_CLI_AGENT_CONTRACT_PROVIDERS ?? "")
  .split(",")
  .map((provider) => provider.trim())
  .filter(Boolean) as ProviderId[];

let server: AgentServer;
let baseUrl: string;
let dataDir: string;

async function jsonFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function pairClient(provider: ProviderId) {
  const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
  const request = await jsonFetch("/v1/pair/request", {
    method: "POST",
    body: JSON.stringify({
      clientName: `Contract ${provider}`,
      clientType: "cli-tool",
      requestedCapabilities: ["llm.chat", "llm.stream", "llm.listProviders"],
      requestedProviders: [provider],
      clientNonce: nonce,
    }),
  });
  assert.equal(request.status, 200);

  const allow = await jsonFetch(`/admin/pairing/${request.body.requestId}/allow`, {
    method: "POST",
    headers: { "X-Local-Agent-Admin-Token": "contract-admin" },
    body: JSON.stringify({
      allowedProviders: [provider],
      defaultProvider: provider,
    }),
  });
  assert.equal(allow.status, 200);

  const status = await jsonFetch(
    `/v1/pair/status?requestId=${encodeURIComponent(request.body.requestId)}&clientNonce=${encodeURIComponent(nonce)}`,
  );
  assert.equal(status.body.status, "allowed");
  return {
    clientId: status.body.clientId as string,
    credential: status.body.credential as string,
  };
}

function authHeaders(client: { clientId: string; credential: string }, extra: Record<string, string> = {}) {
  return {
    "X-Local-Agent-Client-Id": client.clientId,
    Authorization: `Bearer ${client.credential}`,
    ...extra,
  };
}

describe("real provider contract", { concurrency: false, skip: providerIds.length === 0 }, () => {
  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "local-cli-agent-contract-"));
    const store = new SQLiteStore(dataDir);
    await store.init();
    server = new AgentServer({
      store,
      providers: createDefaultProviders(),
      adminToken: "contract-admin",
      settings: {
        host: "localhost",
        port: 0,
        startAtLogin: false,
        logRetentionDays: 7,
        logsEnabled: true,
      },
    });
    await server.start(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server?.stop();
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  for (const provider of providerIds) {
    it(`${provider} supports safe non-interactive non-stream and stream calls`, async () => {
      const providers = await jsonFetch("/admin/providers", {
        headers: { "X-Local-Agent-Admin-Token": "contract-admin" },
      });
      const status = providers.body.providers.find((item: any) => item.id === provider);
      assert.ok(status, `${provider} should be registered`);
      assert.equal(status.ready, true, `${provider} is not ready: ${status.message ?? status.reason ?? "unknown"}`);

      const client = await pairClient(provider);
      const prompt = `contract-${provider}-${crypto.randomUUID()}`;
      const chat = await jsonFetch("/v1/chat", {
        method: "POST",
        headers: authHeaders(client),
        body: JSON.stringify({
          provider,
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      assert.equal(chat.status, 200);
      assert.equal(chat.body.provider, provider);
      assert.equal(typeof chat.body.content, "string");

      const stream = await fetch(`${baseUrl}/v1/chat`, {
        method: "POST",
        headers: authHeaders(client, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          provider,
          stream: true,
          messages: [{ role: "user", content: `${prompt}\n${"large-input ".repeat(500)}` }],
        }),
      });
      assert.equal(stream.status, 200);
      const streamText = await stream.text();
      assert.match(streamText, /"type":"start"/);
      assert.match(streamText, /"type":"done"/);
    });
  }
});
