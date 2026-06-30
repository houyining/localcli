import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import type {
  ChatMessage,
  FinishReason,
  ProviderAdapter,
  ProviderHandle,
  ProviderId,
  ProviderInput,
  ProviderRunContext,
  ProviderStatus,
} from "./types.ts";

const execFileAsync = promisify(execFile);

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

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/which", [command], { timeout: 800 });
    return true;
  } catch {
    return false;
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

function makeChildHandle(
  command: string,
  args: string[],
  requestId: string,
  signal: AbortSignal,
  activeChildren: Map<string, ChildProcessWithoutNullStreams>,
): ProviderHandle {
  const child = spawn(command, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.set(requestId, child);

  let stderr = "";
  let cancelled = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const doneState = deferred<{ finishReason: FinishReason }>();

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
    doneState.reject(
      new ProviderExecutionError(
        "provider_error",
        stderr.trim() || `${command} exited with code ${code ?? "unknown"}`,
      ),
    );
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
      version: "development",
      models: ["fake-echo"],
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
        version: await this.getVersion(),
        models,
        message: models.length === 0 ? "No model found" : undefined,
      };
    } catch {
      return {
        id: this.id,
        name: this.name,
        installed: false,
        ready: false,
        message: "Ollama is not reachable",
      };
    }
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
  promptArgs: (prompt: string) => string[];
  private activeChildren = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(options: {
    id: ProviderId;
    name: string;
    command: string;
    versionArgs: string[];
    promptArgs: (prompt: string) => string[];
  }) {
    this.id = options.id;
    this.name = options.name;
    this.command = options.command;
    this.versionArgs = options.versionArgs;
    this.promptArgs = options.promptArgs;
  }

  async detect(): Promise<ProviderStatus> {
    const installed = await commandExists(this.command);
    const version = installed ? await this.getVersion() : null;
    return {
      id: this.id,
      name: this.name,
      installed,
      ready: installed,
      version,
      message: installed ? undefined : "Not installed",
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

  async spawn(input: ProviderInput, context: ProviderRunContext): Promise<ProviderHandle> {
    const installed = await commandExists(this.command);
    if (!installed) {
      throw new ProviderExecutionError("provider_not_installed", `${this.name} is not installed`);
    }

    return makeChildHandle(
      this.command,
      this.promptArgs(input.prompt),
      context.requestId,
      context.signal,
      this.activeChildren,
    );
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

  constructor(adapters: ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  ids(): ProviderId[] {
    return [...this.adapters.keys()];
  }

  get(id: ProviderId): ProviderAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  async listStatuses(): Promise<ProviderStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
  }

  async status(id: ProviderId): Promise<ProviderStatus | null> {
    return (await this.adapters.get(id)?.detect()) ?? null;
  }

  async spawnChat(
    providerId: ProviderId,
    messages: ChatMessage[],
    context: ProviderRunContext,
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
    if (context.signal.aborted) {
      throw new ProviderExecutionError("request_cancelled", "Request was cancelled.");
    }
    const handle = await adapter.spawn(input, context);
    return { adapter, handle };
  }
}

export function createDefaultProviders(options: { enableFakeProvider?: boolean } = {}): ProviderRegistry {
  const adapters: ProviderAdapter[] = [
    new CliProviderAdapter({
      id: "claude",
      name: "Claude CLI",
      command: "claude",
      versionArgs: ["--version"],
      promptArgs: (prompt) => ["-p", prompt],
    }),
    new CliProviderAdapter({
      id: "codex",
      name: "Codex CLI",
      command: "codex",
      versionArgs: ["--version"],
      promptArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    }),
    new OllamaProviderAdapter(),
    new CliProviderAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      versionArgs: ["--version"],
      promptArgs: (prompt) => ["-p", prompt],
    }),
  ];

  if (options.enableFakeProvider || process.env.LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER === "1") {
    adapters.push(new FakeProviderAdapter());
  }

  return new ProviderRegistry(adapters);
}
