import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliProviderAdapter, createDefaultProviders, ProviderRegistry } from "../src/providers.ts";
import { AgentServer } from "../src/server.ts";
import { SQLiteStore } from "../src/storage.ts";

let server: AgentServer;
let baseUrl: string;
let dataDir: string;

async function jsonFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function pairClient(options: {
  origin?: string | null;
  capabilities?: string[];
  providers?: string[];
  maxConcurrentRequests?: number;
} = {}) {
  const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
  const origin = options.origin === undefined ? "http://localhost:17625" : options.origin;
  const request = await jsonFetch("/v1/pair/request", {
    method: "POST",
    headers: origin ? { Origin: origin } : undefined,
    body: JSON.stringify({
      clientName: "Integration Test",
      clientType: "web-app",
      origin,
      requestedCapabilities: options.capabilities ?? ["llm.chat", "llm.stream", "llm.listProviders"],
      requestedProviders: options.providers ?? ["fake"],
      clientNonce: nonce,
    }),
  });

  assert.equal(request.status, 200);
  const allow = await jsonFetch(`/admin/pairing/${request.body.requestId}/allow`, {
    method: "POST",
    headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    body: JSON.stringify({
      allowedProviders: options.providers ?? ["fake"],
      defaultProvider: "fake",
      maxConcurrentRequests: options.maxConcurrentRequests,
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
    requestId: request.body.requestId as string,
    nonce,
  };
}

function authHeaders(client: { clientId: string; credential: string }, extra: Record<string, string> = {}) {
  return {
    "X-Local-Agent-Client-Id": client.clientId,
    Authorization: `Bearer ${client.credential}`,
    ...extra,
  };
}

async function waitForLogs(expectedCount: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = await jsonFetch("/admin/logs", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(logs.status, 200);
    if (logs.body.logs.length >= expectedCount) {
      return logs.body.logs;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const logs = await jsonFetch("/admin/logs", {
    headers: { "X-Local-Agent-Admin-Token": "test-admin" },
  });
  return logs.body.logs;
}

async function waitForActiveRequests(expectedCount: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await jsonFetch("/admin/status", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(status.status, 200);
    if (status.body.activeRequests === expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for activeRequests=${expectedCount}`);
}

async function waitForTextFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return readFile(path, "utf8");
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "local-cli-agent-test-"));
  const store = new SQLiteStore(dataDir);
  await store.init();
  server = new AgentServer({
    store,
    providers: createDefaultProviders({ enableFakeProvider: true }),
    adminToken: "test-admin",
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

afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("Local CLI Agent sidecar", { concurrency: false }, () => {
  it("returns minimal health without pairing", async () => {
    const response = await jsonFetch("/health");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.service, "local-cli-agent");
    assert.equal(response.body.pairingRequired, true);
  });

  it("pairs a client and only returns the credential once", async () => {
    const client = await pairClient();
    assert.match(client.clientId, /^client_/);
    assert.match(client.credential, /^internal_secret_/);

    const second = await jsonFetch(
      `/v1/pair/status?requestId=${encodeURIComponent(client.requestId)}&clientNonce=${encodeURIComponent(client.nonce)}`,
    );
    assert.equal(second.body.status, "expired");
  });

  it("replaces an existing pairing for the same origin and client name", async () => {
    const first = await pairClient();
    const second = await pairClient();

    assert.notEqual(second.clientId, first.clientId);

    const clients = await jsonFetch("/admin/clients", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(clients.status, 200);
    assert.equal(clients.body.clients.length, 1);
    assert.equal(clients.body.clients[0].clientId, second.clientId);

    const oldCredential = await jsonFetch("/v1/providers", {
      headers: authHeaders(first),
    });
    assert.equal(oldCredential.status, 401);
    assert.equal(oldCredential.body.code, "invalid_credential");

    const newCredential = await jsonFetch("/v1/providers", {
      headers: authHeaders(second),
    });
    assert.equal(newCredential.status, 200);
  });

  it("deduplicates existing pairings with the same origin and client name on store init", async () => {
    await server.stop();

    const store = new SQLiteStore(dataDir);
    await store.init();
    const duplicateBase = {
      clientName: "Duplicate Demo",
      clientType: "web-app" as const,
      origin: "http://localhost:17625",
      credentialHash: "hash",
      capabilities: ["llm.chat" as const],
      allowedProviders: ["fake" as const],
      defaultProvider: "fake" as const,
      maxConcurrentRequests: 2,
      maxRequestDurationMs: 120000,
      lastUsedAt: null,
      requestCount: 0,
    };
    await store.upsertPairing({
      ...duplicateBase,
      clientId: "client_old",
      createdAt: "2026-06-24T10:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsertPairing({
      ...duplicateBase,
      clientId: "client_new",
      createdAt: "2026-06-24T11:00:00.000Z",
    });

    const restartedStore = new SQLiteStore(dataDir);
    await restartedStore.init();
    const pairings = await restartedStore.listPairings();
    assert.equal(pairings.length, 1);
    assert.equal(pairings[0].clientId, "client_new");

    server = new AgentServer({
      store: restartedStore,
      providers: createDefaultProviders({ enableFakeProvider: true }),
      adminToken: "test-admin",
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

  it("rejects invalid or empty requested capabilities and providers", async () => {
    const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const emptyCapabilities = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: JSON.stringify({
        clientName: "Bad Client",
        clientType: "web-app",
        origin: "http://localhost:17625",
        requestedCapabilities: [],
        requestedProviders: ["fake"],
        clientNonce: nonce,
      }),
    });
    assert.equal(emptyCapabilities.status, 400);
    assert.equal(emptyCapabilities.body.code, "invalid_capabilities");

    const badProvider = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: JSON.stringify({
        clientName: "Bad Client",
        clientType: "web-app",
        origin: "http://localhost:17625",
        requestedCapabilities: ["llm.chat"],
        requestedProviders: ["totally-made-up"],
        clientNonce: `${nonce}_2`,
      }),
    });
    assert.equal(badProvider.status, 400);
    assert.equal(badProvider.body.code, "invalid_providers");
  });

  it("returns client errors for invalid JSON and oversized bodies", async () => {
    const invalidJson = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.code, "invalid_json");

    const oversized = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, "request_too_large");
  });

  it("rejects pair requests whose HTTP Origin disagrees with body origin", async () => {
    const response = await jsonFetch("/v1/pair/request", {
      method: "POST",
      headers: { Origin: "https://browser.example" },
      body: JSON.stringify({
        clientName: "Mismatch",
        clientType: "web-app",
        origin: "https://body.example",
        requestedCapabilities: ["llm.chat"],
        requestedProviders: ["fake"],
        clientNonce: `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "origin_mismatch");
  });

  it("ignores body origin for no-Origin pair requests", async () => {
    const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const request = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: JSON.stringify({
        clientName: "CLI Client",
        clientType: "cli-tool",
        origin: "https://claimed.example",
        requestedCapabilities: ["llm.chat"],
        requestedProviders: ["fake"],
        clientNonce: nonce,
      }),
    });
    assert.equal(request.status, 200);

    const adminStatus = await jsonFetch("/admin/status", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(adminStatus.status, 200);
    assert.equal(adminStatus.body.pendingPairRequests[0].origin, null);
  });

  it("rate limits pending pair requests per origin and globally", async () => {
    async function requestPair(origin: string, suffix: string) {
      return jsonFetch("/v1/pair/request", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({
          clientName: `Pending ${suffix}`,
          clientType: "web-app",
          origin,
          requestedCapabilities: ["llm.chat"],
          requestedProviders: ["fake"],
          clientNonce: `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`,
        }),
      });
    }

    for (let index = 0; index < 5; index += 1) {
      assert.equal((await requestPair("https://busy.example", String(index))).status, 200);
    }
    const perOriginLimited = await requestPair("https://busy.example", "limited");
    assert.equal(perOriginLimited.status, 429);
    assert.equal(perOriginLimited.body.code, "pairing_rate_limited");

    for (let index = 0; index < 45; index += 1) {
      const response = await requestPair(`https://global-${index}.example`, String(index));
      assert.equal(response.status, 200);
    }
    const globallyLimited = await requestPair("https://global-overflow.example", "overflow");
    assert.equal(globallyLimited.status, 429);
    assert.equal(globallyLimited.body.code, "too_many_pair_requests");
  });

  it("requires valid credential for providers and returns fake provider status", async () => {
    const noAuth = await jsonFetch("/v1/providers");
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.code, "not_paired");

    const client = await pairClient();
    const providers = await jsonFetch("/v1/providers", {
      headers: authHeaders(client),
    });
    assert.equal(providers.status, 200);
    assert.equal(providers.body.providers.some((provider: any) => provider.id === "fake" && provider.ready), true);
  });

  it("runs non-streaming chat through the fake provider and writes a redacted log summary", async () => {
    const client = await pairClient();
    const chat = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "Hello from test" }],
      }),
    });

    assert.equal(chat.status, 200);
    assert.match(chat.body.requestId, /^req_/);
    assert.equal(chat.body.provider, "fake");
    assert.match(chat.body.content, /Hello from test/);

    const logs = await waitForLogs(1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].inputChars, "Hello from test".length);
    assert.equal(JSON.stringify(logs).includes("Hello from test"), false);
  });

  it("streams chat as SSE", async () => {
    const client = await pairClient();
    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider: "fake",
        stream: true,
        messages: [{ role: "user", content: "stream me" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type")?.startsWith("text/event-stream"), true);
    const text = await response.text();
    assert.match(text, /"type":"start"/);
    assert.match(text, /"type":"delta"/);
    assert.match(text, /"type":"done"/);
    assert.equal((await waitForLogs(1)).length, 1);
  });

  it("rejects browser requests from an origin that does not match the pairing", async () => {
    const client = await pairClient({ origin: "https://trusted.example" });
    const response = await jsonFetch("/v1/providers", {
      headers: authHeaders(client, { Origin: "https://evil.example" }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "origin_mismatch");
  });

  it("rejects browser Origin for a null-origin pairing while allowing no-Origin CLI requests", async () => {
    const client = await pairClient({ origin: null });
    const cliLike = await jsonFetch("/v1/providers", {
      headers: authHeaders(client),
    });
    assert.equal(cliLike.status, 200);

    const browserLike = await jsonFetch("/v1/providers", {
      headers: authHeaders(client, { Origin: "https://browser.example" }),
    });
    assert.equal(browserLike.status, 403);
    assert.equal(browserLike.body.code, "origin_mismatch");
  });

  it("reserves the active request slot before provider spawn", async () => {
    const client = await pairClient({ maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const first = fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "[slow] hold the slot" }],
      }),
    }).catch((error) => error);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "second" }],
      }),
    });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, "concurrency_limit");

    controller.abort();
    await first;
    assert.ok((await waitForLogs(1)).length >= 1);
  });

  it("expires pair requests and rejects allow after expiry", async () => {
    (server as any).pairRequestTtlMs = 25;
    const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const request = await jsonFetch("/v1/pair/request", {
      method: "POST",
      body: JSON.stringify({
        clientName: "Expiring Client",
        clientType: "web-app",
        origin: "http://localhost:17625",
        requestedCapabilities: ["llm.chat"],
        requestedProviders: ["fake"],
        clientNonce: nonce,
      }),
    });
    assert.equal(request.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const adminStatus = await jsonFetch("/admin/status", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(adminStatus.status, 200);
    assert.equal(adminStatus.body.pendingPairRequests.length, 0);

    const allow = await jsonFetch(`/admin/pairing/${request.body.requestId}/allow`, {
      method: "POST",
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
      body: JSON.stringify({ allowedProviders: ["fake"] }),
    });
    assert.equal(allow.status, 404);

    const status = await jsonFetch(
      `/v1/pair/status?requestId=${encodeURIComponent(request.body.requestId)}&clientNonce=${encodeURIComponent(nonce)}`,
    );
    assert.equal(status.body.status, "expired");
  });

  it("cancels non-streaming provider work when the client disconnects", async () => {
    const client = await pairClient();
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "[slow] cancel me" }],
      }),
    }).catch((error) => error);

    await waitForActiveRequests(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await request;

    const logs = await waitForLogs(1);
    assert.equal(logs[0].status, "cancelled");
  });

  it("escalates stubborn CLI provider cancellation to SIGKILL and releases the request", async () => {
    await server.stop();

    const scriptPath = join(dataDir, "stubborn-provider.mjs");
    const pidPath = join(dataDir, "stubborn-provider.pid");
    await writeFile(scriptPath, `
      import { writeFileSync } from "node:fs";

      writeFileSync(process.argv[2], String(process.pid));
      process.on("SIGTERM", () => {});
      console.log("started");
      setInterval(() => {}, 1000);
    `);

    const store = new SQLiteStore(dataDir);
    await store.init();
    server = new AgentServer({
      store,
      providers: new ProviderRegistry([
        new CliProviderAdapter({
          id: "fake",
          name: "Stubborn CLI",
          command: process.execPath,
          versionArgs: ["--version"],
          promptArgs: () => [scriptPath, pidPath],
        }),
      ]),
      adminToken: "test-admin",
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

    const client = await pairClient();
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "cancel stubborn child" }],
      }),
    }).catch((error) => error);

    await waitForActiveRequests(1);
    const pid = Number(await waitForTextFile(pidPath));
    controller.abort();
    await request;
    await waitForActiveRequests(0);

    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const logs = await waitForLogs(1);
    assert.equal(logs[0].status, "cancelled");
  });

  it("streams CLI provider stdout as text instead of Buffer objects", async () => {
    await server.stop();

    const scriptPath = join(dataDir, "text-provider.mjs");
    await writeFile(scriptPath, `
      process.stdout.write("hello ");
      setTimeout(() => {
        process.stdout.write("from cli");
      }, 10);
    `);

    const store = new SQLiteStore(dataDir);
    await store.init();
    server = new AgentServer({
      store,
      providers: new ProviderRegistry([
        new CliProviderAdapter({
          id: "fake",
          name: "Text CLI",
          command: process.execPath,
          versionArgs: ["--version"],
          promptArgs: () => [scriptPath],
        }),
      ]),
      adminToken: "test-admin",
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

    const client = await pairClient();
    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider: "fake",
        stream: true,
        messages: [{ role: "user", content: "stream text" }],
      }),
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"hello /);
    assert.match(text, /from cli/);
    assert.doesNotMatch(text, /\[object Object\]|"type":"Buffer"/);
    assert.ok((await waitForLogs(1)).length >= 1);
  });

  it("serves logs while chat logging is happening without SQLite races", async () => {
    const client = await pairClient();
    const chat = fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider: "fake",
        stream: true,
        messages: [{ role: "user", content: "[slow] logs race" }],
      }),
    });

    const logReads = await Promise.all(
      Array.from({ length: 20 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonFetch("/admin/logs", {
          headers: { "X-Local-Agent-Admin-Token": "test-admin" },
        });
      }),
    );

    for (const response of logReads) {
      assert.equal(response.status, 200);
    }
    const chatResponse = await chat;
    assert.equal(chatResponse.status, 200);
    await chatResponse.text();
    assert.ok((await waitForLogs(1)).length >= 1);
  });

  it("enforces message validation", async () => {
    const client = await pairClient();
    const response = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake", messages: [] }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid_messages");
  });
});
