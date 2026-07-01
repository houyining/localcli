import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliProviderAdapter, createDefaultProviders, ProviderExecutionError, ProviderRegistry } from "../src/providers.ts";
import { AgentServer } from "../src/server.ts";
import { SQLiteStore } from "../src/storage.ts";
import type {
  ChatMessage,
  FinishReason,
  ProviderAdapter,
  ProviderDiagnostic,
  ProviderHandle,
  ProviderId,
  ProviderInput,
  ProviderRunContext,
  ProviderStatus,
} from "../src/types.ts";

let server: AgentServer;
let baseUrl: string;
let dataDir: string;

class ContextEchoAdapter implements ProviderAdapter {
  id = "fake" as const;
  name = "Context Echo";

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      ready: true,
      reason: "ready",
      version: "test",
      models: ["context-echo"],
    };
  }

  async diagnostics(): Promise<ProviderDiagnostic> {
    return {
      id: this.id,
      name: this.name,
      status: await this.detect(),
      version: "test",
      lastErrorCode: null,
    };
  }

  async getVersion(): Promise<string | null> {
    return "test";
  }

  async getModels(): Promise<string[]> {
    return ["context-echo"];
  }

  async buildInput(messages: ChatMessage[]): Promise<ProviderInput> {
    return {
      messages,
      prompt: messages.map((message) => `${message.role}:${message.content}`).join("|"),
      model: "context-echo",
    };
  }

  async spawn(input: ProviderInput, _context: ProviderRunContext): Promise<ProviderHandle> {
    const content = input.messages.map((message) => `${message.role}:${message.content}`).join("|");
    async function* output(): AsyncIterable<string> {
      yield content;
    }
    return {
      output: output(),
      done: Promise.resolve({ finishReason: "stop" as FinishReason }),
      cancel: () => undefined,
    };
  }

  parseOutput(handle: ProviderHandle): AsyncIterable<string> {
    return handle.output;
  }

  async cancel(_requestId: string): Promise<void> {
    return undefined;
  }
}

type NativeCall = {
  prompt: string;
  nativeProviderSessionId: string | null;
  workingDirectory?: string;
};

class NativeEchoAdapter implements ProviderAdapter {
  id: ProviderId;
  name: string;
  supportsNativeSessions = true;
  calls: NativeCall[];
  private nextNativeSessionId: string;

  constructor(id: "claude" | "codex", calls: NativeCall[] = [], nativeSessionId = `${id}-native-session`) {
    this.id = id;
    this.name = `${id} Native Echo`;
    this.calls = calls;
    this.nextNativeSessionId = nativeSessionId;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      ready: true,
      reason: "ready",
      version: "test",
      nativeSession: { supported: true, state: "unverified" },
    };
  }

  async diagnostics(): Promise<ProviderDiagnostic> {
    return {
      id: this.id,
      name: this.name,
      status: await this.detect(),
      version: "test",
      lastErrorCode: null,
    };
  }

  async getVersion(): Promise<string | null> {
    return "test";
  }

  async getModels(): Promise<string[]> {
    return [];
  }

  async buildInput(messages: ChatMessage[]): Promise<ProviderInput> {
    return {
      messages,
      prompt: messages.map((message) => `${message.role}:${message.content}`).join("|"),
    };
  }

  async spawn(input: ProviderInput, _context: ProviderRunContext): Promise<ProviderHandle> {
    async function* output(): AsyncIterable<string> {
      yield input.prompt;
    }
    return {
      output: output(),
      done: Promise.resolve({ finishReason: "stop" as FinishReason }),
      cancel: () => undefined,
    };
  }

  createNativeSession(): string | null {
    return this.id === "claude" ? this.nextNativeSessionId : null;
  }

  async sendNativeSessionMessage(
    input: ProviderInput,
    context: ProviderRunContext,
    session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    const nativeProviderSessionId = session.nativeProviderSessionId ?? this.nextNativeSessionId;
    this.calls.push({
      prompt: input.prompt,
      nativeProviderSessionId,
      workingDirectory: context.workingDirectory,
    });
    async function* output(): AsyncIterable<string> {
      yield `native:${input.prompt}`;
    }
    return {
      handle: {
        output: output(),
        done: Promise.resolve({ finishReason: "stop" as FinishReason }),
        cancel: () => undefined,
      },
      nativeProviderSessionId: Promise.resolve(nativeProviderSessionId),
    };
  }

  parseOutput(handle: ProviderHandle): AsyncIterable<string> {
    return handle.output;
  }

  async cancel(_requestId: string): Promise<void> {
    return undefined;
  }
}

class NativeUnsupportedAdapter extends NativeEchoAdapter {
  override async sendNativeSessionMessage(
    _input: ProviderInput,
    _context: ProviderRunContext,
    _session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    throw new ProviderExecutionError("native_session_unsupported", "Native sessions are unsupported by this CLI version.");
  }
}

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

async function chunkedJsonFetch(
  path: string,
  chunks: string[],
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: init.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        ...(init.headers ?? {}),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            headers.set(key, value.join(", "));
          } else if (value !== undefined) {
            headers.set(key, String(value));
          }
        }
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) : null,
          headers,
        });
      });
    });
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

async function pairClient(options: {
  origin?: string | null;
  capabilities?: string[];
  providers?: string[];
  maxConcurrentRequests?: number;
} = {}) {
  const nonce = `nonce_${crypto.randomUUID()}_${crypto.randomUUID()}`;
  const origin = options.origin === undefined ? "http://localhost:17625" : options.origin;
  const providers = options.providers ?? ["fake"];
  const request = await jsonFetch("/v1/pair/request", {
    method: "POST",
    headers: origin ? { Origin: origin } : undefined,
    body: JSON.stringify({
      clientName: "Integration Test",
      clientType: "web-app",
      origin,
      requestedCapabilities: options.capabilities ?? ["llm.chat", "llm.stream", "llm.listProviders"],
      requestedProviders: providers,
      clientNonce: nonce,
    }),
  });

  assert.equal(request.status, 200);
  const allow = await jsonFetch(`/admin/pairing/${request.body.requestId}/allow`, {
    method: "POST",
    headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    body: JSON.stringify({
      allowedProviders: providers,
      defaultProvider: providers[0],
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

function parseSseEvents(text: string): any[] {
  return text
    .split("\n\n")
    .map((part) => part.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

async function restartWithProviders(providers: ProviderRegistry, options: {
  sessionTtlMs?: number;
  maxSessionsPerClient?: number;
} = {}) {
  await server.stop();
  const store = new SQLiteStore(dataDir);
  await store.init();
  server = new AgentServer({
    store,
    providers,
    adminToken: "test-admin",
    settings: {
      host: "localhost",
      port: 0,
      startAtLogin: false,
      logRetentionDays: 7,
      logsEnabled: true,
    },
    ...options,
  });
  await server.start(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
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
    assert.equal("credentialHash" in clients.body.clients[0], false);

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

  it("keeps lightweight session context for a paired local client", async () => {
    await restartWithProviders(new ProviderRegistry([new ContextEchoAdapter()]));
    const client = await pairClient();

    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        messages: [{ role: "system", content: "remember earlier turns" }],
      }),
    });
    assert.equal(created.status, 201);
    assert.match(created.body.session.sessionId, /^session_/);
    assert.equal(created.body.session.provider, "fake");
    assert.equal(created.body.session.messageCount, 1);

    const first = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        messages: [{ role: "user", content: "first turn" }],
      }),
    });
    assert.equal(first.status, 200);
    assert.match(first.body.content, /system:remember earlier turns/);
    assert.match(first.body.content, /user:first turn/);
    assert.equal(first.body.session.messageCount, 3);

    const second = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        messages: [{ role: "user", content: "second turn" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.match(second.body.content, /user:first turn/);
    assert.match(second.body.content, /assistant:system:remember earlier turns/);
    assert.match(second.body.content, /user:second turn/);
    assert.equal(second.body.session.messageCount, 5);

    const stream = await fetch(`${baseUrl}/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "third streamed turn" }],
      }),
    });
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    assert.match(streamText, /"type":"delta"/);
    assert.match(streamText, /third streamed turn/);
    assert.match(streamText, /"type":"done"/);

    const afterStream = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}`, {
      headers: authHeaders(client),
    });
    assert.equal(afterStream.status, 200);
    assert.equal(afterStream.body.session.messageCount, 7);

    const listed = await jsonFetch("/v1/sessions", {
      headers: authHeaders(client),
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sessions.length, 1);
    assert.equal(listed.body.sessions[0].sessionId, created.body.session.sessionId);
    assert.equal("messages" in listed.body.sessions[0], false);

    const deleted = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}`, {
      method: "DELETE",
      headers: authHeaders(client),
    });
    assert.equal(deleted.status, 200);

    const missing = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}`, {
      headers: authHeaders(client),
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "session_not_found");
  });

  it("creates and continues a local session through /v1/chat session controls", async () => {
    await restartWithProviders(new ProviderRegistry([new ContextEchoAdapter()]));
    const client = await pairClient();

    const first = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        session: { create: true, mode: "local" },
        messages: [{ role: "user", content: "first convenience turn" }],
      }),
    });
    assert.equal(first.status, 200);
    assert.match(first.body.sessionId, /^session_/);
    assert.equal(first.body.session.sessionId, first.body.sessionId);
    assert.equal(first.body.session.mode, "local");
    assert.equal(first.body.session.messageCount, 2);
    assert.match(first.body.content, /user:first convenience turn/);

    const second = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        session: { id: first.body.sessionId },
        messages: [{ role: "user", content: "second convenience turn" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, first.body.sessionId);
    assert.equal(second.body.session.messageCount, 4);
    assert.match(second.body.content, /user:first convenience turn/);
    assert.match(second.body.content, /user:second convenience turn/);

    const stateless = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        messages: [{ role: "user", content: "stateless turn" }],
      }),
    });
    assert.equal(stateless.status, 200);
    assert.equal("sessionId" in stateless.body, false);
    assert.match(stateless.body.content, /user:stateless turn/);
    assert.doesNotMatch(stateless.body.content, /first convenience turn/);
    assert.ok((await waitForLogs(3)).length >= 3);
  });

  it("returns session metadata in /v1/chat session streams", async () => {
    await restartWithProviders(new ProviderRegistry([new ContextEchoAdapter()]));
    const client = await pairClient();

    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider: "fake",
        stream: true,
        session: { create: true, mode: "local" },
        messages: [{ role: "user", content: "streamed session turn" }],
      }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const start = events.find((event) => event.type === "start");
    const done = events.find((event) => event.type === "done");
    assert.match(start.sessionId, /^session_/);
    assert.equal(start.session.sessionId, start.sessionId);
    assert.equal(start.session.messageCount, 0);
    assert.equal(done.sessionId, start.sessionId);
    assert.equal(done.session.messageCount, 2);
    assert.equal(done.finishReason, "stop");
    assert.ok((await waitForLogs(1)).length >= 1);
  });

  it("uses native provider sessions without resending previous turns", async () => {
    const calls: NativeCall[] = [];
    await restartWithProviders(new ProviderRegistry([new NativeEchoAdapter("claude", calls, "claude-native-1")]));
    const client = await pairClient({ providers: ["claude"] });

    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "claude" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.mode, "native");
    assert.equal(created.body.session.nativeSessionState, "ready");
    assert.equal("nativeProviderSessionId" in created.body.session, false);

    const first = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ messages: [{ role: "user", content: "first native turn" }] }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.session.messageCount, 2);
    const providerAfterNativeSuccess = await jsonFetch("/v1/providers", {
      headers: authHeaders(client),
    });
    assert.equal(providerAfterNativeSuccess.body.providers[0].nativeSession.state, "ready");

    const second = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ messages: [{ role: "user", content: "second native turn" }] }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.session.messageCount, 4);

    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /first native turn/);
    assert.doesNotMatch(calls[0].prompt, /second native turn/);
    assert.match(calls[1].prompt, /second native turn/);
    assert.doesNotMatch(calls[1].prompt, /first native turn/);
    assert.equal(calls[0].nativeProviderSessionId, "claude-native-1");
    assert.equal(calls[1].nativeProviderSessionId, "claude-native-1");
    assert.ok((await waitForLogs(2)).length >= 2);
  });

  it("creates and continues a native provider session through /v1/chat", async () => {
    const calls: NativeCall[] = [];
    await restartWithProviders(new ProviderRegistry([new NativeEchoAdapter("claude", calls, "claude-native-chat")]));
    const client = await pairClient({ providers: ["claude"] });

    const first = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "claude",
        session: { create: true, mode: "auto" },
        messages: [{ role: "user", content: "native convenience first" }],
      }),
    });
    assert.equal(first.status, 200);
    assert.match(first.body.sessionId, /^session_/);
    assert.equal(first.body.session.mode, "native");
    assert.equal(first.body.session.nativeSessionState, "ready");
    assert.equal(first.body.session.messageCount, 2);

    const second = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        session: { id: first.body.sessionId },
        messages: [{ role: "user", content: "native convenience second" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, first.body.sessionId);
    assert.equal(second.body.session.messageCount, 4);
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /native convenience first/);
    assert.doesNotMatch(calls[0].prompt, /native convenience second/);
    assert.match(calls[1].prompt, /native convenience second/);
    assert.doesNotMatch(calls[1].prompt, /native convenience first/);
    assert.equal(calls[0].nativeProviderSessionId, "claude-native-chat");
    assert.equal(calls[1].nativeProviderSessionId, "claude-native-chat");
    assert.ok((await waitForLogs(2)).length >= 2);
  });

  it("rejects ambiguous /v1/chat session controls", async () => {
    await restartWithProviders(new ProviderRegistry([
      new ContextEchoAdapter(),
      new NativeEchoAdapter("claude"),
    ]));
    const client = await pairClient({ providers: ["fake", "claude"] });

    const ambiguous = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        session: { create: true, id: "session_confused" },
        messages: [{ role: "user", content: "bad" }],
      }),
    });
    assert.equal(ambiguous.status, 400);
    assert.equal(ambiguous.body.code, "invalid_request");

    const created = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        session: { create: true, mode: "local" },
        messages: [{ role: "user", content: "local" }],
      }),
    });
    assert.equal(created.status, 200);

    const mismatch = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "claude",
        session: { id: created.body.sessionId },
        messages: [{ role: "user", content: "wrong provider" }],
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, "invalid_request");
    assert.ok((await waitForLogs(1)).length >= 1);
  });

  it("restores native session metadata across sidecar restarts", async () => {
    const calls: NativeCall[] = [];
    await restartWithProviders(new ProviderRegistry([new NativeEchoAdapter("codex", calls, "codex-native-1")]));
    const client = await pairClient({ providers: ["codex"] });

    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "codex" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.mode, "native");
    assert.equal(created.body.session.nativeSessionState, "pending");

    const first = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ messages: [{ role: "user", content: "bootstrap codex" }] }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.session.nativeSessionState, "ready");
    assert.equal(calls[0].nativeProviderSessionId, "codex-native-1");
    assert.ok((await waitForLogs(1)).length >= 1);

    await restartWithProviders(new ProviderRegistry([new NativeEchoAdapter("codex", calls, "codex-native-2")]));
    const second = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ messages: [{ role: "user", content: "after restart" }] }),
    });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].nativeProviderSessionId, "codex-native-1");
    assert.match(calls[1].prompt, /after restart/);
    assert.doesNotMatch(calls[1].prompt, /bootstrap codex/);
    assert.ok((await waitForLogs(2)).length >= 2);
  });

  it("rejects unsupported native mode and native bootstrap messages", async () => {
    const client = await pairClient();

    const unsupported = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake", mode: "native" }),
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.code, "native_session_unsupported");

    const localAuto = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake" }),
    });
    assert.equal(localAuto.status, 201);
    assert.equal(localAuto.body.session.mode, "local");

    const calls: NativeCall[] = [];
    await restartWithProviders(new ProviderRegistry([new NativeEchoAdapter("claude", calls)]));
    const nativeClient = await pairClient({ providers: ["claude"] });
    const withMessages = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(nativeClient),
      body: JSON.stringify({
        provider: "claude",
        mode: "native",
        messages: [{ role: "user", content: "must be sent later" }],
      }),
    });
    assert.equal(withMessages.status, 400);
    assert.equal(withMessages.body.code, "invalid_request");
    assert.equal(calls.length, 0);
  });

  it("parses optional session create bodies from chunked transfer requests", async () => {
    const client = await pairClient();
    const created = await chunkedJsonFetch("/v1/sessions", [
      "{\"provider\":\"",
      "fake\"}",
    ], {
      headers: authHeaders(client),
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.session.provider, "fake");

    const invalid = await chunkedJsonFetch("/v1/sessions", [
      "{\"provider\":",
    ], {
      headers: authHeaders(client),
    });

    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "invalid_json");
  });

  it("marks native provider failures unavailable in provider status until the failure cache expires", async () => {
    await restartWithProviders(new ProviderRegistry([
      new NativeUnsupportedAdapter("codex"),
    ], {
      failureCacheTtlMs: 500,
      statusCacheTtlMs: 5000,
    }));
    const client = await pairClient({ providers: ["codex"] });

    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "codex" }),
    });
    assert.equal(created.status, 201);

    const failed = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ messages: [{ role: "user", content: "native please" }] }),
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.code, "native_session_unsupported");

    const unavailable = await jsonFetch("/v1/providers", {
      headers: authHeaders(client),
    });
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.providers[0].ready, false);
    assert.equal(unavailable.body.providers[0].reason, "native_session_unsupported");
    assert.equal(unavailable.body.providers[0].nativeSession.state, "unavailable");

    await new Promise((resolve) => setTimeout(resolve, 550));
    const recovered = await jsonFetch("/v1/providers", {
      headers: authHeaders(client),
    });
    assert.equal(recovered.body.providers[0].ready, true);
    assert.equal(recovered.body.providers[0].nativeSession.state, "unverified");
  });

  it("guards session workingDirectory by pairing origin", async () => {
    const browserClient = await pairClient({ origin: "https://browser.example" });
    const browserCwd = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(browserClient, { Origin: "https://browser.example" }),
      body: JSON.stringify({ provider: "fake", workingDirectory: dataDir }),
    });
    assert.equal(browserCwd.status, 403);
    assert.equal(browserCwd.body.code, "working_directory_not_allowed");

    const cliClient = await pairClient({ origin: null });
    const invalidCwd = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(cliClient),
      body: JSON.stringify({ provider: "fake", workingDirectory: "relative/path" }),
    });
    assert.equal(invalidCwd.status, 400);
    assert.equal(invalidCwd.body.code, "invalid_working_directory");

    const validCwd = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(cliClient),
      body: JSON.stringify({ provider: "fake", workingDirectory: dataDir }),
    });
    assert.equal(validCwd.status, 201);
    assert.equal(validCwd.body.session.workingDirectory, await realpath(dataDir));
  });

  it("deletes sessions when the paired client is removed", async () => {
    const client = await pairClient();
    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake" }),
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.sessionId as string;
    assert.ok(await server.store.getSession(sessionId));

    const removed = await jsonFetch(`/admin/clients/${client.clientId}`, {
      method: "DELETE",
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(removed.status, 200);
    assert.equal(await server.store.getSession(sessionId), null);
  });

  it("does not restore a session that was deleted immediately before sidecar restart", async () => {
    const client = await pairClient();
    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake" }),
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.sessionId as string;

    const deleted = await jsonFetch(`/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(client),
    });
    assert.equal(deleted.status, 200);

    await restartWithProviders(createDefaultProviders({ enableFakeProvider: true }));
    const restored = await jsonFetch(`/v1/sessions/${sessionId}`, {
      headers: authHeaders(client),
    });
    assert.equal(restored.status, 404);
    assert.equal(restored.body.code, "session_not_found");
  });

  it("keeps sessions scoped to the creating paired client and expires them from memory", async () => {
    await restartWithProviders(createDefaultProviders({ enableFakeProvider: true }), { sessionTtlMs: 25 });
    const owner = await pairClient({ origin: "https://owner.example" });
    const other = await pairClient({ origin: "https://other.example" });

    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(owner, { Origin: "https://owner.example" }),
      body: JSON.stringify({ provider: "fake" }),
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.sessionId;

    const crossClient = await jsonFetch(`/v1/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(other, { Origin: "https://other.example" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "steal context" }] }),
    });
    assert.equal(crossClient.status, 404);
    assert.equal(crossClient.body.code, "session_not_found");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await jsonFetch(`/v1/sessions/${sessionId}`, {
      headers: authHeaders(owner, { Origin: "https://owner.example" }),
    });
    assert.equal(expired.status, 404);
    assert.equal(expired.body.code, "session_not_found");
  });

  it("rejects concurrent chat writes to the same session", async () => {
    const client = await pairClient({ maxConcurrentRequests: 2 });
    const created = await jsonFetch("/v1/sessions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({ provider: "fake" }),
    });
    assert.equal(created.status, 201);

    const controller = new AbortController();
    const first = fetch(`${baseUrl}/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      signal: controller.signal,
      body: JSON.stringify({
        messages: [{ role: "user", content: "[slow] session lock" }],
      }),
    }).catch((error) => error);

    await waitForActiveRequests(1);
    const second = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        messages: [{ role: "user", content: "should wait" }],
      }),
    });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, "session_busy");

    const deletedWhileBusy = await jsonFetch(`/v1/sessions/${created.body.session.sessionId}`, {
      method: "DELETE",
      headers: authHeaders(client),
    });
    assert.equal(deletedWhileBusy.status, 429);
    assert.equal(deletedWhileBusy.body.code, "session_busy");

    controller.abort();
    await first;
    await waitForActiveRequests(0);
    assert.ok((await waitForLogs(1)).length >= 1);
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

  it("serves OpenAI-compatible models, non-streaming chat, and streaming chat", async () => {
    const client = await pairClient();
    const models = await jsonFetch("/openai/v1/models", {
      headers: authHeaders(client),
    });
    assert.equal(models.status, 200);
    assert.equal(models.body.object, "list");
    assert.equal(models.body.data.some((model: any) => model.id === "fake:fake-echo"), true);

    const chat = await jsonFetch("/openai/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        model: "fake",
        messages: [{ role: "user", content: "OpenAI shape" }],
      }),
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.object, "chat.completion");
    assert.match(chat.body.id, /^chatcmpl_req_/);
    assert.equal(chat.body.choices[0].message.role, "assistant");
    assert.match(chat.body.choices[0].message.content, /OpenAI shape/);

    const stream = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(client, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: "fake:fake-echo",
        stream: true,
        messages: [{ role: "user", content: "stream OpenAI shape" }],
      }),
    });
    assert.equal(stream.status, 200);
    const text = await stream.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /stream OpenAI shape/);
    assert.match(text, /data: \[DONE\]/);
    assert.ok((await waitForLogs(2)).length >= 2);
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
          args: [scriptPath, pidPath],
          inputMode: "stdin",
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
          args: [scriptPath],
          inputMode: "stdin",
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

  it("passes CLI prompts through stdin without exposing them in argv, logs, or diagnostics", async () => {
    await server.stop();

    const scriptPath = join(dataDir, "stdin-provider.mjs");
    const argvPath = join(dataDir, "stdin-provider.argv.json");
    const stdinPath = join(dataDir, "stdin-provider.stdin.txt");
    await writeFile(scriptPath, `
      import { writeFileSync } from "node:fs";

      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        writeFileSync(process.argv[2], JSON.stringify(process.argv));
        writeFileSync(process.argv[3], input);
        process.stdout.write(input);
      });
    `);

    const store = new SQLiteStore(dataDir);
    await store.init();
    server = new AgentServer({
      store,
      providers: new ProviderRegistry([
        new CliProviderAdapter({
          id: "fake",
          name: "Stdin CLI",
          command: process.execPath,
          versionArgs: ["--version"],
          args: [scriptPath, argvPath, stdinPath],
          inputMode: "stdin",
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

    const secretPrompt = `SECRET_PROMPT_${crypto.randomUUID()}`;
    const client = await pairClient();
    const response = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: secretPrompt }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.body.content, new RegExp(secretPrompt));
    const argv = await waitForTextFile(argvPath);
    const stdin = await waitForTextFile(stdinPath);
    assert.equal(argv.includes(secretPrompt), false);
    assert.equal(stdin.includes(secretPrompt), true);

    const logs = await waitForLogs(1);
    assert.equal(JSON.stringify(logs).includes(secretPrompt), false);

    const diagnostics = await jsonFetch("/admin/diagnostics", {
      headers: { "X-Local-Agent-Admin-Token": "test-admin" },
    });
    assert.equal(diagnostics.status, 200);
    assert.equal(JSON.stringify(diagnostics.body).includes(secretPrompt), false);
  });

  it("redacts CLI provider stderr from client-visible errors", async () => {
    await server.stop();

    const scriptPath = join(dataDir, "failing-provider.mjs");
    await writeFile(scriptPath, `
      process.stderr.write("SECRET_TOKEN_FROM_STDERR");
      process.exit(7);
    `);

    const store = new SQLiteStore(dataDir);
    await store.init();
    server = new AgentServer({
      store,
      providers: new ProviderRegistry([
        new CliProviderAdapter({
          id: "fake",
          name: "Failing CLI",
          command: process.execPath,
          versionArgs: ["--version"],
          args: [scriptPath],
          inputMode: "stdin",
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
    const response = await jsonFetch("/v1/chat", {
      method: "POST",
      headers: authHeaders(client),
      body: JSON.stringify({
        provider: "fake",
        stream: false,
        messages: [{ role: "user", content: "fail safely" }],
      }),
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, "provider_error");
    assert.equal(response.body.message, "Provider execution failed.");
    assert.equal(JSON.stringify(response.body).includes("SECRET_TOKEN_FROM_STDERR"), false);

    const logs = await waitForLogs(1);
    assert.equal(logs[0].status, "error");
    assert.equal(logs[0].errorCode, "provider_error");
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
