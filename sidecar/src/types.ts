export type Capability = "llm.chat" | "llm.stream" | "llm.listProviders";

export const CAPABILITIES: Capability[] = [
  "llm.chat",
  "llm.stream",
  "llm.listProviders",
];

export type ClientType =
  | "figma-plugin"
  | "browser-extension"
  | "web-app"
  | "desktop-app"
  | "vscode-extension"
  | "cli-tool"
  | "unknown";

export const CLIENT_TYPES: ClientType[] = [
  "figma-plugin",
  "browser-extension",
  "web-app",
  "desktop-app",
  "vscode-extension",
  "cli-tool",
  "unknown",
];

export type ProviderId = "claude" | "codex" | "gemini" | "ollama" | "fake";

export type Role = "system" | "user" | "assistant";

export type FinishReason = "stop" | "cancelled" | "timeout" | "error";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface PairingRecord {
  clientId: string;
  clientName: string;
  clientType: ClientType;
  origin: string | null;
  credentialHash: string;
  capabilities: Capability[];
  allowedProviders: ProviderId[];
  defaultProvider: ProviderId;
  maxConcurrentRequests: number;
  maxRequestDurationMs: number;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
}

export type PairRequestStatus = "pending" | "allowed" | "denied" | "expired";

export interface PairRequest {
  requestId: string;
  clientName: string;
  clientType: ClientType;
  origin: string | null;
  requestedCapabilities: Capability[];
  requestedProviders: ProviderId[];
  clientNonce: string;
  status: PairRequestStatus;
  createdAt: string;
  expiresAt: string;
  clientId?: string;
  credential?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  installed: boolean;
  ready: boolean;
  reason?: ProviderReadinessReason;
  version?: string | null;
  models?: string[];
  message?: string;
  nativeSession?: ProviderNativeSessionStatus;
}

export type ProviderReadinessReason =
  | "ready"
  | "not_installed"
  | "not_authenticated"
  | "authentication_unknown"
  | "not_ready"
  | "secure_input_unsupported"
  | "native_session_unverified"
  | "native_session_unsupported"
  | "execution_failed"
  | "timeout"
  | "cancelled";

export interface ProviderNativeSessionStatus {
  supported: boolean;
  state: "unsupported" | "unverified" | "ready" | "unavailable";
  reason?: string;
}

export type ProviderInputChannel =
  | { type: "stdin"; content: string }
  | { type: "none" };

export interface ProviderExecutionPlan {
  command: string;
  args: string[];
  input: ProviderInputChannel;
}

export interface ProviderDiagnostic {
  id: ProviderId;
  name: string;
  status: ProviderStatus;
  command?: string;
  commandPath?: string | null;
  version?: string | null;
  lastErrorCode?: string | null;
}

export interface DiagnosticsSnapshot {
  ok: true;
  service: string;
  version: string;
  status: "running";
  address: string;
  uptimeMs: number;
  activeRequests: number;
  pairedClients: number;
  pendingPairRequests: number;
  restartCount?: number;
  runtime: {
    nodeVersion: string;
    execPath: string;
    platform: string;
    arch: string;
    pathEntries: string[];
  };
  providers: ProviderDiagnostic[];
  recentErrors: Array<{
    requestId: string;
    provider: ProviderId;
    status: RequestLogSummary["status"];
    errorCode: string | null;
    endedAt: string;
  }>;
}

export interface ChatRequest {
  provider?: ProviderId;
  stream?: boolean;
  messages: ChatMessage[];
  session?: ChatRequestSession;
}

export type ChatRequestSession =
  | {
    create: true;
    mode?: SessionMode;
    workingDirectory?: string;
  }
  | {
    id: string;
  };

export type SessionMode = "auto" | "native" | "local";
export type EffectiveSessionMode = "native" | "local";
export type NativeSessionState = "pending" | "ready" | "unavailable";

export interface SessionCreateRequest {
  provider?: ProviderId;
  mode?: SessionMode;
  workingDirectory?: string;
  messages?: ChatMessage[];
}

export interface SessionChatRequest {
  stream?: boolean;
  messages: ChatMessage[];
}

export interface ChatSessionSummary {
  sessionId: string;
  clientId: string;
  provider: ProviderId;
  mode: EffectiveSessionMode;
  workingDirectory: string;
  nativeSessionState: NativeSessionState | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageCount: number;
}

export interface ChatSessionMetadata extends ChatSessionSummary {
  nativeProviderSessionId: string | null;
}

export interface StreamEvent {
  type: "start" | "delta" | "done" | "error";
  requestId?: string;
  provider?: ProviderId;
  sessionId?: string;
  session?: ChatSessionSummary;
  content?: string;
  finishReason?: FinishReason;
  message?: string;
  code?: string;
}

export interface RequestLogSummary {
  requestId: string;
  clientId: string;
  clientName: string;
  provider: ProviderId;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "success" | "error" | "cancelled" | "timeout";
  inputChars: number;
  outputChars: number;
  errorCode: string | null;
}

export interface AgentSettings {
  host: "localhost";
  port: number;
  startAtLogin: boolean;
  logRetentionDays: number;
  logsEnabled: boolean;
}

export interface PublicError {
  ok: false;
  code: string;
  message: string;
}

export interface ProviderInput {
  messages: ChatMessage[];
  prompt: string;
  model?: string;
}

export interface ProviderRunContext {
  requestId: string;
  signal: AbortSignal;
  workingDirectory?: string;
}

export interface ProviderHandle {
  output: AsyncIterable<string>;
  done: Promise<{ finishReason: FinishReason }>;
  cancel: () => void;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  supportsNativeSessions?: boolean;
  detect: () => Promise<ProviderStatus>;
  diagnostics?: () => Promise<ProviderDiagnostic>;
  getVersion: () => Promise<string | null>;
  getModels: () => Promise<string[]>;
  buildInput: (messages: ChatMessage[]) => Promise<ProviderInput>;
  spawn: (input: ProviderInput, context: ProviderRunContext) => Promise<ProviderHandle>;
  createNativeSession?: () => string | null;
  sendNativeSessionMessage?: (
    input: ProviderInput,
    context: ProviderRunContext,
    session: {
      nativeProviderSessionId: string | null;
      stream: boolean;
    },
  ) => Promise<{
    handle: ProviderHandle;
    nativeProviderSessionId: Promise<string | null>;
  }>;
  parseOutput: (handle: ProviderHandle) => AsyncIterable<string>;
  cancel: (requestId: string) => Promise<void>;
}
