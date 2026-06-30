const elements = {
  agentBase: document.querySelector("#agentBase"),
  healthButton: document.querySelector("#healthButton"),
  statusText: document.querySelector("#statusText"),
  pairButton: document.querySelector("#pairButton"),
  forgetButton: document.querySelector("#forgetButton"),
  providersButton: document.querySelector("#providersButton"),
  providersList: document.querySelector("#providersList"),
  providerSelect: document.querySelector("#providerSelect"),
  clientIdText: document.querySelector("#clientIdText"),
  originText: document.querySelector("#originText"),
  streamToggle: document.querySelector("#streamToggle"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  cancelButton: document.querySelector("#cancelButton"),
  output: document.querySelector("#output"),
};

const state = {
  clientId: localStorage.getItem("localCliAgent.clientId"),
  credential: localStorage.getItem("localCliAgent.credential"),
  providers: [],
  abortController: null,
  activeRequestId: null,
};

const realProviderIds = ["claude", "codex", "ollama", "gemini"];
const demoProviderIds = [...realProviderIds, "fake"];

function agentBase() {
  return elements.agentBase.value.replace(/\/$/, "");
}

function writeStatus(text) {
  elements.statusText.textContent = text;
}

function writeOutput(text, append = false) {
  elements.output.textContent = append ? elements.output.textContent + text : text;
}

function token(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${prefix}_${encoded}`;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Local-Agent-Client-Id": state.clientId,
    Authorization: `Bearer ${state.credential}`,
  };
}

function persistClient(clientId, credential) {
  state.clientId = clientId;
  state.credential = credential;
  localStorage.setItem("localCliAgent.clientId", clientId);
  localStorage.setItem("localCliAgent.credential", credential);
  renderClient();
}

function clearClient() {
  state.clientId = null;
  state.credential = null;
  state.providers = [];
  localStorage.removeItem("localCliAgent.clientId");
  localStorage.removeItem("localCliAgent.credential");
  renderClient();
  renderProviders([]);
}

function renderClient() {
  elements.clientIdText.textContent = state.clientId ?? "None";
  elements.originText.textContent = window.location.origin;
}

function renderProviders(providers) {
  elements.providersList.replaceChildren();
  elements.providerSelect.replaceChildren();

  if (providers.length === 0) {
    elements.providersList.textContent = "No providers loaded.";
    return;
  }

  for (const provider of providers) {
    const item = document.createElement("div");
    item.className = "provider";

    const summary = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = provider.name;
    const detail = document.createElement("span");
    detail.textContent = provider.message || provider.version || provider.id;
    summary.append(name, detail);

    const badge = document.createElement("div");
    badge.className = `badge ${provider.ready ? "ready" : "warn"}`;
    badge.textContent = provider.ready ? "Ready" : "Unavailable";

    item.append(summary, badge);
    elements.providersList.append(item);

    if (provider.ready) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      elements.providerSelect.append(option);
    }
  }
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function checkHealth() {
  try {
    const response = await fetch(`${agentBase()}/health`);
    const body = await readJson(response);
    writeStatus(response.ok ? `Running on ${body.host}:${body.port}` : body.message);
  } catch (error) {
    writeStatus(error instanceof Error ? error.message : String(error));
  }
}

async function requestPair(clientNonce, requestedProviders) {
  const response = await fetch(`${agentBase()}/v1/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: "Local CLI Agent Web Demo",
      clientType: "web-app",
      origin: window.location.origin,
      requestedCapabilities: ["llm.chat", "llm.stream", "llm.listProviders"],
      requestedProviders,
      clientNonce,
    }),
  });
  return { response, body: await readJson(response) };
}

async function pair() {
  const clientNonce = token("nonce");
  writeStatus("Waiting for Agent approval...");
  let { response, body } = await requestPair(clientNonce, demoProviderIds);
  if (!response.ok && body.code === "provider_not_requested") {
    ({ response, body } = await requestPair(clientNonce, realProviderIds));
  }
  if (!response.ok) {
    writeStatus(body.message ?? "Pair request failed.");
    return;
  }

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const statusResponse = await fetch(
      `${agentBase()}/v1/pair/status?requestId=${encodeURIComponent(body.requestId)}&clientNonce=${encodeURIComponent(clientNonce)}`,
    );
    const statusBody = await readJson(statusResponse);
    if (statusBody.status === "allowed") {
      persistClient(statusBody.clientId, statusBody.credential);
      writeStatus("Paired.");
      await loadProviders();
      return;
    }
    if (statusBody.status === "denied" || statusBody.status === "expired") {
      writeStatus(`Pairing ${statusBody.status}.`);
      return;
    }
  }
  writeStatus("Pairing expired.");
}

async function loadProviders() {
  if (!state.clientId || !state.credential) {
    writeStatus("Pair before loading providers.");
    return;
  }
  const response = await fetch(`${agentBase()}/v1/providers`, {
    headers: authHeaders(),
  });
  const body = await readJson(response);
  if (!response.ok) {
    writeStatus(body.message ?? "Provider request failed.");
    return;
  }
  state.providers = body.providers;
  renderProviders(body.providers);
  writeStatus(`${body.providers.filter((provider) => provider.ready).length} provider(s) ready.`);
}

function parseSse(buffer, onEvent) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((item) => item.startsWith("data:"));
    if (!line) {
      continue;
    }
    onEvent(JSON.parse(line.slice(5).trim()));
  }
  return rest;
}

async function sendChat() {
  if (!state.clientId || !state.credential) {
    writeStatus("Pair before sending chat.");
    return;
  }
  const provider = elements.providerSelect.value;
  if (!provider) {
    writeStatus("No ready provider selected.");
    return;
  }

  state.abortController = new AbortController();
  state.activeRequestId = null;
  elements.sendButton.disabled = true;
  writeOutput("");

  try {
    const response = await fetch(`${agentBase()}/v1/chat`, {
      method: "POST",
      headers: authHeaders(),
      signal: state.abortController.signal,
      body: JSON.stringify({
        provider,
        stream: elements.streamToggle.checked,
        messages: [{ role: "user", content: elements.messageInput.value }],
      }),
    });

    if (!elements.streamToggle.checked) {
      const body = await readJson(response);
      if (!response.ok) {
        writeStatus(body.message ?? "Chat failed.");
        return;
      }
      state.activeRequestId = body.requestId;
      writeOutput(body.content);
      writeStatus(`Done: ${body.finishReason}`);
      return;
    }

    if (!response.ok || !response.body) {
      const body = await readJson(response);
      writeStatus(body.message ?? "Streaming failed.");
      return;
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
      buffer = parseSse(buffer, (event) => {
        if (event.type === "start") {
          state.activeRequestId = event.requestId;
          writeStatus(`Started ${event.requestId}`);
        } else if (event.type === "delta") {
          writeOutput(event.content ?? "", true);
        } else if (event.type === "done") {
          writeStatus(`Done: ${event.finishReason}`);
        } else if (event.type === "error") {
          writeStatus(event.message ?? "Provider error.");
        }
      });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      writeStatus("Cancelled.");
    } else {
      writeStatus(error instanceof Error ? error.message : String(error));
    }
  } finally {
    elements.sendButton.disabled = false;
    state.abortController = null;
  }
}

async function cancelChat() {
  state.abortController?.abort();
  if (state.activeRequestId && state.clientId && state.credential) {
    await fetch(`${agentBase()}/v1/requests/${encodeURIComponent(state.activeRequestId)}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => undefined);
  }
}

elements.healthButton.addEventListener("click", checkHealth);
elements.pairButton.addEventListener("click", pair);
elements.forgetButton.addEventListener("click", clearClient);
elements.providersButton.addEventListener("click", loadProviders);
elements.sendButton.addEventListener("click", sendChat);
elements.cancelButton.addEventListener("click", cancelChat);

renderClient();
renderProviders([]);
checkHealth();
if (state.clientId && state.credential) {
  loadProviders().catch((error) => writeStatus(error instanceof Error ? error.message : String(error)));
}
