import { randomToken } from "./crypto.ts";
import { createDefaultProviders } from "./providers.ts";
import { SQLiteStore } from "./storage.ts";
import { AgentServer } from "./server.ts";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

const dataDir = argValue("--data-dir") ?? process.env.LOCAL_CLI_AGENT_DATA_DIR;
const adminToken = argValue("--admin-token") ?? process.env.LOCAL_CLI_AGENT_ADMIN_TOKEN ?? randomToken("admin", 32);
const portArg = argValue("--port") ?? process.env.LOCAL_CLI_AGENT_PORT;
const enableFakeProvider = hasArg("--enable-fake-provider") || process.env.LOCAL_CLI_AGENT_ENABLE_FAKE_PROVIDER === "1";

const store = new SQLiteStore(dataDir);
await store.init();
const settings = await store.getSettings();
const port = portArg ? Number(portArg) : settings.port;

const server = new AgentServer({
  store,
  providers: createDefaultProviders({ enableFakeProvider }),
  adminToken,
  settings: { ...settings, port },
});

try {
  await server.start(port);
  console.log(JSON.stringify({
    event: "started",
    service: "local-cli-agent",
    address: `http://localhost:${server.port}`,
    adminToken,
    fakeProviderEnabled: enableFakeProvider,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    event: "failed_to_start",
    service: "local-cli-agent",
    code: message.includes("EADDRINUSE") ? "port_in_use" : "startup_error",
    message,
  }));
  process.exit(1);
}

async function shutdown(): Promise<void> {
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown().catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown().catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
