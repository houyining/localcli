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
  version?: string | null;
  models?: string[];
  message?: string;
}

export interface ChatRequest {
  provider?: ProviderId;
  stream?: boolean;
  messages: ChatMessage[];
}

export interface StreamEvent {
  type: "start" | "delta" | "done" | "error";
  requestId?: string;
  provider?: ProviderId;
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
}

export interface ProviderHandle {
  output: AsyncIterable<string>;
  done: Promise<{ finishReason: FinishReason }>;
  cancel: () => void;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  detect: () => Promise<ProviderStatus>;
  getVersion: () => Promise<string | null>;
  getModels: () => Promise<string[]>;
  buildInput: (messages: ChatMessage[]) => Promise<ProviderInput>;
  spawn: (input: ProviderInput, context: ProviderRunContext) => Promise<ProviderHandle>;
  parseOutput: (handle: ProviderHandle) => AsyncIterable<string>;
  cancel: (requestId: string) => Promise<void>;
}
