import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { hashCredential, randomToken, verifyCredential } from "./crypto.ts";
import { ProviderExecutionError, ProviderRegistry } from "./providers.ts";
import { type SQLiteStore } from "./storage.ts";
import {
  CAPABILITIES,
  CLIENT_TYPES,
  type AgentSettings,
  type Capability,
  type ChatMessage,
  type ChatSessionMetadata,
  type ChatSessionSummary,
  type DiagnosticsSnapshot,
  type EffectiveSessionMode,
  type NativeSessionState,
  type PairRequest,
  type PairingRecord,
  type ProviderId,
  type RequestLogSummary,
  type SessionChatRequest,
  type SessionCreateRequest,
  type SessionMode,
  type StreamEvent,
} from "./types.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOTAL_CONTENT_CHARS = 100000;
const PAIR_REQUEST_TTL_MS = 60000;
const MAX_PENDING_PAIR_REQUESTS = 50;
const MAX_PENDING_PAIR_REQUESTS_PER_ORIGIN = 5;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS_PER_CLIENT = 20;

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

type PublicPairingRecord = Omit<PairingRecord, "credentialHash">;

type ParseResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

type ChatSession = ChatSessionMetadata & {
  messages: ChatMessage[];
  expiresAtMs: number;
};

type ParsedChatSessionSpec =
  | {
    kind: "create";
    mode: SessionMode;
    workingDirectory?: string;
  }
  | {
    kind: "existing";
    sessionId: string;
  };

type ParsedChatRequest = {
  provider?: ProviderId;
  stream: boolean;
  messages: ChatMessage[];
  session?: ParsedChatSessionSpec;
};

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
    return { code: error.code, message: publicErrorMessage(error.code) };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "request_cancelled", message: "Request was cancelled." };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: publicErrorMessage("internal_error") };
  }
  return { code: "internal_error", message: publicErrorMessage("internal_error") };
}

function publicErrorMessage(code: string): string {
  switch (code) {
    case "invalid_json":
      return "Request body must be valid JSON.";
    case "request_too_large":
      return "Request body is too large.";
    case "request_cancelled":
      return "Request was cancelled.";
    case "request_timeout":
      return "Request timed out.";
    case "provider_not_found":
      return "Provider is not available.";
    case "provider_not_installed":
      return "Provider is not installed.";
    case "provider_not_authenticated":
      return "Provider is not authenticated.";
    case "provider_not_ready":
      return "Provider is not ready.";
    case "provider_secure_input_unsupported":
      return "Provider does not support secure non-interactive input.";
    case "native_session_unsupported":
      return "Provider does not support stable native sessions.";
    case "native_session_unavailable":
      return "Native session mapping is unavailable.";
    case "working_directory_not_allowed":
      return "Working directory is only available to no-origin local clients.";
    case "invalid_working_directory":
      return "workingDirectory must be an existing absolute directory.";
    case "session_busy":
      return "Session already has an active request.";
    case "provider_error":
      return "Provider execution failed.";
    default:
      return "Internal server error.";
  }
}

function pairOriginKey(origin: string | null): string {
  return origin ?? "__no_origin__";
}

function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export class AgentServer {
  readonly store: SQLiteStore;
  readonly providers: ProviderRegistry;
  readonly adminToken: string;
  pairRequestTtlMs: number;
  sessionTtlMs: number;
  maxSessionsPerClient: number;
  settings!: AgentSettings;
  server: http.Server | null = null;
  port = 17624;
  host: "localhost" = "localhost";
  private pairRequests = new Map<string, PairRequest>();
  private pairExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessions = new Map<string, ChatSession>();
  private sessionExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeSessionIds = new Set<string>();
  private activeRequests = new Map<string, ActiveRequest>();
  private adminEventClients = new Set<ServerResponse>();
  private startedAtMs = Date.now();

  constructor(options: {
    store: SQLiteStore;
    providers: ProviderRegistry;
    adminToken: string;
    settings?: AgentSettings;
    pairRequestTtlMs?: number;
    sessionTtlMs?: number;
    maxSessionsPerClient?: number;
  }) {
    this.store = options.store;
    this.providers = options.providers;
    this.adminToken = options.adminToken;
    this.pairRequestTtlMs = options.pairRequestTtlMs ?? PAIR_REQUEST_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.maxSessionsPerClient = options.maxSessionsPerClient ?? MAX_SESSIONS_PER_CLIENT;
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
    await this.restoreSessions();

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
    for (const timer of this.sessionExpiryTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionExpiryTimers.clear();
    this.activeSessionIds.clear();
    this.sessions.clear();
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

    if (pathname.startsWith("/openai/")) {
      await this.handleOpenAI(req, res, url);
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

    if (req.method === "GET" && pathname === "/v1/sessions") {
      await this.handleListSessions(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/sessions") {
      await this.handleCreateSession(req, res);
      return;
    }

    const sessionChatMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/chat$/);
    if (req.method === "POST" && sessionChatMatch) {
      await this.handleSessionChat(req, res, decodeURIComponent(sessionChatMatch[1]));
      return;
    }

    const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      await this.handleGetSession(req, res, decodeURIComponent(sessionMatch[1]));
      return;
    }

    if (req.method === "DELETE" && sessionMatch) {
      await this.handleDeleteSession(req, res, decodeURIComponent(sessionMatch[1]));
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
    this.setAdminCors(req, res);
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

    if (req.method === "GET" && pathname === "/admin/diagnostics") {
      await this.handleAdminDiagnostics(res);
      return;
    }

    if (req.method === "GET" && pathname === "/admin/clients") {
      const clients = (await this.store.listPairings()).map((record) => this.publicPairingRecord(record));
      this.sendJson(res, 200, { clients });
      return;
    }

    const clientMatch = pathname.match(/^\/admin\/clients\/([^/]+)$/);
    if (clientMatch && req.method === "DELETE") {
      await this.store.deletePairing(clientMatch[1]);
      await this.deleteSessionsForClient(clientMatch[1]);
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
      this.sendJson(res, 200, { client: this.publicPairingRecord(updated) });
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

  private async handleAdminDiagnostics(res: ServerResponse): Promise<void> {
    this.sweepExpiredPairRequests();
    const providers = await this.providers.diagnostics({ force: true });
    const clients = await this.store.listPairings();
    const logs = await this.store.listLogs(50);
    const recentErrors = logs
      .filter((log) => log.status !== "success" || log.errorCode)
      .slice(0, 10)
      .map((log) => ({
        requestId: log.requestId,
        provider: log.provider,
        status: log.status,
        errorCode: log.errorCode,
        endedAt: log.endedAt,
      }));

    const snapshot: DiagnosticsSnapshot = {
      ok: true,
      service: "local-cli-agent",
      version: "0.1.0",
      status: "running",
      address: `http://${this.host}:${this.port}`,
      uptimeMs: Date.now() - this.startedAtMs,
      activeRequests: this.activeRequests.size,
      pairedClients: clients.length,
      pendingPairRequests: [...this.pairRequests.values()].filter((request) => request.status === "pending").length,
      restartCount: Number(process.env.LOCAL_CLI_AGENT_RESTART_COUNT ?? "0") || 0,
      runtime: {
        nodeVersion: process.version,
        execPath: this.redactPath(process.execPath),
        platform: process.platform,
        arch: process.arch,
        pathEntries: this.redactPathEntries(process.env.PATH ?? ""),
      },
      providers: providers.map((provider) => ({
        ...provider,
        commandPath: provider.commandPath ? this.redactPath(provider.commandPath) : provider.commandPath,
      })),
      recentErrors,
    };
    this.sendJson(res, 200, snapshot);
  }

  private redactPathEntries(pathValue: string): string[] {
    return pathValue
      .split(":")
      .filter(Boolean)
      .slice(0, 40)
      .map((entry) => this.redactPath(entry));
  }

  private redactPath(value: string): string {
    const home = process.env.HOME;
    let redacted = value;
    if (home && redacted.startsWith(home)) {
      redacted = `~${redacted.slice(home.length)}`;
    }
    return redacted.replace(/^\/Users\/[^/]+/, "~");
  }

  private async handleListSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);
    this.expireSessions();
    const sessions = [...this.sessions.values()]
      .filter((session) => session.clientId === auth.record.clientId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => this.publicSession(session));
    await this.touchClient(auth.record.clientId, false);
    this.sendJson(res, 200, { sessions });
  }

  private async handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const parsed = this.validateSessionCreateRequest(await this.readJsonOptional(req), auth.record);
    if (!parsed.ok) {
      this.sendError(req, res, this.statusForError(parsed.code), parsed.code, parsed.message);
      return;
    }
    const created = await this.createSessionForClient(auth.record, parsed.body);
    if (!created.ok) {
      this.sendError(req, res, this.statusForError(created.code), created.code, created.message);
      return;
    }
    await this.touchClient(auth.record.clientId, false);
    this.sendJson(res, 201, { ok: true, session: this.publicSession(created.value) });
  }

  private async handleGetSession(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);
    const session = this.getClientSession(sessionId, auth.record);
    if (!session) {
      this.sendError(req, res, 404, "session_not_found", "Session was not found.");
      return;
    }
    await this.touchClient(auth.record.clientId, false);
    this.sendJson(res, 200, { session: this.publicSession(session) });
  }

  private async handleDeleteSession(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);
    const session = this.getClientSession(sessionId, auth.record);
    if (!session) {
      this.sendError(req, res, 404, "session_not_found", "Session was not found.");
      return;
    }
    if (this.activeSessionIds.has(session.sessionId)) {
      this.sendError(req, res, 429, "session_busy", "Session already has an active request.");
      return;
    }
    await this.deleteSession(session.sessionId);
    await this.touchClient(auth.record.clientId, false);
    this.sendJson(res, 200, { ok: true });
  }

  private async createSessionForClient(
    record: PairingRecord,
    body: {
      provider: ProviderId;
      mode: SessionMode;
      workingDirectory?: string;
      messages: ChatMessage[];
    },
  ): Promise<ParseResult<ChatSession>> {
    if (!record.allowedProviders.includes(body.provider)) {
      return { ok: false, code: "provider_not_allowed", message: "Provider is not allowed for this client." };
    }
    const modeResult = this.resolveSessionMode(body.mode, body.provider);
    if (!modeResult.ok) {
      return modeResult;
    }
    if (modeResult.value === "native" && body.messages.length > 0) {
      return {
        ok: false,
        code: "invalid_request",
        message: "Native sessions do not accept initial messages; send the first turn via session chat.",
      };
    }
    const workingDirectoryResult = await this.resolveSessionWorkingDirectory(body.workingDirectory, record);
    if (!workingDirectoryResult.ok) {
      return workingDirectoryResult;
    }

    this.expireSessions();
    const clientSessions = [...this.sessions.values()].filter((session) => session.clientId === record.clientId);
    if (clientSessions.length >= this.maxSessionsPerClient) {
      return { ok: false, code: "too_many_sessions", message: "Client exceeded the active session limit." };
    }

    const now = nowIso();
    const expiresAtMs = Date.now() + this.sessionTtlMs;
    const messages = modeResult.value === "local" ? this.trimSessionMessages(body.messages) : [];
    const nativeProviderSessionId = modeResult.value === "native"
      ? this.providers.createNativeSession(body.provider)
      : null;
    const nativeSessionState: NativeSessionState | null = modeResult.value === "native"
      ? nativeProviderSessionId ? "ready" : "pending"
      : null;
    const session: ChatSession = {
      sessionId: randomToken("session"),
      clientId: record.clientId,
      provider: body.provider,
      mode: modeResult.value,
      workingDirectory: workingDirectoryResult.value,
      nativeSessionState,
      nativeProviderSessionId,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      messageCount: messages.length,
      messages,
    };
    this.sessions.set(session.sessionId, session);
    this.scheduleSessionExpiry(session);
    await this.store.upsertSession(this.sessionMetadata(session));
    return { ok: true, value: session };
  }

  private async handleSessionChat(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const session = this.getClientSession(sessionId, auth.record);
    if (!session) {
      this.sendError(req, res, 404, "session_not_found", "Session was not found.");
      return;
    }

    const parsed = this.validateSessionChatRequest(await this.readJson(req));
    if (!parsed.ok) {
      this.sendError(req, res, this.statusForError(parsed.code), parsed.code, parsed.message);
      return;
    }

    await this.runSessionChat(req, res, auth.record, session, parsed.body);
  }

  private async runSessionChat(
    req: IncomingMessage,
    res: ServerResponse,
    record: PairingRecord,
    session: ChatSession,
    body: Required<SessionChatRequest>,
  ): Promise<void> {
    if (body.stream && !record.capabilities.includes("llm.stream")) {
      this.sendError(req, res, 403, "missing_capability", "Client is not allowed to stream.");
      return;
    }
    if (!record.allowedProviders.includes(session.provider)) {
      this.sendError(req, res, 403, "provider_not_allowed", "Provider is not allowed for this client.");
      return;
    }
    if (session.mode === "native" && session.nativeSessionState === "unavailable") {
      this.sendError(
        req,
        res,
        this.statusForError("native_session_unavailable"),
        "native_session_unavailable",
        "Native session mapping is unavailable.",
      );
      return;
    }

    const clientActive = [...this.activeRequests.values()].filter(
      (active) => active.clientId === record.clientId,
    ).length;
    if (clientActive >= record.maxConcurrentRequests) {
      this.sendError(req, res, 429, "concurrency_limit", "Client exceeded concurrent request limit.");
      return;
    }
    if (this.activeSessionIds.has(session.sessionId)) {
      this.sendError(req, res, 429, "session_busy", "Session already has an active request.");
      return;
    }

    const requestMessages = session.mode === "native"
      ? body.messages
      : this.trimSessionMessages(
        [...session.messages, ...body.messages],
        body.messages.length,
      );
    this.touchSession(session);
    await this.store.upsertSession(this.sessionMetadata(session));
    const requestId = randomToken("req");
    const startedAt = nowIso();
    const startedMs = Date.now();
    const inputChars = requestMessages.reduce((sum, message) => sum + message.content.length, 0);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("timeout"));
    }, record.maxRequestDurationMs);

    let outputChars = 0;
    let status: RequestLogSummary["status"] = "success";
    let errorCode: string | null = null;
    let completed = false;
    const active: ActiveRequest = {
      requestId,
      clientId: record.clientId,
      provider: session.provider,
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
    this.activeSessionIds.add(session.sessionId);
    res.on("close", onClientClose);
    this.emitAdminEvent("request.started", { requestId, clientId: record.clientId, provider: session.provider });

    try {
      const spawned = session.mode === "native"
        ? await this.providers.spawnNativeSessionChat(session.provider, requestMessages, {
          requestId,
          signal: controller.signal,
          workingDirectory: session.workingDirectory,
        }, {
          nativeProviderSessionId: session.nativeProviderSessionId,
          stream: body.stream,
        })
        : await this.providers.spawnChat(session.provider, requestMessages, {
          requestId,
          signal: controller.signal,
          workingDirectory: session.workingDirectory,
        });
      const { adapter, handle } = spawned;
      const nativeProviderSessionId = "nativeProviderSessionId" in spawned
        ? spawned.nativeProviderSessionId
        : null;

      active.cancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error("cancelled"));
        }
        handle.cancel();
      };
      if (controller.signal.aborted) {
        handle.cancel();
      }

      const chunks: string[] = [];
      if (body.stream) {
        const done = await this.respondStream(res, adapter.parseOutput(handle), handle.done, {
          requestId,
          provider: session.provider,
          start: {
            sessionId: session.sessionId,
            session: this.publicSession(session),
          },
          onChunk: (chunk) => {
            chunks.push(chunk);
            outputChars += chunk.length;
          },
          cancel: active.cancel,
          beforeDone: async (finished) => {
            if (finished.finishReason === "stop") {
              if (session.mode === "native") {
                await this.updateNativeSessionAfterStop(session, body.messages, nativeProviderSessionId);
                this.providers.recordNativeSessionSuccess(session.provider);
              } else {
                if (this.sessions.has(session.sessionId)) {
                  this.updateSessionMessages(session, requestMessages, chunks.join(""));
                  await this.store.upsertSession(this.sessionMetadata(session));
                }
                this.providers.recordSuccess(session.provider);
              }
            }
            return {
              sessionId: session.sessionId,
              session: this.publicSession(session),
            };
          },
        });
        if (done.finishReason === "cancelled") {
          status = "cancelled";
        } else if (done.finishReason === "timeout") {
          status = "timeout";
        }
        completed = true;
      } else {
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
        if (done.finishReason === "stop") {
          if (session.mode === "native") {
            await this.updateNativeSessionAfterStop(session, body.messages, nativeProviderSessionId);
            this.providers.recordNativeSessionSuccess(session.provider);
          } else {
            if (this.sessions.has(session.sessionId)) {
              this.updateSessionMessages(session, requestMessages, chunks.join(""));
              await this.store.upsertSession(this.sessionMetadata(session));
            }
            this.providers.recordSuccess(session.provider);
          }
        }
        this.sendJson(res, 200, {
          requestId,
          sessionId: session.sessionId,
          provider: session.provider,
          content: chunks.join(""),
          finishReason: done.finishReason,
          session: this.publicSession(session),
        });
      }
    } catch (error) {
      const safe = clientSafeError(error);
      errorCode = safe.code;
      this.providers.recordFailure(session.provider, safe.code, safe.message);
      if (
        session.mode === "native"
        && (safe.code === "native_session_unsupported" || safe.code === "native_session_unavailable")
      ) {
        session.nativeSessionState = "unavailable";
        session.nativeProviderSessionId = null;
        this.touchSession(session);
        if (this.sessions.has(session.sessionId)) {
          await this.store.upsertSession(this.sessionMetadata(session));
        }
      }
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
      this.activeSessionIds.delete(session.sessionId);
      this.expireSessions();
      await this.touchClient(record.clientId, true);
      await this.writeRequestLog({
        requestId,
        clientId: record.clientId,
        clientName: record.clientName,
        provider: session.provider,
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

  private async handleOpenAI(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/openai/v1/models") {
      const auth = await this.authenticate(req, res, "llm.listProviders");
      if (!auth) {
        return;
      }
      this.setCors(req, res, "sensitive", auth.record);
      const statuses = await this.providers.listStatuses();
      const models = statuses
        .filter((status) => status.ready && auth.record.allowedProviders.includes(status.id))
        .flatMap((status) => {
          const providerModels = status.models?.length
            ? status.models.map((model) => `${status.id}:${model}`)
            : [status.id];
          return providerModels.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "local-cli-agent",
          }));
        });
      await this.touchClient(auth.record.clientId, false);
      this.sendJson(res, 200, { object: "list", data: models });
      return;
    }

    if (req.method === "POST" && pathname === "/openai/v1/chat/completions") {
      await this.handleOpenAIChat(req, res);
      return;
    }

    this.sendError(req, res, 404, "not_found", "OpenAI-compatible route not found.");
  }

  private async handleOpenAIChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const parsed = this.validateOpenAIChatRequest(await this.readJson(req), auth.record);
    if (!parsed.ok) {
      this.sendOpenAIError(res, this.statusForError(parsed.code), parsed.code, parsed.message);
      return;
    }
    if (parsed.body.stream && !auth.record.capabilities.includes("llm.stream")) {
      this.sendOpenAIError(res, 403, "missing_capability", "Client is not allowed to stream.");
      return;
    }
    if (!auth.record.allowedProviders.includes(parsed.provider)) {
      this.sendOpenAIError(res, 403, "provider_not_allowed", "Provider is not allowed for this client.");
      return;
    }

    const clientActive = [...this.activeRequests.values()].filter(
      (active) => active.clientId === auth.record.clientId,
    ).length;
    if (clientActive >= auth.record.maxConcurrentRequests) {
      this.sendOpenAIError(res, 429, "concurrency_limit", "Client exceeded concurrent request limit.");
      return;
    }

    const requestId = randomToken("req");
    const completionId = `chatcmpl_${requestId}`;
    const startedAt = nowIso();
    const startedMs = Date.now();
    const created = Math.floor(startedMs / 1000);
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
      provider: parsed.provider,
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
    this.emitAdminEvent("request.started", { requestId, clientId: auth.record.clientId, provider: parsed.provider });

    try {
      const { adapter, handle } = await this.providers.spawnChat(parsed.provider, parsed.body.messages, {
        requestId,
        signal: controller.signal,
      }, { model: parsed.model });

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
        const done = await this.respondOpenAIStream(res, adapter.parseOutput(handle), handle.done, {
          id: completionId,
          created,
          model: parsed.body.model,
          onChunk: (chunk) => {
            outputChars += chunk.length;
          },
        });
        status = done.finishReason === "cancelled"
          ? "cancelled"
          : done.finishReason === "timeout"
            ? "timeout"
            : "success";
        if (done.finishReason === "stop") {
          this.providers.recordSuccess(parsed.provider);
        }
        completed = true;
      } else {
        const chunks: string[] = [];
        for await (const chunk of adapter.parseOutput(handle)) {
          chunks.push(chunk);
          outputChars += chunk.length;
        }
        const done = await handle.done;
        status = done.finishReason === "cancelled"
          ? "cancelled"
          : done.finishReason === "timeout"
            ? "timeout"
            : "success";
        if (done.finishReason === "stop") {
          this.providers.recordSuccess(parsed.provider);
        }
        completed = true;
        this.sendJson(res, 200, {
          id: completionId,
          object: "chat.completion",
          created,
          model: parsed.body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: chunks.join("") },
            finish_reason: this.openAIFinishReason(done.finishReason),
          }],
          usage: {
            prompt_chars: inputChars,
            completion_chars: outputChars,
            total_chars: inputChars + outputChars,
          },
        });
      }
    } catch (error) {
      const safe = clientSafeError(error);
      errorCode = safe.code;
      this.providers.recordFailure(parsed.provider, safe.code, safe.message);
      status = safe.code === "request_timeout" || controller.signal.reason?.message === "timeout"
        ? "timeout"
        : controller.signal.aborted
          ? "cancelled"
          : "error";

      if (!res.headersSent) {
        this.sendOpenAIError(res, this.statusForError(safe.code), safe.code, safe.message);
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: this.openAIErrorBody(safe.code, safe.message).error })}\n\n`);
        res.write("data: [DONE]\n\n");
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
        provider: parsed.provider,
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

  private validateOpenAIChatRequest(
    value: unknown,
    record: PairingRecord,
  ): {
    ok: true;
    provider: ProviderId;
    model?: string;
    body: { model: string; stream: boolean; messages: ChatMessage[] };
  } | { ok: false; code: string; message: string } {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "Request body must be a JSON object." };
    }
    const modelId = asString(value.model);
    if (!modelId) {
      return { ok: false, code: "invalid_model", message: "model is required." };
    }
    const parsedModel = this.parseOpenAIModel(modelId, record.defaultProvider);
    if (!parsedModel) {
      return { ok: false, code: "invalid_model", message: "model is invalid." };
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
      const content = typeof item.content === "string" ? item.content : null;
      if (content === null) {
        return { ok: false, code: "invalid_message_content", message: "message content must be a string." };
      }
      totalChars += content.length;
      messages.push({ role: item.role as ChatMessage["role"], content });
    }
    if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
      return { ok: false, code: "request_too_large", message: "Total message content is too large." };
    }

    return {
      ok: true,
      provider: parsedModel.provider,
      model: parsedModel.model,
      body: {
        model: modelId,
        stream: typeof value.stream === "boolean" ? value.stream : false,
        messages,
      },
    };
  }

  private parseOpenAIModel(modelId: string, defaultProvider: ProviderId): { provider: ProviderId; model?: string } | null {
    if (isProviderId(modelId)) {
      return { provider: modelId };
    }
    const separator = modelId.indexOf(":");
    if (separator < 0) {
      return isProviderId(defaultProvider) ? { provider: defaultProvider, model: modelId } : null;
    }
    const provider = modelId.slice(0, separator);
    const model = modelId.slice(separator + 1);
    if (!isProviderId(provider) || !model) {
      return null;
    }
    return { provider, model };
  }

  private async respondOpenAIStream(
    res: ServerResponse,
    output: AsyncIterable<string>,
    done: Promise<{ finishReason: string }>,
    options: {
      id: string;
      created: number;
      model: string;
      onChunk: (chunk: string) => void;
    },
  ): Promise<{ finishReason: string }> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const base = {
      id: options.id,
      object: "chat.completion.chunk",
      created: options.created,
      model: options.model,
    };
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`);

    for await (const chunk of output) {
      options.onChunk(chunk);
      res.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`);
    }
    const finished = await done;
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: this.openAIFinishReason(finished.finishReason) }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return finished;
  }

  private openAIFinishReason(finishReason: string): string {
    if (finishReason === "cancelled") {
      return "stop";
    }
    if (finishReason === "timeout") {
      return "length";
    }
    return "stop";
  }

  private openAIErrorBody(code: string, message: string): { error: { message: string; type: string; code: string } } {
    return {
      error: {
        message,
        type: "local_cli_agent_error",
        code,
      },
    };
  }

  private sendOpenAIError(res: ServerResponse, statusCode: number, code: string, message: string): void {
    this.sendJson(res, statusCode, this.openAIErrorBody(code, message));
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticate(req, res, "llm.chat");
    if (!auth) {
      return;
    }
    this.setCors(req, res, "sensitive", auth.record);

    const parsed = this.validateChatRequest(await this.readJson(req));
    if (!parsed.ok) {
      this.sendError(req, res, this.statusForError(parsed.code), parsed.code, parsed.message);
      return;
    }

    if (parsed.body.stream && !auth.record.capabilities.includes("llm.stream")) {
      this.sendError(req, res, 403, "missing_capability", "Client is not allowed to stream.");
      return;
    }

    if (parsed.body.session) {
      if (parsed.body.session.kind === "existing") {
        const session = this.getClientSession(parsed.body.session.sessionId, auth.record);
        if (!session) {
          this.sendError(req, res, 404, "session_not_found", "Session was not found.");
          return;
        }
        if (parsed.body.provider !== undefined && parsed.body.provider !== session.provider) {
          this.sendError(req, res, 400, "invalid_request", "provider must match the existing session provider.");
          return;
        }
        await this.runSessionChat(req, res, auth.record, session, {
          stream: parsed.body.stream,
          messages: parsed.body.messages,
        });
        return;
      }

      const provider = parsed.body.provider ?? auth.record.defaultProvider;
      const clientActive = [...this.activeRequests.values()].filter(
        (active) => active.clientId === auth.record.clientId,
      ).length;
      if (clientActive >= auth.record.maxConcurrentRequests) {
        this.sendError(req, res, 429, "concurrency_limit", "Client exceeded concurrent request limit.");
        return;
      }
      const created = await this.createSessionForClient(auth.record, {
        provider,
        mode: parsed.body.session.mode,
        workingDirectory: parsed.body.session.workingDirectory,
        messages: [],
      });
      if (!created.ok) {
        this.sendError(req, res, this.statusForError(created.code), created.code, created.message);
        return;
      }
      await this.runSessionChat(req, res, auth.record, created.value, {
        stream: parsed.body.stream,
        messages: parsed.body.messages,
      });
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
        if (done.finishReason === "stop") {
          this.providers.recordSuccess(provider);
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
        if (done.finishReason === "stop") {
          this.providers.recordSuccess(provider);
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
      this.providers.recordFailure(provider, safe.code, safe.message);
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
      start?: Partial<StreamEvent>;
      onChunk: (chunk: string) => void;
      cancel: () => void;
      beforeDone?: (finished: { finishReason: string }) => Promise<Partial<StreamEvent>> | Partial<StreamEvent>;
    },
  ): Promise<{ finishReason: string }> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(sseData({
      type: "start",
      requestId: options.requestId,
      provider: options.provider,
      ...options.start,
    }));

    for await (const chunk of output) {
      options.onChunk(chunk);
      res.write(sseData({ type: "delta", content: chunk }));
    }
    const finished = await done;
    const doneExtra = options.beforeDone ? await options.beforeDone(finished) : {};
    res.write(sseData({
      type: "done",
      finishReason: finished.finishReason as never,
      ...doneExtra,
    }));
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

  private validateSessionCreateRequest(
    value: unknown,
    record: PairingRecord,
  ): {
    ok: true;
    body: {
      provider: ProviderId;
      mode: SessionMode;
      workingDirectory?: string;
      messages: ChatMessage[];
    };
  } | { ok: false; code: string; message: string } {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "Request body must be a JSON object." };
    }
    const provider = value.provider === undefined
      ? record.defaultProvider
      : isProviderId(value.provider)
        ? value.provider
        : null;
    if (!provider) {
      return { ok: false, code: "invalid_provider", message: "provider is invalid." };
    }
    const mode = value.mode === undefined
      ? "auto"
      : ["auto", "native", "local"].includes(String(value.mode))
        ? value.mode as SessionMode
        : null;
    if (!mode) {
      return { ok: false, code: "invalid_request", message: "mode must be auto, native, or local." };
    }
    if (value.workingDirectory !== undefined && typeof value.workingDirectory !== "string") {
      return { ok: false, code: "invalid_working_directory", message: "workingDirectory must be a string." };
    }

    const parsedMessages = this.parseMessages(value.messages === undefined ? [] : value.messages, 0);
    if (!parsedMessages.ok) {
      return parsedMessages;
    }
    return {
      ok: true,
      body: {
        provider,
        mode,
        workingDirectory: value.workingDirectory,
        messages: parsedMessages.value,
      },
    };
  }

  private validateSessionChatRequest(
    value: unknown,
  ): { ok: true; body: Required<SessionChatRequest> } | { ok: false; code: string; message: string } {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "Request body must be a JSON object." };
    }
    if (value.provider !== undefined) {
      return { ok: false, code: "invalid_request", message: "Session provider is fixed at creation time." };
    }

    const parsedMessages = this.parseMessages(value.messages, 1);
    if (!parsedMessages.ok) {
      return parsedMessages;
    }
    return {
      ok: true,
      body: {
        stream: typeof value.stream === "boolean" ? value.stream : false,
        messages: parsedMessages.value,
      },
    };
  }

  private resolveSessionMode(
    requestedMode: SessionMode,
    provider: ProviderId,
  ): ParseResult<EffectiveSessionMode> {
    const supportsNative = this.providers.supportsNativeSessions(provider);
    if (requestedMode === "native" && !supportsNative) {
      return {
        ok: false,
        code: "native_session_unsupported",
        message: "Provider does not support stable native sessions.",
      };
    }
    return {
      ok: true,
      value: requestedMode === "local" ? "local" : supportsNative ? "native" : "local",
    };
  }

  private async resolveSessionWorkingDirectory(
    requestedWorkingDirectory: string | undefined,
    record: PairingRecord,
  ): Promise<ParseResult<string>> {
    if (requestedWorkingDirectory !== undefined && record.origin !== null) {
      return {
        ok: false,
        code: "working_directory_not_allowed",
        message: "workingDirectory is only available to no-origin local clients.",
      };
    }

    const candidate = requestedWorkingDirectory ?? process.cwd();
    if (!isAbsolute(candidate)) {
      return {
        ok: false,
        code: "invalid_working_directory",
        message: "workingDirectory must be an absolute path.",
      };
    }

    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isDirectory()) {
        return {
          ok: false,
          code: "invalid_working_directory",
          message: "workingDirectory must be an existing directory.",
        };
      }
      return { ok: true, value: resolved };
    } catch {
      return {
        ok: false,
        code: "invalid_working_directory",
        message: "workingDirectory must be an existing absolute directory.",
      };
    }
  }

  private parseMessages(value: unknown, minCount: number): ParseResult<ChatMessage[]> {
    if (!Array.isArray(value) || value.length < minCount || value.length > 50) {
      const minText = minCount === 0 ? "0" : String(minCount);
      return { ok: false, code: "invalid_messages", message: `messages must contain ${minText}-50 items.` };
    }

    const messages: ChatMessage[] = [];
    let totalChars = 0;
    for (const item of value) {
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

    return { ok: true, value: messages };
  }

  private validateChatRequest(
    value: unknown,
  ): { ok: true; body: ParsedChatRequest } | { ok: false; code: string; message: string } {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "Request body must be a JSON object." };
    }
    const parsedMessages = this.parseMessages(value.messages, 1);
    if (!parsedMessages.ok) {
      return parsedMessages;
    }

    const provider = value.provider === undefined
      ? undefined
      : isProviderId(value.provider)
        ? value.provider
        : null;
    if (provider === null) {
      return { ok: false, code: "invalid_provider", message: "provider is invalid." };
    }

    let session: ParsedChatSessionSpec | undefined;
    if (value.session !== undefined) {
      const parsedSession = this.parseChatSessionSpec(value.session);
      if (!parsedSession.ok) {
        return parsedSession;
      }
      session = parsedSession.value;
    }

    return {
      ok: true,
      body: {
        provider,
        stream: typeof value.stream === "boolean" ? value.stream : false,
        messages: parsedMessages.value,
        session,
      },
    };
  }

  private parseChatSessionSpec(value: unknown): ParseResult<ParsedChatSessionSpec> {
    if (!isObject(value)) {
      return { ok: false, code: "invalid_request", message: "session must be a JSON object." };
    }

    const wantsCreate = value.create === true;
    const hasCreate = value.create !== undefined;
    const sessionId = value.id;
    const hasId = sessionId !== undefined;
    if (hasCreate && typeof value.create !== "boolean") {
      return { ok: false, code: "invalid_request", message: "session.create must be a boolean." };
    }
    if (wantsCreate && hasId) {
      return { ok: false, code: "invalid_request", message: "session.create and session.id are mutually exclusive." };
    }
    if (!wantsCreate && !hasId) {
      return { ok: false, code: "invalid_request", message: "session must include create: true or id." };
    }

    if (hasId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "invalid_request", message: "session.id must be a non-empty string." };
      }
      if (value.mode !== undefined || value.workingDirectory !== undefined) {
        return {
          ok: false,
          code: "invalid_request",
          message: "session.mode and session.workingDirectory are only valid with session.create.",
        };
      }
      return { ok: true, value: { kind: "existing", sessionId } };
    }

    const mode = value.mode === undefined
      ? "auto"
      : ["auto", "native", "local"].includes(String(value.mode))
        ? value.mode as SessionMode
        : null;
    if (!mode) {
      return { ok: false, code: "invalid_request", message: "session.mode must be auto, native, or local." };
    }
    if (value.workingDirectory !== undefined && typeof value.workingDirectory !== "string") {
      return { ok: false, code: "invalid_working_directory", message: "session.workingDirectory must be a string." };
    }
    return {
      ok: true,
      value: {
        kind: "create",
        mode,
        workingDirectory: value.workingDirectory,
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

  private publicPairingRecord(record: PairingRecord): PublicPairingRecord {
    const { credentialHash: _credentialHash, ...publicRecord } = record;
    return publicRecord;
  }

  private publicSession(session: ChatSession): ChatSessionSummary {
    return {
      sessionId: session.sessionId,
      clientId: session.clientId,
      provider: session.provider,
      mode: session.mode,
      workingDirectory: session.workingDirectory,
      nativeSessionState: session.nativeSessionState,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      messageCount: session.messageCount,
    };
  }

  private sessionMetadata(session: ChatSession): ChatSessionMetadata {
    return {
      sessionId: session.sessionId,
      clientId: session.clientId,
      provider: session.provider,
      mode: session.mode,
      workingDirectory: session.workingDirectory,
      nativeSessionState: session.nativeSessionState,
      nativeProviderSessionId: session.nativeProviderSessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      messageCount: session.messageCount,
    };
  }

  private async restoreSessions(): Promise<void> {
    await this.store.deleteExpiredSessions(nowIso());
    for (const timer of this.sessionExpiryTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionExpiryTimers.clear();
    this.sessions.clear();

    const clientIds = new Set((await this.store.listPairings()).map((record) => record.clientId));
    for (const metadata of await this.store.listSessions()) {
      if (!clientIds.has(metadata.clientId)) {
        await this.store.deleteSession(metadata.sessionId);
        continue;
      }
      const expiresAtMs = Date.parse(metadata.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        await this.store.deleteSession(metadata.sessionId);
        continue;
      }
      const restoredMetadata: ChatSessionMetadata = metadata.mode === "local"
        ? {
          ...metadata,
          messageCount: 0,
          nativeSessionState: null,
          nativeProviderSessionId: null,
        }
        : metadata;
      const messages: ChatMessage[] = [];
      const session: ChatSession = {
        ...restoredMetadata,
        messages,
        expiresAtMs,
      };
      this.sessions.set(session.sessionId, session);
      this.scheduleSessionExpiry(session);
      if (metadata.mode === "local" && metadata.messageCount !== 0) {
        await this.store.upsertSession(this.sessionMetadata(session));
      }
    }
  }

  private getClientSession(sessionId: string, record: PairingRecord): ChatSession | null {
    this.expireSessions();
    const session = this.sessions.get(sessionId);
    if (!session || session.clientId !== record.clientId) {
      return null;
    }
    return session;
  }

  private updateSessionMessages(session: ChatSession, requestMessages: ChatMessage[], assistantContent: string): void {
    session.messages = this.trimSessionMessages(
      [...requestMessages, { role: "assistant", content: assistantContent }],
      1,
    );
    session.messageCount = session.messages.length;
    this.touchSession(session);
  }

  private async updateNativeSessionAfterStop(
    session: ChatSession,
    turnMessages: ChatMessage[],
    nativeProviderSessionId: Promise<string | null> | null,
  ): Promise<void> {
    const providerSessionId = nativeProviderSessionId ? await nativeProviderSessionId : session.nativeProviderSessionId;
    if (!providerSessionId) {
      session.nativeProviderSessionId = null;
      session.nativeSessionState = "unavailable";
      this.touchSession(session);
      if (this.sessions.has(session.sessionId)) {
        await this.store.upsertSession(this.sessionMetadata(session));
      }
      throw new ProviderExecutionError(
        "native_session_unsupported",
        "Provider did not report a resumable native session id.",
      );
    }

    session.nativeProviderSessionId = providerSessionId;
    session.nativeSessionState = "ready";
    session.messageCount += turnMessages.length + 1;
    this.touchSession(session);
    if (this.sessions.has(session.sessionId)) {
      await this.store.upsertSession(this.sessionMetadata(session));
    }
  }

  private touchSession(session: ChatSession): void {
    const nowMs = Date.now();
    session.updatedAt = new Date(nowMs).toISOString();
    session.expiresAtMs = nowMs + this.sessionTtlMs;
    session.expiresAt = new Date(session.expiresAtMs).toISOString();
    this.scheduleSessionExpiry(session);
  }

  private scheduleSessionExpiry(session: ChatSession): void {
    const existing = this.sessionExpiryTimers.get(session.sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      if (!this.activeSessionIds.has(session.sessionId)) {
        this.deleteSessionBestEffort(session.sessionId);
      }
    }, Math.max(0, session.expiresAtMs - Date.now()));
    timer.unref?.();
    this.sessionExpiryTimers.set(session.sessionId, timer);
  }

  private deleteSessionLocal(sessionId: string): void {
    const timer = this.sessionExpiryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sessionExpiryTimers.delete(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    this.deleteSessionLocal(sessionId);
    await this.store.deleteSession(sessionId);
  }

  private deleteSessionBestEffort(sessionId: string): void {
    this.deleteSessionLocal(sessionId);
    void this.store.deleteSession(sessionId).catch(() => undefined);
  }

  private async deleteSessionsForClient(clientId: string): Promise<void> {
    const sessionIds: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.clientId === clientId) {
        this.deleteSessionLocal(session.sessionId);
        sessionIds.push(session.sessionId);
      }
    }
    await Promise.all(sessionIds.map((sessionId) => this.store.deleteSession(sessionId)));
  }

  private expireSessions(): void {
    const nowMs = Date.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAtMs <= nowMs && !this.activeSessionIds.has(session.sessionId)) {
        this.deleteSessionBestEffort(session.sessionId);
      }
    }
  }

  private trimSessionMessages(messages: ChatMessage[], protectedTailCount = 0): ChatMessage[] {
    const trimmed = [...messages];
    while (
      trimmed.length > 0
      && (trimmed.length > 50 || this.totalMessageChars(trimmed) > MAX_TOTAL_CONTENT_CHARS)
    ) {
      const protectedStart = Math.max(0, trimmed.length - protectedTailCount);
      let removeIndex = -1;
      for (let index = 0; index < protectedStart; index += 1) {
        if (!(index === 0 && trimmed[index].role === "system")) {
          removeIndex = index;
          break;
        }
      }
      if (removeIndex < 0 && protectedStart > 0) {
        removeIndex = 0;
      }
      if (removeIndex < 0) {
        break;
      }
      trimmed.splice(removeIndex, 1);
    }
    return trimmed;
  }

  private totalMessageChars(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + message.content.length, 0);
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
    return this.readJson(req);
  }

  private statusForError(code: string): number {
    switch (code) {
      case "provider_not_found":
      case "provider_not_installed":
      case "provider_not_authenticated":
      case "provider_not_ready":
      case "provider_secure_input_unsupported":
      case "native_session_unsupported":
      case "native_session_unavailable":
      case "invalid_json":
      case "invalid_messages":
      case "invalid_message_role":
      case "invalid_message_content":
      case "invalid_provider":
      case "invalid_model":
      case "invalid_working_directory":
      case "invalid_request":
        return 400;
      case "provider_not_allowed":
      case "working_directory_not_allowed":
        return 403;
      case "session_not_found":
        return 404;
      case "request_too_large":
        return 413;
      case "concurrency_limit":
      case "pairing_rate_limited":
      case "too_many_pair_requests":
      case "too_many_sessions":
      case "session_busy":
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
    } else if (pathname.startsWith("/admin/")) {
      this.setAdminCors(req, res);
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

  private setAdminCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = asString(req.headers.origin);
    if (isLoopbackOrigin(origin)) {
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
