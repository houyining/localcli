import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { hashCredential, randomToken, verifyCredential } from "./crypto.ts";
import { ProviderExecutionError, ProviderRegistry } from "./providers.ts";
import { type SQLiteStore } from "./storage.ts";
import {
  CAPABILITIES,
  CLIENT_TYPES,
  type AgentSettings,
  type Capability,
  type ChatMessage,
  type ChatRequest,
  type PairRequest,
  type PairingRecord,
  type ProviderId,
  type RequestLogSummary,
  type StreamEvent,
} from "./types.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOTAL_CONTENT_CHARS = 100000;
const PAIR_REQUEST_TTL_MS = 60000;
const MAX_PENDING_PAIR_REQUESTS = 50;
const MAX_PENDING_PAIR_REQUESTS_PER_ORIGIN = 5;

type ActiveRequest = {
  requestId: string;
  clientId: string;
  provider: ProviderId;
  startedAt: string;
  inputChars: number;
  cancel: () => void;
};

type AuthResult = {
  record: PairingRecord;
};

type AdminEvent = {
  type: string;
  payload: unknown;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function nowIso(): string {
  return new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseCapabilities(value: unknown, allowed = CAPABILITIES): ParseResult<Capability[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      code: "invalid_capabilities",
      message: "capabilities must be a non-empty array.",
    };
  }

  const capabilities: Capability[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !CAPABILITIES.includes(item as Capability)) {
      return {
        ok: false,
        code: "invalid_capabilities",
        message: `Unknown capability: ${String(item)}.`,
      };
    }
    if (!allowed.includes(item as Capability)) {
      return {
        ok: false,
        code: "capability_not_requested",
        message: `Capability was not requested: ${item}.`,
      };
    }
    capabilities.push(item as Capability);
  }

  return { ok: true, value: [...new Set(capabilities)] };
}

function isProviderId(value: unknown): value is ProviderId {
  return ["claude", "codex", "gemini", "ollama", "fake"].includes(String(value));
}

function parseProviders(value: unknown, allowedProviders: ProviderId[]): ParseResult<ProviderId[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      code: "invalid_providers",
      message: "providers must be a non-empty array.",
    };
  }

  const providers: ProviderId[] = [];
  for (const item of value) {
    if (!isProviderId(item)) {
      return {
        ok: false,
        code: "invalid_providers",
        message: `Unknown provider: ${String(item)}.`,
      };
    }
    if (!allowedProviders.includes(item)) {
      return {
        ok: false,
        code: "provider_not_requested",
        message: `Provider is not available or was not requested: ${item}.`,
      };
    }
    providers.push(item);
  }

  return { ok: true, value: [...new Set(providers)] };
}

function sseData(event: StreamEvent | AdminEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function parseBearer(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function clientSafeError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderExecutionError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "request_cancelled", message: "Request was cancelled." };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: "Unexpected error." };
}

function pairOriginKey(origin: string | null): string {
  return origin ?? "__no_origin__";
}

export class AgentServer {
  readonly store: SQLiteStore;
  readonly providers: ProviderRegistry;
  readonly adminToken: string;
  readonly pairRequestTtlMs: number;
  settings!: AgentSettings;
  server: http.Server | null = null;
  port = 17624;
  host: "localhost" = "localhost";
  private pairRequests = new Map<string, PairRequest>();
  private pairExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeRequests = new Map<string, ActiveRequest>();
  private adminEventClients = new Set<ServerResponse>();

  constructor(options: {
    store: SQLiteStore;
    providers: ProviderRegistry;
    adminToken: string;
    settings?: AgentSettings;
    pairRequestTtlMs?: number;
  }) {
    this.store = options.store;
    this.providers = options.providers;
    this.adminToken = options.adminToken;
    this.pairRequestTtlMs = options.pairRequestTtlMs ?? PAIR_REQUEST_TTL_MS;
    if (options.settings) {
      this.settings = options.settings;
      this.port = options.settings.port;
      this.host = options.settings.host;
    }
  }

  async start(portOverride?: number): Promise<void> {
    this.settings ??= await this.store.getSettings();
    this.port = portOverride ?? this.settings.port;
    this.host = this.settings.host;

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (res.headersSent) {
          if (!res.writableEnded) {
            res.end();
          }
          console.error(error);
          return;
        }
        const safe = clientSafeError(error);
        this.sendError(req, res, this.statusForError(safe.code), safe.code, safe.message);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        const address = this.server!.address();
        if (typeof address === "object" && address) {
          this.port = address.port;
        }
        this.server!.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const active of this.activeRequests.values()) {
      active.cancel();
    }
    for (const timer of this.pairExpiryTimers.values()) {
      clearTimeout(timer);
    }
    this.pairExpiryTimers.clear();
    for (const client of this.adminEventClients) {
      client.end();
    }
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      await this.handleOptions(req, res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      this.setCors(req, res, "public");
      this.sendJson(res, 200, {
        ok: true,
        service: "local-cli-agent",
        version: "0.1.0",
        host: this.host,
        port: this.port,
        pairingRequired: true,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/v1/pair/request") {
      await this.handlePairRequest(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/v1/pair/status") {
      await this.handlePairStatus(req, res, url);
      return;
    }

    if (pathname.startsWith("/admin/")) {
      await this.handleAdmin(req, res, url);
      return;
    }

    if (req.method === "GET" && pathname === "/v1/providers") {
      const auth = await this.authenticate(req, res, "llm.listProviders");
      if (!auth) {
        return;
      }
      this.setCors(req, res, "sensitive", auth.record);
      const providers = await this.providers.listStatuses();
      await this.touchClient(auth.record.clientId, false);
      this.sendJson(res, 200, { providers });
      return;
    }

    if (req.method === "POST" && pathname === "/v1/chat") {
      await this.handleChat(req, res);
      return;
    }

    const cancelMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      await this.handleCancel(req, res, cancelMatch[1]);
      return;
    }

    this.sendError(req, res, 404, "not_found", "Route not found.");
  }

  private async handlePairRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCors(req, res, "pair");
    const body = await this.readJson(req);
    if (!isObject(body)) {
      this.sendError(req, res, 400, "invalid_request", "Request body must be a JSON object.");
      return;
    }

    const clientName = asString(body.clientName)?.trim();
    const clientType = CLIENT_TYPES.includes(body.clientType as never)
      ? (body.clientType as PairingRecord["clientType"])
      : "unknown";
    const headerOrigin = asString(req.headers.origin);
    const bodyOrigin = asString(body.origin);
    if (headerOrigin && bodyOrigin && headerOrigin !== bodyOrigin) {
      this.sendError(req, res, 400, "origin_mismatch", "Request origin does not match body origin.");
      return;
    }
    const origin = headerOrigin ?? null;
    const clientNonce = asString(body.clientNonce);

    if (!clientName || clientName.length > 120) {
      this.sendError(req, res, 400, "invalid_client_name", "clientName is required.");
      return;
    }
    if (!clientNonce || clientNonce.length < 24) {
      this.sendError(req, res, 400, "invalid_client_nonce", "clientNonce must be high entropy.");
      return;
    }

    this.sweepExpiredPairRequests();
    if (this.countPendingPairRequests() >= MAX_PENDING_PAIR_REQUESTS) {
      this.sendError(req, res, 429, "too_many_pair_requests", "Too many pending pair requests.");
      return;
    }
    if (this.countPendingPairRequests(origin) >= MAX_PENDING_PAIR_REQUESTS_PER_ORIGIN) {
      this.sendError(req, res, 429, "pairing_rate_limited", "Too many pending pair requests for this origin.");
      return;
    }

    const availableProviders = this.providers.ids();
    const requestedCapabilities = parseCapabilities(body.requestedCapabilities);
    if (!requestedCapabilities.ok) {
      this.sendError(req, res, 400, requestedCapabilities.code, requestedCapabilities.message);
      return;
    }
    const requestedProviders = parseProviders(body.requestedProviders, availableProviders);
    if (!requestedProviders.ok) {
      this.sendError(req, res, 400, requestedProviders.code, requestedProviders.message);
      return;
    }

    const requestId = randomToken("pair_req");
    const createdAt = nowIso();
    const pairRequest: PairRequest = {
      requestId,
      clientName,
      clientType,
      origin,
      requestedCapabilities: requestedCapabilities.value,
      requestedProviders: requestedProviders.value,
      clientNonce,
      status: "pending",
      createdAt,
      expiresAt: new Date(Date.now() + this.pairRequestTtlMs).toISOString(),
    };

    this.pairRequests.set(requestId, pairRequest);
    this.schedulePairRequestExpiry(requestId);
    this.emitAdminEvent("pairing.requested", this.publicPairRequest(pairRequest));
    this.sendJson(res, 200, {
      requestId,
      status: "pending",
      expiresIn: Math.ceil(this.pairRequestTtlMs / 1000),
    });
  }

  private async handlePairStatus(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    this.setCors(req, res, "pair");
    this.sweepExpiredPairRequests();
    const requestId = url.searchParams.get("requestId");
    const clientNonce = url.searchParams.get("clientNonce");
    const pairRequest = requestId ? this.pairRequests.get(requestId) : null;

    if (!requestId || !clientNonce || !pairRequest || pairRequest.clientNonce !== clientNonce) {
      this.sendJson(res, 200, { status: "expired" });
      return;
    }

    if (pairRequest.status === "pending" && Date.parse(pairRequest.expiresAt) <= Date.now()) {
      this.markPairRequestExpired(requestId);
      this.sendJson(res, 200, { status: "expired" });
      return;
    }

    if (pairRequest.status === "expired") {
      this.deletePairRequest(requestId);
      this.sendJson(res, 200, { status: "expired" });
      return;
    }

    if (pairRequest.status === "allowed") {
      this.deletePairRequest(requestId);
      this.sendJson(res, 200, {
        status: "allowed",
        clientId: pairRequest.clientId,
        credential: pairRequest.credential,
      });
      pairRequest.credential = undefined;
      return;
    }

    if (pairRequest.status === "denied") {
      this.deletePairRequest(requestId);
      this.sendJson(res, 200, { status: "denied" });
      return;
    }

    this.sendJson(res, 200, { status: pairRequest.status });
  }

  private async handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.authenticateAdmin(req)) {
      this.sendError(req, res, 401, "admin_unauthorized", "Admin token is invalid.");
      return;
    }

    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/admin/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(sseData({ type: "connected", payload: { ok: true } }));
      this.adminEventClients.add(res);
      req.on("close", () => this.adminEventClients.delete(res));
      return;
    }

    if (req.method === "GET" && pathname === "/admin/status") {
      this.sweepExpiredPairRequests();
      const providers = await this.providers.listStatuses();
      const clients = await this.store.listPairings();
      this.sendJson(res, 200, {
        ok: true,
        service: "local-cli-agent",
        version: "0.1.0",
        status: "running",
        address: `http://${this.host}:${this.port}`,
        providersReady: providers.filter((provider) => provider.ready).length,
        providersTotal: providers.length,
        pairedClients: clients.length,
        activeRequests: this.activeRequests.size,
        pendingPairRequests: [...this.pairRequests.values()]
          .filter((request) => request.status === "pending")
          .map((request) => this.publicPairRequest(request)),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/settings") {
      this.sendJson(res, 200, { settings: await this.store.getSettings() });
      return;
    }

    if (req.method === "PATCH" && pathname === "/admin/settings") {
      const body = await this.readJson(req);
      if (!isObject(body)) {
        this.sendError(req, res, 400, "invalid_request", "Request body must be a JSON object.");
        return;
      }

      const current = await this.store.getSettings();
      const next: AgentSettings = { ...current, host: "localhost" };

      if (body.port !== undefined) {
        if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
          this.sendError(req, res, 400, "invalid_port", "port must be an integer from 1 to 65535.");
          return;
        }
        next.port = body.port;
      }
      if (body.logRetentionDays !== undefined) {
        if (!Number.isInteger(body.logRetentionDays) || body.logRetentionDays < 1 || body.logRetentionDays > 365) {
          this.sendError(req, res, 400, "invalid_log_retention", "logRetentionDays must be an integer from 1 to 365.");
          return;
        }
        next.logRetentionDays = body.logRetentionDays;
      }
      if (body.logsEnabled !== undefined) {
        if (typeof body.logsEnabled !== "boolean") {
          this.sendError(req, res, 400, "invalid_logs_enabled", "logsEnabled must be a boolean.");
          return;
        }
        next.logsEnabled = body.logsEnabled;
      }
      if (body.startAtLogin !== undefined) {
        if (typeof body.startAtLogin !== "boolean") {
          this.sendError(req, res, 400, "invalid_start_at_login", "startAtLogin must be a boolean.");
          return;
        }
        next.startAtLogin = body.startAtLogin;
      }

      await this.store.saveSettings(next);
      this.settings = next;
      this.emitAdminEvent("settings.updated", { settings: next });
      this.sendJson(res, 200, { settings: next, restartRequired: next.port !== this.port });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/providers") {
      this.sendJson(res, 200, { providers: await this.providers.listStatuses() });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/clients") {
      this.sendJson(res, 200, { clients: await this.store.listPairings() });
      return;
    }

    const clientMatch = pathname.match(/^\/admin\/clients\/([^/]+)$/);
    if (clientMatch && req.method === "DELETE") {
      await this.store.deletePairing(clientMatch[1]);
      this.emitAdminEvent("client.removed", { clientId: clientMatch[1] });
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (clientMatch && req.method === "PATCH") {
      const body = await this.readJson(req);
      if (!isObject(body)) {
        this.sendError(req, res, 400, "invalid_request", "Request body must be a JSON object.");
        return;
      }

      let parsedCapabilities: Capability[] | undefined;
      if (body.capabilities !== undefined) {
        const result = parseCapabilities(body.capabilities);
        if (!result.ok) {
          this.sendError(req, res, 400, result.code, result.message);
          return;
        }
        parsedCapabilities = result.value;
      }

      let parsedAllowedProviders: ProviderId[] | undefined;
      if (body.allowedProviders !== undefined) {
        const result = parseProviders(body.allowedProviders, this.providers.ids());
        if (!result.ok) {
          this.sendError(req, res, 400, result.code, result.message);
          return;
        }
        parsedAllowedProviders = result.value;
      }

      if (body.defaultProvider !== undefined && !isProviderId(body.defaultProvider)) {
        this.sendError(req, res, 400, "invalid_provider", "defaultProvider is invalid.");
        return;
      }

      const updated = await this.store.updatePairing(clientMatch[1], (record) => {
        const allowedProviders = parsedAllowedProviders ?? record.allowedProviders;
        let defaultProvider = record.defaultProvider;
        if (body.defaultProvider !== undefined) {
          defaultProvider = allowedProviders.includes(body.defaultProvider as ProviderId)
            ? body.defaultProvider as ProviderId
            : allowedProviders[0];
        } else if (!allowedProviders.includes(defaultProvider)) {
          defaultProvider = allowedProviders[0];
        }

        return {
          ...record,
          capabilities: parsedCapabilities ?? record.capabilities,
          allowedProviders,
          defaultProvider,
          maxConcurrentRequests: typeof body.maxConcurrentRequests === "number"
            ? Math.max(1, Math.min(16, Math.floor(body.maxConcurrentRequests)))
            : record.maxConcurrentRequests,
          maxRequestDurationMs: typeof body.maxRequestDurationMs === "number"
            ? Math.max(1000, Math.min(600000, Math.floor(body.maxRequestDurationMs)))
            : record.maxRequestDurationMs,
        };
      });
      if (!updated) {
        this.sendError(req, res, 404, "client_not_found", "Client pairing was not found.");
        return;
      }
      this.emitAdminEvent("client.updated", { clientId: updated.clientId });
      this.sendJson(res, 200, { client: updated });
      return;
    }

    if (req.method === "GET" && pathname === "/admin/logs") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      this.sendJson(res, 200, { logs: await this.store.listLogs(limit) });
      return;
    }

    if (req.method === "POST" && pathname === "/admin/logs/clear") {
      await this.store.clearLogs();
      this.emitAdminEvent("logs.cleared", {});
      this.sendJson(res, 200, { ok: true });
      return;
    }

    const allowMatch = pathname.match(/^\/admin\/pairing\/([^/]+)\/allow$/);
    if (allowMatch && req.method === "POST") {
      await this.handleAdminPairDecision(req, res, allowMatch[1], true);
      return;
    }

    const denyMatch = pathname.match(/^\/admin\/pairing\/([^/]+)\/deny$/);
    if (denyMatch && req.method === "POST") {
      await this.handleAdminPairDecision(req, res, denyMatch[1], false);
      return;
    }

    this.sendError(req, res, 404, "not_found", "Admin route not found.");
  }

  private async handleAdminPairDecision(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    allow: boolean,
  ): Promise<void> {
    const pairRequest = this.pairRequests.get(requestId);
    if (!pairRequest) {
      this.sendError(req, res, 404, "pair_request_not_found", "Pair request was not found.");
      return;
    }
    if (pairRequest.status === "expired" || Date.parse(pairRequest.expiresAt) <= Date.now()) {
      this.markPairRequestExpired(requestId);
      this.sendError(req, res, 410, "pair_request_expired", "Pair request has expired.");
      return;
    }
    if (pairRequest.status !== "pending") {
      this.sendError(req, res, 404, "pair_request_not_found", "Pair request was not found.");
      return;
    }

    if (!allow) {
      pairRequest.status = "denied";
      this.clearPairRequestTimer(requestId);
      this.emitAdminEvent("pairing.denied", { requestId });
      this.sendJson(res, 200, { ok: true, status: "denied" });
      return;
    }

    const body = await this.readJsonOptional(req);
    const clientId = randomToken("client");
    const credential = randomToken("internal_secret", 32);
    const allowedProvidersResult = parseProviders(
      isObject(body) && body.allowedProviders !== undefined ? body.allowedProviders : pairRequest.requestedProviders,
      pairRequest.requestedProviders,
    );
    if (!allowedProvidersResult.ok) {
      this.sendError(req, res, 400, allowedProvidersResult.code, allowedProvidersResult.message);
      return;
    }
    const capabilitiesResult = parseCapabilities(
      isObject(body) && body.capabilities !== undefined ? body.capabilities : pairRequest.requestedCapabilities,
      pairRequest.requestedCapabilities,
    );
    if (!capabilitiesResult.ok) {
      this.sendError(req, res, 400, capabilitiesResult.code, capabilitiesResult.message);
      return;
    }
    const allowedProviders = allowedProvidersResult.value;
    const defaultProvider = isObject(body) && isProviderId(body.defaultProvider)
      && allowedProviders.includes(body.defaultProvider)
      ? body.defaultProvider
      : allowedProviders[0];
    const now = nowIso();
    const record: PairingRecord = {
      clientId,
      clientName: pairRequest.clientName,
      clientType: pairRequest.clientType,
      origin: pairRequest.origin,
      credentialHash: await hashCredential(credential),
      capabilities: capabilitiesResult.value,
      allowedProviders,
      defaultProvider,
      maxConcurrentRequests: isObject(body) && typeof body.maxConcurrentRequests === "number"
        ? Math.max(1, Math.min(16, Math.floor(body.maxConcurrentRequests)))
        : 2,
      maxRequestDurationMs: isObject(body) && typeof body.maxRequestDurationMs === "number"
        ? Math.max(1000, Math.min(600000, Math.floor(body.maxRequestDurationMs)))
        : 120000,
      createdAt: now,
      lastUsedAt: null,
      requestCount: 0,
    };

    const replacedClients = await this.store.deletePairingsForClientIdentity(record.origin, record.clientName);
    await this.store.upsertPairing(record);
    pairRequest.status = "allowed";
    this.clearPairRequestTimer(requestId);
    pairRequest.clientId = clientId;
    pairRequest.credential = credential;
    this.emitAdminEvent("pairing.allowed", { requestId, clientId, replacedClients });
    this.sendJson(res, 200, { ok: true, status: "allowed", clientId });
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const parsed = this.validateChatRequest(await this.readJson(req), auth.record);
    if (!parsed.ok) {
      this.sendError(req, res, this.statusForError(parsed.code), parsed.code, parsed.message);
      return;
    }

    if (parsed.body.stream && !auth.record.capabilities.includes("llm.stream")) {
      this.sendError(req, res, 403, "missing_capability", "Client is not allowed to stream.");
      return;
    }

    const provider = parsed.body.provider ?? auth.record.defaultProvider;
    if (!auth.record.allowedProviders.includes(provider)) {
      this.sendError(req, res, 403, "provider_not_allowed", "Provider is not allowed for this client.");
      return;
    }

    const clientActive = [...this.activeRequests.values()].filter(
      (active) => active.clientId === auth.record.clientId,
    ).length;
    if (clientActive >= auth.record.maxConcurrentRequests) {
      this.sendError(req, res, 429, "concurrency_limit", "Client exceeded concurrent request limit.");
      return;
    }

    const requestId = randomToken("req");
    const startedAt = nowIso();
    const startedMs = Date.now();
    const inputChars = parsed.body.messages.reduce((sum, message) => sum + message.content.length, 0);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("timeout"));
    }, auth.record.maxRequestDurationMs);

    let outputChars = 0;
    let status: RequestLogSummary["status"] = "success";
    let errorCode: string | null = null;
    let completed = false;
    const active: ActiveRequest = {
      requestId,
      clientId: auth.record.clientId,
      provider,
      startedAt,
      inputChars,
      cancel: () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error("cancelled"));
        }
      },
    };
    const onClientClose = (): void => {
      if (!completed) {
        active.cancel();
      }
    };
    this.activeRequests.set(requestId, active);
    res.on("close", onClientClose);
    this.emitAdminEvent("request.started", { requestId, clientId: auth.record.clientId, provider });

    try {
      const { adapter, handle } = await this.providers.spawnChat(provider, parsed.body.messages, {
        requestId,
        signal: controller.signal,
      });

      active.cancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error("cancelled"));
        }
        handle.cancel();
      };
      if (controller.signal.aborted) {
        handle.cancel();
      }

      if (parsed.body.stream) {
        const done = await this.respondStream(res, adapter.parseOutput(handle), handle.done, {
          requestId,
          provider,
          onChunk: (chunk) => {
            outputChars += chunk.length;
          },
          cancel: active.cancel,
        });
        if (done.finishReason === "cancelled") {
          status = "cancelled";
        } else if (done.finishReason === "timeout") {
          status = "timeout";
        }
        completed = true;
      } else {
        const chunks: string[] = [];
        for await (const chunk of adapter.parseOutput(handle)) {
          chunks.push(chunk);
          outputChars += chunk.length;
        }
        const done = await handle.done;
        if (done.finishReason === "cancelled") {
          status = "cancelled";
        } else if (done.finishReason === "timeout") {
          status = "timeout";
        }
        completed = true;
        this.sendJson(res, 200, {
          requestId,
          provider,
          content: chunks.join(""),
          finishReason: done.finishReason,
        });
      }
    } catch (error) {
      const safe = clientSafeError(error);
      errorCode = safe.code;
      status = safe.code === "request_timeout" || controller.signal.reason?.message === "timeout"
        ? "timeout"
        : controller.signal.aborted
          ? "cancelled"
          : "error";

      if (!res.headersSent) {
        this.sendError(req, res, this.statusForError(safe.code), safe.code, safe.message);
      } else if (!res.writableEnded) {
        res.write(sseData({ type: "error", message: safe.message, code: safe.code }));
        res.end();
      }
    } finally {
      clearTimeout(timeout);
      completed = true;
      res.off("close", onClientClose);
      this.activeRequests.delete(requestId);
      await this.touchClient(auth.record.clientId, true);
      await this.writeRequestLog({
        requestId,
        clientId: auth.record.clientId,
        clientName: auth.record.clientName,
        provider,
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - startedMs,
        status,
        inputChars,
        outputChars,
        errorCode,
      });
      this.emitAdminEvent("request.finished", { requestId, status, errorCode });
    }
  }

  private async respondStream(
    res: ServerResponse,
    output: AsyncIterable<string>,
    done: Promise<{ finishReason: string }>,
    options: {
      requestId: string;
      provider: ProviderId;
      onChunk: (chunk: string) => void;
      cancel: () => void;
    },
  ): Promise<{ finishReason: string }> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(sseData({ type: "start", requestId: options.requestId, provider: options.provider }));

    for await (const chunk of output) {
      options.onChunk(chunk);
      res.write(sseData({ type: "delta", content: chunk }));
    }
    const finished = await done;
    res.write(sseData({ type: "done", finishReason: finished.finishReason as never }));
    res.end();
    return finished;
  }

  private async handleCancel(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const active = this.activeRequests.get(requestId);
    if (active && active.clientId === auth.record.clientId) {
      active.cancel();
    }
    this.sendJson(res, 200, { ok: true });
  }

  private validateChatRequest(
    value: unknown,
    record: PairingRecord,
  ): { ok: true; body: Required<ChatRequest> } | { ok: false; code: string; message: string } {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "Request body must be a JSON object." };
    }
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 50) {
      return { ok: false, code: "invalid_messages", message: "messages must contain 1-50 items." };
    }

    const messages: ChatMessage[] = [];
    let totalChars = 0;
    for (const item of value.messages) {
      if (!isObject(item) || !["system", "user", "assistant"].includes(String(item.role))) {
        return { ok: false, code: "invalid_message_role", message: "role must be system, user, or assistant." };
      }
      if (typeof item.content !== "string") {
        return { ok: false, code: "invalid_message_content", message: "content must be a string." };
      }
      totalChars += item.content.length;
      messages.push({ role: item.role as ChatMessage["role"], content: item.content });
    }
    if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
      return { ok: false, code: "request_too_large", message: "Total message content is too large." };
    }

    const provider = value.provider === undefined
      ? record.defaultProvider
      : isProviderId(value.provider)
        ? value.provider
        : null;
    if (!provider) {
      return { ok: false, code: "invalid_provider", message: "provider is invalid." };
    }

    return {
      ok: true,
      body: {
        provider,
        stream: typeof value.stream === "boolean" ? value.stream : false,
        messages,
      },
    };
  }

  private async authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    capability: Capability,
  ): Promise<AuthResult | null> {
    const clientId = asString(req.headers["x-local-agent-client-id"]);
    const credential = parseBearer(req.headers.authorization);

    if (!clientId || !credential) {
      await this.setCorsForAuthFailure(req, res);
      this.sendError(req, res, 401, "not_paired", "Client is not paired.");
      return null;
    }

    const record = await this.store.getPairing(clientId);
    if (!record || !(await verifyCredential(credential, record.credentialHash))) {
      await this.setCorsForAuthFailure(req, res);
      this.sendError(req, res, 401, "invalid_credential", "Credential is invalid.");
      return null;
    }

    const origin = asString(req.headers.origin);
    if (origin && origin !== record.origin) {
      this.setCors(req, res, "sensitive", record);
      this.sendError(req, res, 403, "origin_mismatch", "Request origin does not match pairing.");
      return null;
    }

    if (!record.capabilities.includes(capability)) {
      this.setCors(req, res, "sensitive", record);
      this.sendError(req, res, 403, "missing_capability", `Client is missing ${capability}.`);
      return null;
    }

    return { record };
  }

  private authenticateAdmin(req: IncomingMessage): boolean {
    const headerToken = asString(req.headers["x-local-agent-admin-token"]);
    const bearer = parseBearer(req.headers.authorization);
    return headerToken === this.adminToken || bearer === this.adminToken;
  }

  private async touchClient(clientId: string, incrementRequestCount: boolean): Promise<void> {
    await this.store.updatePairing(clientId, (record) => ({
      ...record,
      lastUsedAt: nowIso(),
      requestCount: record.requestCount + (incrementRequestCount ? 1 : 0),
    }));
  }

  private async writeRequestLog(summary: RequestLogSummary): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.logsEnabled) {
      return;
    }
    await this.store.appendLog(summary, settings.logRetentionDays);
  }

  private emitAdminEvent(type: string, payload: unknown): void {
    const event = sseData({ type, payload });
    for (const client of this.adminEventClients) {
      client.write(event);
    }
  }

  private schedulePairRequestExpiry(requestId: string): void {
    this.clearPairRequestTimer(requestId);
    const timer = setTimeout(() => {
      this.markPairRequestExpired(requestId);
    }, this.pairRequestTtlMs);
    timer.unref();
    this.pairExpiryTimers.set(requestId, timer);
  }

  private sweepExpiredPairRequests(): void {
    for (const [requestId, request] of this.pairRequests) {
      if (request.status === "pending" && Date.parse(request.expiresAt) <= Date.now()) {
        this.markPairRequestExpired(requestId);
      }
    }
  }

  private countPendingPairRequests(origin?: string | null): number {
    const originKey = origin === undefined ? null : pairOriginKey(origin);
    return [...this.pairRequests.values()].filter((request) => {
      if (request.status !== "pending") {
        return false;
      }
      return originKey === null || pairOriginKey(request.origin) === originKey;
    }).length;
  }

  private markPairRequestExpired(requestId: string): void {
    const request = this.pairRequests.get(requestId);
    if (!request || request.status !== "pending") {
      return;
    }
    request.status = "expired";
    request.credential = undefined;
    this.emitAdminEvent("pairing.expired", { requestId });
    this.deletePairRequest(requestId);
  }

  private deletePairRequest(requestId: string): void {
    this.clearPairRequestTimer(requestId);
    this.pairRequests.delete(requestId);
  }

  private clearPairRequestTimer(requestId: string): void {
    const timer = this.pairExpiryTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.pairExpiryTimers.delete(requestId);
    }
  }

  private publicPairRequest(pairRequest: PairRequest): Omit<PairRequest, "clientNonce" | "credential"> {
    const { clientNonce: _clientNonce, credential: _credential, ...publicRequest } = pairRequest;
    return publicRequest;
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        throw new ProviderExecutionError("request_too_large", "Request body is too large.");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) {
      return {};
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderExecutionError("invalid_json", "Request body must be valid JSON.");
    }
  }

  private async readJsonOptional(req: IncomingMessage): Promise<unknown> {
    if (Number(req.headers["content-length"] ?? "0") === 0) {
      return {};
    }
    return this.readJson(req);
  }

  private statusForError(code: string): number {
    switch (code) {
      case "provider_not_found":
      case "provider_not_installed":
      case "provider_not_ready":
      case "invalid_json":
      case "invalid_messages":
      case "invalid_message_role":
      case "invalid_message_content":
      case "invalid_provider":
      case "invalid_request":
        return 400;
      case "request_too_large":
        return 413;
      case "concurrency_limit":
      case "pairing_rate_limited":
      case "too_many_pair_requests":
        return 429;
      default:
        return 500;
    }
  }

  private async handleOptions(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === "/health") {
      this.setCors(req, res, "public");
    } else if (pathname.startsWith("/v1/pair/")) {
      this.setCors(req, res, "pair");
    } else {
      const origin = asString(req.headers.origin);
      if (origin && await this.store.hasPairingOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, authorization, x-local-agent-client-id, x-local-agent-admin-token",
    );
    res.writeHead(204);
    res.end();
  }

  private setCors(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "public" | "pair" | "sensitive",
    record?: PairingRecord,
  ): void {
    const origin = asString(req.headers.origin);
    if (kind === "public") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return;
    }
    if (kind === "pair" && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      return;
    }
    if (kind === "sensitive" && origin && record?.origin === origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }

  private async setCorsForAuthFailure(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = asString(req.headers.origin);
    if (origin && await this.store.hasPairingOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private sendError(
    req: IncomingMessage,
    res: ServerResponse,
    statusCode: number,
    code: string,
    message: string,
  ): void {
    if (!res.hasHeader("Access-Control-Allow-Origin")) {
      if ((req.url ?? "") === "/health") {
        this.setCors(req, res, "public");
      }
    }
    this.sendJson(res, statusCode, { ok: false, code, message });
  }
}
