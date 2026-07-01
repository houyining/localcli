import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  ChatMessage,
  FinishReason,
  ProviderAdapter,
  ProviderDiagnostic,
  ProviderExecutionPlan,
  ProviderHandle,
  ProviderId,
  ProviderInput,
  ProviderInputChannel,
  ProviderNativeSessionStatus,
  ProviderReadinessReason,
  ProviderRunContext,
  ProviderStatus,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const PROVIDER_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderExecutionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderExecutionError";
    this.code = code;
  }
}

function promptFromMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

function lastUserMessage(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  return last?.content ?? messages[messages.length - 1]?.content ?? "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function commandPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [command], { timeout: 800 });
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 1200,
      maxBuffer: 1024 * 64,
    });
    return (stdout || stderr).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

async function* decodeUtf8Chunks(chunks: AsyncIterable<Buffer | Uint8Array | string>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    if (typeof chunk === "string") {
      yield chunk;
    } else {
      const text = decoder.decode(chunk, { stream: true });
      if (text) {
        yield text;
      }
    }
  }
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ProviderExecutionError("provider_error", "Provider emitted malformed JSON.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function classifyProviderErrorMessage(message: string): "provider_not_authenticated" | "provider_error" {
  return /not authenticated|unauthenticated|unauthorized|log in|login|sign in|api key|auth token/i.test(message)
    ? "provider_not_authenticated"
    : "provider_error";
}

function providerErrorFromMessage(message: string): ProviderExecutionError {
  const code = classifyProviderErrorMessage(message);
  return new ProviderExecutionError(
    code,
    code === "provider_not_authenticated"
      ? "Provider is not authenticated."
      : "Provider execution failed.",
  );
}

function collectTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const content = record.content;
  if (typeof content === "string") {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.flatMap((item) => {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        return [];
      }
      const type = asString(itemRecord.type);
      if ((type === "text" || type === "output_text") && typeof itemRecord.text === "string") {
        return [itemRecord.text];
      }
      return [];
    });
  }
  if (typeof record.text === "string") {
    return [record.text];
  }
  return [];
}

function extractProviderError(event: Record<string, unknown>): string | null {
  const error = asRecord(event.error);
  return asString(error?.message)
    ?? asString(error?.detail)
    ?? asString(event.message)
    ?? null;
}

export async function* parseClaudeStreamJson(output: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  const emitLine = function* (line: string): Iterable<string> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const event = asRecord(parseJsonLine(trimmed));
    if (!event) {
      return;
    }
    const type = asString(event.type);
    if (type === "error") {
      throw providerErrorFromMessage(extractProviderError(event) ?? "Provider execution failed.");
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (asString(delta?.type) === "text_delta" && typeof delta?.text === "string") {
        yield delta.text;
      }
      return;
    }
    if (type === "assistant_delta") {
      const delta = asRecord(event.delta);
      const text = asString(delta?.text) ?? asString(delta?.content);
      if (text) {
        yield text;
      }
      return;
    }
    if (type === "assistant") {
      const message = asRecord(event.message);
      for (const text of collectTextContent(message)) {
        yield text;
      }
    }
  };
  for await (const chunk of output) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      yield* emitLine(line);
    }
  }
  if (buffer.trim()) {
    yield* emitLine(buffer);
  }
}

function extractCodexSessionId(event: Record<string, unknown>): string | null {
  const session = asRecord(event.session);
  return asString(event.session_id)
    ?? asString(event.sessionId)
    ?? asString(event.thread_id)
    ?? asString(event.threadId)
    ?? asString(event.conversation_id)
    ?? asString(event.conversationId)
    ?? asString(session?.id)
    ?? null;
}

function extractCodexText(event: Record<string, unknown>): string[] {
  const type = asString(event.type);
  if (type === "message.delta" || type === "response.output_text.delta" || type === "agent_message_delta") {
    if (typeof event.delta === "string") {
      return [event.delta];
    }
    const delta = asRecord(event.delta);
    return asString(delta?.text) ? [delta!.text as string] : [];
  }
  if (type === "item.completed") {
    const item = asRecord(event.item);
    if (asString(item?.type) === "message" && asString(item?.role) === "assistant") {
      return collectTextContent(item);
    }
  }
  if (type === "message" && asString(event.role) === "assistant") {
    return collectTextContent(event);
  }
  if (type === "response.completed") {
    const response = asRecord(event.response);
    const output = response?.output;
    return Array.isArray(output)
      ? output.flatMap((item) => collectTextContent(item))
      : [];
  }
  return [];
}

export async function* parseCodexJsonl(
  output: AsyncIterable<string>,
  options: {
    requireSessionId: boolean;
    onSessionId: (sessionId: string) => void;
  },
): AsyncIterable<string> {
  let buffer = "";
  let sessionId: string | null = null;
  const pendingText: string[] = [];
  for await (const chunk of output) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const event = asRecord(parseJsonLine(trimmed));
      if (!event) {
        continue;
      }
      const type = asString(event.type);
      if (type === "error" || event.error) {
        throw providerErrorFromMessage(extractProviderError(event) ?? "Provider execution failed.");
      }
      sessionId ??= extractCodexSessionId(event);
      if (sessionId) {
        options.onSessionId(sessionId);
      }
      for (const text of extractCodexText(event)) {
        if (options.requireSessionId && !sessionId) {
          pendingText.push(text);
        } else {
          if (pendingText.length > 0) {
            yield pendingText.join("");
            pendingText.length = 0;
          }
          yield text;
        }
      }
    }
  }
  if (buffer.trim()) {
    const event = asRecord(parseJsonLine(buffer.trim()));
    if (event) {
      const type = asString(event.type);
      if (type === "error" || event.error) {
        throw providerErrorFromMessage(extractProviderError(event) ?? "Provider execution failed.");
      }
      sessionId ??= extractCodexSessionId(event);
      if (sessionId) {
        options.onSessionId(sessionId);
      }
      for (const text of extractCodexText(event)) {
        if (options.requireSessionId && !sessionId) {
          pendingText.push(text);
        } else {
          if (pendingText.length > 0) {
            yield pendingText.join("");
            pendingText.length = 0;
          }
          yield text;
        }
      }
    }
  }
  if (options.requireSessionId && !sessionId) {
    throw new ProviderExecutionError("native_session_unsupported", "Codex did not report a resumable session id.");
  }
  if (pendingText.length > 0) {
    yield pendingText.join("");
  }
}

function makeChildHandle(
  command: string,
  args: string[],
  input: ProviderInputChannel,
  requestId: string,
  signal: AbortSignal,
  activeChildren: Map<string, ChildProcessWithoutNullStreams>,
  cwd?: string,
): ProviderHandle {
  const child = spawn(command, args, {
    shell: false,
    stdio: [input.type === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    cwd,
  });
  activeChildren.set(requestId, child);

  let stderr = "";
  let cancelled = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const doneState = deferred<{ finishReason: FinishReason }>();

  if (input.type === "stdin") {
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.content);
  }

  const clearKillTimer = (): void => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const cancel = (): void => {
    cancelled = true;
    if (closed) {
      return;
    }
    child.kill("SIGTERM");
    clearKillTimer();
    killTimer = setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, 1500);
    killTimer.unref();
  };

  signal.addEventListener("abort", cancel, { once: true });

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) {
      stderr += chunk.toString("utf8");
    }
  });

  child.on("error", (error) => {
    closed = true;
    clearKillTimer();
    signal.removeEventListener("abort", cancel);
    activeChildren.delete(requestId);
    doneState.reject(new ProviderExecutionError("provider_error", error.message));
  });

  child.on("close", (code) => {
    closed = true;
    clearKillTimer();
    signal.removeEventListener("abort", cancel);
    activeChildren.delete(requestId);
    if (cancelled || signal.aborted) {
      doneState.resolve({ finishReason: signal.reason?.message === "timeout" ? "timeout" : "cancelled" });
      return;
    }
    if (code === 0) {
      doneState.resolve({ finishReason: "stop" });
      return;
    }
    doneState.reject(providerErrorFromMessage(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
  });

  return {
    cancel,
    done: doneState.promise,
    output: decodeUtf8Chunks(child.stdout),
  };
}

export class FakeProviderAdapter implements ProviderAdapter {
  id: ProviderId = "fake";
  name = "Fake Provider";
  private active = new Map<string, () => void>();

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      ready: true,
      reason: "ready",
      version: "development",
      models: ["fake-echo"],
      nativeSession: { supported: false, state: "unsupported" },
    };
  }

  async diagnostics(): Promise<ProviderDiagnostic> {
    return {
      id: this.id,
      name: this.name,
      status: await this.detect(),
      version: "development",
      lastErrorCode: null,
    };
  }

  async getVersion(): Promise<string | null> {
    return "development";
  }

  async getModels(): Promise<string[]> {
    return ["fake-echo"];
  }

  async buildInput(messages: ChatMessage[]): Promise<ProviderInput> {
    return { messages, prompt: lastUserMessage(messages), model: "fake-echo" };
  }

  async spawn(input: ProviderInput, context: ProviderRunContext): Promise<ProviderHandle> {
    let cancelled = false;
    const doneState = deferred<{ finishReason: FinishReason }>();
    const isSlow = input.prompt.includes("[slow]");
    const chunks = isSlow
      ? [`Echo: `, ...Array.from({ length: 20 }, (_, index) => `${index}:${input.prompt}\n`)]
      : [`Echo: `, input.prompt || "(empty)", `\n`];
    const chunkDelayMs = isSlow ? 80 : 15;
    const cancel = (): void => {
      cancelled = true;
    };
    this.active.set(context.requestId, cancel);
    context.signal.addEventListener("abort", cancel, { once: true });

    const output = (async function* (): AsyncIterable<string> {
      try {
        for (const chunk of chunks) {
          if (cancelled || context.signal.aborted) {
            doneState.resolve({
              finishReason: context.signal.reason?.message === "timeout" ? "timeout" : "cancelled",
            });
            return;
          }
          await delay(chunkDelayMs);
          if (cancelled || context.signal.aborted) {
            doneState.resolve({
              finishReason: context.signal.reason?.message === "timeout" ? "timeout" : "cancelled",
            });
            return;
          }
          yield chunk;
        }
        doneState.resolve({ finishReason: "stop" });
      } catch (error) {
        doneState.reject(error);
      }
    })();

    doneState.promise.finally(() => this.active.delete(context.requestId)).catch(() => undefined);
    return { output, done: doneState.promise, cancel };
  }

  parseOutput(handle: ProviderHandle): AsyncIterable<string> {
    return handle.output;
  }

  async cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.();
  }
}

export class OllamaProviderAdapter implements ProviderAdapter {
  id: ProviderId = "ollama";
  name = "Ollama";
  baseUrl: string;
  private active = new Map<string, AbortController>();

  constructor(baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl;
  }

  async detect(): Promise<ProviderStatus> {
    try {
      const models = await this.getModels();
      return {
        id: this.id,
        name: this.name,
        installed: true,
        ready: models.length > 0,
        reason: models.length > 0 ? "ready" : "not_ready",
        version: await this.getVersion(),
        models,
        message: models.length === 0 ? "No model found" : undefined,
        nativeSession: { supported: false, state: "unsupported" },
      };
    } catch {
      return {
        id: this.id,
        name: this.name,
        installed: false,
        ready: false,
        reason: "not_ready",
        message: "Ollama is not reachable",
        nativeSession: { supported: false, state: "unsupported" },
      };
    }
  }

  async diagnostics(): Promise<ProviderDiagnostic> {
    const status = await this.detect();
    return {
      id: this.id,
      name: this.name,
      status,
      version: status.version,
      lastErrorCode: status.ready ? null : "provider_not_ready",
    };
  }

  async getVersion(): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(800),
      });
      if (!response.ok) {
        return null;
      }
      const body = await response.json() as { version?: string };
      return body.version ?? null;
    } catch {
      return null;
    }
  }

  async getModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) {
      throw new ProviderExecutionError("provider_not_ready", "Ollama is not reachable");
    }
    const body = await response.json() as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name));
  }

  async buildInput(messages: ChatMessage[]): Promise<ProviderInput> {
    const models = await this.getModels();
    return { messages, prompt: promptFromMessages(messages), model: models[0] };
  }

  async spawn(input: ProviderInput, context: ProviderRunContext): Promise<ProviderHandle> {
    if (!input.model) {
      throw new ProviderExecutionError("provider_not_ready", "No Ollama model found");
    }

    const controller = new AbortController();
    const doneState = deferred<{ finishReason: FinishReason }>();
    const cancel = (): void => controller.abort(new Error("cancelled"));
    this.active.set(context.requestId, controller);
    context.signal.addEventListener("abort", () => controller.abort(context.signal.reason), { once: true });

    const responsePromise = fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
      }),
      signal: controller.signal,
    });

    const output = (async function* (): AsyncIterable<string> {
      try {
        const response = await responsePromise;
        if (!response.ok || !response.body) {
          throw new ProviderExecutionError("provider_error", `Ollama returned HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            const event = JSON.parse(trimmed) as {
              message?: { content?: string };
              done?: boolean;
            };
            if (event.message?.content) {
              yield event.message.content;
            }
          }
        }

        doneState.resolve({ finishReason: "stop" });
      } catch (error) {
        if (controller.signal.aborted || context.signal.aborted) {
          doneState.resolve({
            finishReason: context.signal.reason?.message === "timeout" ? "timeout" : "cancelled",
          });
          return;
        }
        doneState.reject(error);
      }
    })();

    doneState.promise.finally(() => this.active.delete(context.requestId)).catch(() => undefined);
    return { output, done: doneState.promise, cancel };
  }

  parseOutput(handle: ProviderHandle): AsyncIterable<string> {
    return handle.output;
  }

  async cancel(requestId: string): Promise<void> {
    this.active.get(requestId)?.abort(new Error("cancelled"));
  }
}

export class CliProviderAdapter implements ProviderAdapter {
  id: ProviderId;
  name: string;
  command: string;
  versionArgs: string[];
  args: string[];
  inputMode: "stdin" | "none";
  supportsNativeSessions: boolean;
  private readonly nativeSessionKind: "claude" | "codex" | null;
  private activeChildren = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(options: {
    id: ProviderId;
    name: string;
    command: string;
    versionArgs: string[];
    args: string[];
    inputMode?: "stdin" | "none";
    nativeSessionKind?: "claude" | "codex";
  }) {
    this.id = options.id;
    this.name = options.name;
    this.command = options.command;
    this.versionArgs = options.versionArgs;
    this.args = options.args;
    this.inputMode = options.inputMode ?? "stdin";
    this.nativeSessionKind = options.nativeSessionKind ?? null;
    this.supportsNativeSessions = this.nativeSessionKind !== null;
  }

  async detect(): Promise<ProviderStatus> {
    const executablePath = await commandPath(this.command);
    const installed = Boolean(executablePath);
    const version = installed ? await this.getVersion() : null;
    const secureInputSupported = this.inputMode === "stdin";
    const ready = installed && secureInputSupported;
    const nativeSession = this.nativeSessionKind
      ? {
        supported: true,
        state: "unverified",
        reason: "Native session support is verified by the first successful native request.",
      } satisfies ProviderNativeSessionStatus
      : { supported: false, state: "unsupported" } satisfies ProviderNativeSessionStatus;
    return {
      id: this.id,
      name: this.name,
      installed,
      ready,
      reason: ready ? "ready" : installed ? "secure_input_unsupported" : "not_installed",
      version,
      message: !installed
        ? "Not installed"
        : secureInputSupported
          ? undefined
          : "Secure non-interactive input is not supported",
      nativeSession,
    };
  }

  async diagnostics(): Promise<ProviderDiagnostic> {
    const status = await this.detect();
    return {
      id: this.id,
      name: this.name,
      status,
      command: this.command,
      commandPath: await commandPath(this.command),
      version: status.version,
      lastErrorCode: status.ready ? null : status.reason ?? "not_ready",
    };
  }

  async getVersion(): Promise<string | null> {
    return commandVersion(this.command, this.versionArgs);
  }

  async getModels(): Promise<string[]> {
    return [];
  }

  async buildInput(messages: ChatMessage[]): Promise<ProviderInput> {
    return { messages, prompt: promptFromMessages(messages) };
  }

  buildExecutionPlan(input: ProviderInput): ProviderExecutionPlan {
    return {
      command: this.command,
      args: [...this.args],
      input: this.inputMode === "stdin"
        ? { type: "stdin", content: input.prompt }
        : { type: "none" },
    };
  }

  async spawn(input: ProviderInput, context: ProviderRunContext): Promise<ProviderHandle> {
    const installed = Boolean(await commandPath(this.command));
    if (!installed) {
      throw new ProviderExecutionError("provider_not_installed", `${this.name} is not installed`);
    }
    if (this.inputMode !== "stdin") {
      throw new ProviderExecutionError(
        "provider_secure_input_unsupported",
        `${this.name} does not support secure non-interactive input`,
      );
    }

    const plan = this.buildExecutionPlan(input);

    return makeChildHandle(
      plan.command,
      plan.args,
      plan.input,
      context.requestId,
      context.signal,
      this.activeChildren,
      context.workingDirectory,
    );
  }

  createNativeSession(): string | null {
    if (this.nativeSessionKind === "claude") {
      return randomUUID();
    }
    return null;
  }

  async sendNativeSessionMessage(
    input: ProviderInput,
    context: ProviderRunContext,
    session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    const installed = Boolean(await commandPath(this.command));
    if (!installed) {
      throw new ProviderExecutionError("provider_not_installed", `${this.name} is not installed`);
    }
    if (this.inputMode !== "stdin") {
      throw new ProviderExecutionError(
        "provider_secure_input_unsupported",
        `${this.name} does not support secure non-interactive input`,
      );
    }

    if (this.nativeSessionKind === "claude") {
      return this.sendClaudeNativeSessionMessage(input, context, session);
    }
    if (this.nativeSessionKind === "codex") {
      return this.sendCodexNativeSessionMessage(input, context, session);
    }

    throw new ProviderExecutionError("native_session_unsupported", `${this.name} does not support native sessions.`);
  }

  private async sendClaudeNativeSessionMessage(
    input: ProviderInput,
    context: ProviderRunContext,
    session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    if (!session.nativeProviderSessionId) {
      throw new ProviderExecutionError("native_session_unavailable", "Native session mapping is not available.");
    }

    const args = ["-p", "--session-id", session.nativeProviderSessionId];
    if (session.stream) {
      args.push("--output-format", "stream-json", "--include-partial-messages");
    }

    const handle = makeChildHandle(
      this.command,
      args,
      { type: "stdin", content: input.prompt },
      context.requestId,
      context.signal,
      this.activeChildren,
      context.workingDirectory,
    );

    return {
      handle: {
        ...handle,
        output: session.stream ? parseClaudeStreamJson(handle.output) : handle.output,
      },
      nativeProviderSessionId: Promise.resolve(session.nativeProviderSessionId),
    };
  }

  private async sendCodexNativeSessionMessage(
    input: ProviderInput,
    context: ProviderRunContext,
    session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    const args = session.nativeProviderSessionId
      ? ["exec", "resume", session.nativeProviderSessionId, "--json", "--skip-git-repo-check", "-"]
      : ["exec", "--json", "--skip-git-repo-check", "-"];
    const handle = makeChildHandle(
      this.command,
      args,
      { type: "stdin", content: input.prompt },
      context.requestId,
      context.signal,
      this.activeChildren,
      context.workingDirectory,
    );

    let capturedSessionId = session.nativeProviderSessionId;
    const nativeSessionId = deferred<string | null>();
    const output = (async function* (): AsyncIterable<string> {
      try {
        yield* parseCodexJsonl(handle.output, {
          requireSessionId: !session.nativeProviderSessionId,
          onSessionId: (sessionId) => {
            capturedSessionId = sessionId;
          },
        });
        nativeSessionId.resolve(capturedSessionId);
      } catch (error) {
        nativeSessionId.resolve(capturedSessionId);
        throw error;
      }
    })();

    return {
      handle: {
        ...handle,
        output,
      },
      nativeProviderSessionId: nativeSessionId.promise,
    };
  }

  parseOutput(handle: ProviderHandle): AsyncIterable<string> {
    return handle.output;
  }

  async cancel(requestId: string): Promise<void> {
    const child = this.activeChildren.get(requestId);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1500).unref();
    }
  }
}

export class ProviderRegistry {
  private adapters: Map<ProviderId, ProviderAdapter>;
  private statusCache: { expiresAt: number; statuses: ProviderStatus[] } | null = null;
  private readonly statusCacheTtlMs: number;
  private readonly failureCacheTtlMs: number;
  private failures = new Map<ProviderId, { code: string; message: string; expiresAt: number }>();
  private nativeSessionReady = new Set<ProviderId>();

  constructor(adapters: ProviderAdapter[], options: { statusCacheTtlMs?: number; failureCacheTtlMs?: number } = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.statusCacheTtlMs = options.statusCacheTtlMs ?? 5000;
    this.failureCacheTtlMs = options.failureCacheTtlMs ?? PROVIDER_FAILURE_CACHE_TTL_MS;
  }

  ids(): ProviderId[] {
    return [...this.adapters.keys()];
  }

  get(id: ProviderId): ProviderAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  supportsNativeSessions(id: ProviderId): boolean {
    return this.adapters.get(id)?.supportsNativeSessions === true;
  }

  createNativeSession(id: ProviderId): string | null {
    return this.adapters.get(id)?.createNativeSession?.() ?? null;
  }

  async listStatuses(options: { force?: boolean } = {}): Promise<ProviderStatus[]> {
    const now = Date.now();
    if (
      !options.force
      && this.statusCache
      && this.statusCache.expiresAt > now
    ) {
      return this.applyFailureCache(this.cloneStatuses(this.statusCache.statuses), now);
    }

    const statuses = await Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
    this.statusCache = {
      statuses: this.cloneStatuses(statuses),
      expiresAt: now + this.statusCacheTtlMs,
    };
    return this.applyFailureCache(this.cloneStatuses(statuses), now);
  }

  async status(id: ProviderId): Promise<ProviderStatus | null> {
    return (await this.listStatuses()).find((status) => status.id === id) ?? null;
  }

  async diagnostics(options: { force?: boolean } = {}): Promise<ProviderDiagnostic[]> {
    if (options.force) {
      this.statusCache = null;
    }
    const now = Date.now();
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      if (adapter.diagnostics) {
        const diagnostic = await adapter.diagnostics();
        const [status] = this.applyFailureCache([diagnostic.status], now);
        return {
          ...diagnostic,
          status,
          lastErrorCode: this.currentFailure(adapter.id, now)?.code ?? diagnostic.lastErrorCode ?? null,
        };
      }
      const status = await adapter.detect();
      const [nextStatus] = this.applyFailureCache([status], now);
      return {
        id: adapter.id,
        name: adapter.name,
        status: nextStatus,
        version: nextStatus.version,
        lastErrorCode: this.currentFailure(adapter.id, now)?.code ?? (nextStatus.ready ? null : nextStatus.reason ?? "not_ready"),
      };
    }));
  }

  recordFailure(providerId: ProviderId, code: string, message = ""): void {
    if (!this.isBlockingProviderFailure(code)) {
      return;
    }
    if (code === "native_session_unsupported" || code === "native_session_unavailable") {
      this.nativeSessionReady.delete(providerId);
    }
    this.failures.set(providerId, {
      code,
      message,
      expiresAt: Date.now() + this.failureCacheTtlMs,
    });
  }

  recordSuccess(providerId: ProviderId): void {
    this.failures.delete(providerId);
  }

  recordNativeSessionSuccess(providerId: ProviderId): void {
    this.recordSuccess(providerId);
    this.nativeSessionReady.add(providerId);
  }

  async spawnChat(
    providerId: ProviderId,
    messages: ChatMessage[],
    context: ProviderRunContext,
    options: { model?: string } = {},
  ): Promise<{ adapter: ProviderAdapter; handle: ProviderHandle }> {
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new ProviderExecutionError("provider_not_found", `Provider ${providerId} is not available`);
    }

    const status = await adapter.detect();
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    if (!status.installed) {
      throw new ProviderExecutionError("provider_not_installed", `${status.name} is not installed`);
    }
    if (!status.ready) {
      throw new ProviderExecutionError("provider_not_ready", status.message ?? `${status.name} is not ready`);
    }

    const input = await adapter.buildInput(messages);
    if (options.model) {
      input.model = options.model;
    }
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    const handle = await adapter.spawn(input, context);
    return { adapter, handle };
  }

  async spawnNativeSessionChat(
    providerId: ProviderId,
    messages: ChatMessage[],
    context: ProviderRunContext,
    session: { nativeProviderSessionId: string | null; stream: boolean },
  ): Promise<{ adapter: ProviderAdapter; handle: ProviderHandle; nativeProviderSessionId: Promise<string | null> }> {
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new ProviderExecutionError("provider_not_found", `Provider ${providerId} is not available`);
    }
    if (!adapter.supportsNativeSessions || !adapter.sendNativeSessionMessage) {
      throw new ProviderExecutionError("native_session_unsupported", `Provider ${providerId} does not support native sessions.`);
    }

    const status = await adapter.detect();
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    if (!status.installed) {
      throw new ProviderExecutionError("provider_not_installed", `${status.name} is not installed`);
    }
    if (!status.ready) {
      throw new ProviderExecutionError("provider_not_ready", status.message ?? `${status.name} is not ready`);
    }

    const input = await adapter.buildInput(messages);
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    const result = await adapter.sendNativeSessionMessage(input, context, session);
    return { adapter, ...result };
  }

  private cloneStatuses(statuses: ProviderStatus[]): ProviderStatus[] {
    return statuses.map((status) => ({
      ...status,
      models: status.models ? [...status.models] : undefined,
      nativeSession: status.nativeSession ? { ...status.nativeSession } : undefined,
    }));
  }

  private applyFailureCache(statuses: ProviderStatus[], now: number): ProviderStatus[] {
    return statuses.map((status) => {
      const failure = this.currentFailure(status.id, now);
      if (!failure) {
        if (status.nativeSession?.supported && this.nativeSessionReady.has(status.id)) {
          return {
            ...status,
            nativeSession: {
              ...status.nativeSession,
              state: "ready",
              reason: undefined,
            },
          };
        }
        return status;
      }
      const reason = this.reasonForFailure(failure.code);
      const message = this.messageForFailure(failure.code);
      return {
        ...status,
        ready: false,
        reason,
        message,
        nativeSession: status.nativeSession
          ? {
            ...status.nativeSession,
            state: status.nativeSession.supported ? "unavailable" : status.nativeSession.state,
            reason: status.nativeSession.supported ? message : status.nativeSession.reason,
          }
          : undefined,
      };
    });
  }

  private currentFailure(providerId: ProviderId, now: number): { code: string; message: string; expiresAt: number } | null {
    const failure = this.failures.get(providerId);
    if (!failure) {
      return null;
    }
    if (failure.expiresAt <= now) {
      this.failures.delete(providerId);
      return null;
    }
    return failure;
  }

  private isBlockingProviderFailure(code: string): boolean {
    return [
      "provider_not_authenticated",
      "provider_secure_input_unsupported",
      "native_session_unsupported",
      "native_session_unavailable",
    ].includes(code);
  }

  private reasonForFailure(code: string): ProviderReadinessReason {
    if (code === "provider_not_authenticated") {
      return "not_authenticated";
    }
    if (code === "provider_secure_input_unsupported") {
      return "secure_input_unsupported";
    }
    return "native_session_unsupported";
  }

  private messageForFailure(code: string): string {
    switch (code) {
      case "provider_not_authenticated":
        return "Provider is not authenticated.";
      case "provider_secure_input_unsupported":
        return "Provider does not support secure non-interactive input.";
      case "native_session_unavailable":
        return "Native session mapping is unavailable.";
      case "native_session_unsupported":
        return "Provider does not support stable native sessions.";
      default:
        return "Provider is not ready.";
    }
  }
}

export function createDefaultProviders(options: { enableFakeProvider?: boolean } = {}): ProviderRegistry {
  const adapters: ProviderAdapter[] = [
    new CliProviderAdapter({
      id: "claude",
      name: "Claude CLI",
      command: "claude",
      versionArgs: ["--version"],
      args: ["-p"],
      inputMode: "stdin",
      nativeSessionKind: "claude",
    }),
    new CliProviderAdapter({
      id: "codex",
      name: "Codex CLI",
      command: "codex",
      versionArgs: ["--version"],
      args: ["exec", "--skip-git-repo-check"],
      inputMode: "stdin",
      nativeSessionKind: "codex",
    }),
    new OllamaProviderAdapter(),
    new CliProviderAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      versionArgs: ["--version"],
      args: ["-p"],
      inputMode: "stdin",
    }),
  ];

  if (options.enableFakeProvider || process.env.LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER === "1") {
    adapters.push(new FakeProviderAdapter());
  }

  return new ProviderRegistry(adapters);
}
