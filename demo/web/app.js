const ids = [
  "agentBase",
  "healthButton",
  "runHealthButton",
  "statusText",
  "adminTokenInput",
  "saveAdminTokenButton",
  "clearAdminTokenButton",
  "clientIdText",
  "originText",
  "sessionIdText",
  "sessionModeText",
  "nativeStateText",
  "messageCountText",
  "pairClientName",
  "pairClientType",
  "pairOrigin",
  "pairProviders",
  "capChat",
  "capStream",
  "capProviders",
  "pairRequestButton",
  "pairStatusButton",
  "forgetButton",
  "pairRequestId",
  "pairClientNonce",
  "pairAllowProviders",
  "pairDefaultProvider",
  "adminPendingButton",
  "adminAllowPairButton",
  "adminDenyPairButton",
  "pendingPairs",
  "clientProvidersButton",
  "adminProvidersButton",
  "providersList",
  "chatProviderSelect",
  "chatSessionBehavior",
  "chatCreateMode",
  "chatSessionId",
  "chatWorkingDirectory",
  "chatStream",
  "chatMessages",
  "sendChatButton",
  "cancelButton",
  "newSessionButton",
  "chatOutput",
  "sessionProviderSelect",
  "sessionModeSelect",
  "sessionIdInput",
  "sessionWorkingDirectory",
  "sessionChatStream",
  "sessionCreateMessages",
  "createSessionButton",
  "listSessionsButton",
  "getSessionButton",
  "deleteSessionButton",
  "sessionChatMessages",
  "sessionChatButton",
  "sessionsList",
  "openAiModel",
  "openAiStream",
  "openAiMessages",
  "openAiModelsButton",
  "openAiChatButton",
  "adminStatusButton",
  "adminDiagnosticsButton",
  "adminEventsButton",
  "adminEventsStopButton",
  "adminSettingsGetButton",
  "adminSettingsPatchButton",
  "adminSettingsPatch",
  "adminClientId",
  "adminLogLimit",
  "adminClientPatch",
  "adminClientsButton",
  "adminClientPatchButton",
  "adminClientDeleteButton",
  "adminLogsButton",
  "adminLogsClearButton",
  "adminList",
  "copyJsonButton",
  "copyCurlButton",
  "clearHistoryButton",
  "resultOutput",
  "historyList",
];

const elements = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));

const providerIds = ["claude", "codex", "ollama", "gemini", "fake"];
const sessionStorageKey = "localCliAgent.session";
const pairStorageKey = "localCliAgent.pairRequest";
const adminTokenKey = "localCliAgent.adminToken";

const state = {
  clientId: localStorage.getItem("localCliAgent.clientId"),
  credential: localStorage.getItem("localCliAgent.credential"),
  adminToken: sessionStorage.getItem(adminTokenKey) ?? "",
  session: loadStoredSession(),
  pairRequest: loadStoredPairRequest(),
  providers: [],
  history: [],
  selectedHistoryId: null,
  activeRequestId: null,
  activeAbortController: null,
  adminEventsAbortController: null,
};

function loadStoredSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(sessionStorageKey) ?? "null");
    if (!stored || typeof stored.sessionId !== "string" || typeof stored.provider !== "string") {
      return null;
    }
    return {
      sessionId: stored.sessionId,
      provider: stored.provider,
      mode: typeof stored.mode === "string" ? stored.mode : "unknown",
      nativeSessionState: stored.nativeSessionState ?? null,
      messageCount: Number.isFinite(stored.messageCount) ? stored.messageCount : 0,
    };
  } catch {
    localStorage.removeItem(sessionStorageKey);
    return null;
  }
}

function loadStoredPairRequest() {
  try {
    const stored = JSON.parse(localStorage.getItem(pairStorageKey) ?? "null");
    if (!stored || typeof stored.requestId !== "string" || typeof stored.clientNonce !== "string") {
      return null;
    }
    return stored;
  } catch {
    localStorage.removeItem(pairStorageKey);
    return null;
  }
}

function agentBase() {
  return elements.agentBase.value.replace(/\/$/, "");
}

function writeStatus(text) {
  elements.statusText.textContent = text;
}

function writeChatOutput(text, append = false) {
  elements.chatOutput.textContent = append ? elements.chatOutput.textContent + text : text;
}

function formatJson(value) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function token(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${prefix}_${encoded}`;
}

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonTextarea(value, fallback) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return JSON.parse(trimmed);
}

function parseMessages(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Message input is empty.");
  }
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return [{ role: "user", content: value }];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function makeCurl({ method, path, headers, body }) {
  const parts = ["curl", "-i", "-X", shellQuote(method), shellQuote(`${agentBase()}${path}`)];
  for (const [key, value] of Object.entries(headers)) {
    parts.push("-H", shellQuote(`${key}: ${value}`));
  }
  if (body !== undefined) {
    parts.push("--data", shellQuote(JSON.stringify(body)));
  }
  return parts.join(" ");
}

function clientHeaders() {
  return {
    "X-Local-Agent-Client-Id": state.clientId ?? "",
    Authorization: `Bearer ${state.credential ?? ""}`,
  };
}

function adminHeaders() {
  return {
    "X-Local-Agent-Admin-Token": state.adminToken,
  };
}

function headersFor(auth, body) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth === "client") {
    Object.assign(headers, clientHeaders());
  } else if (auth === "admin") {
    Object.assign(headers, adminHeaders());
  }
  return headers;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return { value: {}, raw: "" };
  }
  try {
    return { value: JSON.parse(text), raw: text };
  } catch {
    return { value: text, raw: text };
  }
}

function parseSseMessages(buffer, onEvent) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join("\n");
    const event = data === "[DONE]"
      ? { type: "done_marker", raw: data }
      : safeJson(data);
    onEvent(event);
  }
  return rest;
}

function safeJson(data) {
  try {
    return JSON.parse(data);
  } catch {
    return { type: "raw", raw: data };
  }
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseMessages(buffer, (event) => {
      events.push(event);
      onEvent?.(event);
    });
  }
  parseSseMessages(buffer, (event) => {
    events.push(event);
    onEvent?.(event);
  });
  return events;
}

async function apiFetch(path, options = {}) {
  const method = options.method ?? "GET";
  const auth = options.auth ?? "none";
  const body = options.body;
  const headers = {
    ...headersFor(auth, body),
    ...(options.headers ?? {}),
  };
  const init = {
    method,
    headers,
    signal: options.signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const curl = makeCurl({ method, path, headers, body });
  const started = performance.now();
  let response;
  let parsedBody;
  let raw = "";
  let events;
  let thrownError = null;

  try {
    response = await fetch(`${agentBase()}${path}`, init);
    if (options.stream && response.ok && response.body) {
      events = await readSse(response, options.onEvent);
      parsedBody = { events };
      raw = events.map((event) => JSON.stringify(event)).join("\n");
    } else {
      const parsed = await readJsonResponse(response);
      parsedBody = parsed.value;
      raw = parsed.raw;
    }
  } catch (error) {
    thrownError = error;
    parsedBody = {
      error: error instanceof Error ? error.message : String(error),
    };
    raw = formatJson(parsedBody);
  }

  const durationMs = Math.round(performance.now() - started);
  const record = {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString(),
    method,
    path,
    status: response?.status ?? 0,
    ok: response?.ok ?? false,
    durationMs,
    requestBody: body,
    responseBody: parsedBody,
    responseRaw: raw,
    curl,
  };
  pushHistory(record);
  showRecord(record);

  if (thrownError && !(thrownError instanceof DOMException && thrownError.name === "AbortError")) {
    writeStatus(parsedBody.error);
  } else if (response && !response.ok) {
    writeStatus(parsedBody?.message ?? `Request failed: ${response.status}`);
  }

  return { response, body: parsedBody, events, record, error: thrownError };
}

function pushHistory(record) {
  state.history.unshift(record);
  state.history = state.history.slice(0, 60);
  state.selectedHistoryId = record.id;
  renderHistory();
}

function showRecord(record) {
  state.selectedHistoryId = record.id;
  const statusText = record.status ? `${record.status} ${record.ok ? "OK" : "Error"}` : "Network/Abort";
  elements.resultOutput.textContent = [
    `> ${record.method} ${record.path}`,
    `Status: ${statusText}`,
    `Duration: ${record.durationMs}ms`,
    "",
    "Request:",
    formatJson(record.requestBody ?? {}),
    "",
    "Response:",
    formatJson(record.responseBody),
  ].join("\n");
  renderHistory();
}

function renderHistory() {
  elements.historyList.replaceChildren();
  for (const record of state.history) {
    const item = document.createElement("div");
    item.className = `historyItem ${record.id === state.selectedHistoryId ? "active" : ""}`;
    const meta = document.createElement("div");
    meta.className = "historyMeta";
    const left = document.createElement("span");
    left.innerHTML = `<span class="method">${record.method}</span> ${escapeHtml(record.path)}`;
    const right = document.createElement("span");
    right.className = record.ok ? "statusOk" : "statusBad";
    right.textContent = record.status ? String(record.status) : "ERR";
    meta.append(left, right);
    const sub = document.createElement("small");
    sub.textContent = `${record.time} · ${record.durationMs}ms`;
    item.append(meta, sub);
    item.addEventListener("click", () => showRecord(record));
    elements.historyList.append(item);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  writeStatus("Copied.");
}

function lastRecord() {
  return state.history.find((record) => record.id === state.selectedHistoryId) ?? state.history[0] ?? null;
}

function requireClient() {
  if (!state.clientId || !state.credential) {
    writeStatus("Pair before calling this client endpoint.");
    return false;
  }
  return true;
}

function requireAdmin() {
  if (!state.adminToken) {
    writeStatus("Enter and save an admin token before calling admin endpoints.");
    return false;
  }
  return true;
}

function confirmDanger(method, path, target = "") {
  return window.confirm(`Execute dangerous request?\n\n${method} ${path}${target ? `\nTarget: ${target}` : ""}`);
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
  localStorage.removeItem("localCliAgent.clientId");
  localStorage.removeItem("localCliAgent.credential");
  clearSessionLocal();
  renderClient();
}

function persistPairRequest(requestId, clientNonce) {
  state.pairRequest = { requestId, clientNonce };
  localStorage.setItem(pairStorageKey, JSON.stringify(state.pairRequest));
  elements.pairRequestId.value = requestId;
  elements.pairClientNonce.value = clientNonce;
}

function persistSession(summary) {
  if (!summary?.sessionId) {
    return;
  }
  state.session = {
    sessionId: summary.sessionId,
    provider: summary.provider,
    mode: summary.mode ?? "unknown",
    nativeSessionState: summary.nativeSessionState ?? null,
    messageCount: Number.isFinite(summary.messageCount) ? summary.messageCount : 0,
  };
  localStorage.setItem(sessionStorageKey, JSON.stringify(state.session));
  elements.chatSessionId.value = state.session.sessionId;
  elements.sessionIdInput.value = state.session.sessionId;
  renderSession();
}

function clearSessionLocal() {
  state.session = null;
  localStorage.removeItem(sessionStorageKey);
  renderSession();
}

function renderClient() {
  elements.clientIdText.textContent = state.clientId ?? "None";
  elements.originText.textContent = window.location.origin;
}

function renderSession() {
  const session = state.session;
  elements.sessionIdText.textContent = session?.sessionId ?? "None";
  elements.sessionModeText.textContent = session?.mode ?? "None";
  elements.nativeStateText.textContent = session?.mode === "native" ? session.nativeSessionState ?? "pending" : "N/A";
  elements.messageCountText.textContent = String(session?.messageCount ?? 0);
}

function renderAdminToken() {
  elements.adminTokenInput.value = state.adminToken;
}

function setProviderOptions(providers = state.providers) {
  const ready = providers.filter((provider) => provider.ready);
  const choices = ready.length > 0
    ? ready.map((provider) => ({ id: provider.id, name: provider.name }))
    : providerIds.map((id) => ({ id, name: id }));
  for (const select of [elements.chatProviderSelect, elements.sessionProviderSelect]) {
    const previous = select.value;
    select.replaceChildren();
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice.id;
      option.textContent = choice.name;
      select.append(option);
    }
    if (choices.some((choice) => choice.id === previous)) {
      select.value = previous;
    }
  }
}

function renderProviders(providers) {
  state.providers = providers;
  setProviderOptions(providers);
  elements.providersList.replaceChildren();
  for (const provider of providers) {
    const item = document.createElement("div");
    item.className = "listItem";
    const header = document.createElement("div");
    header.className = "listItemHeader";
    const title = document.createElement("strong");
    title.textContent = `${provider.name} (${provider.id})`;
    const badge = document.createElement("span");
    badge.className = `badge ${provider.ready ? "ready" : "warn"}`;
    badge.textContent = provider.ready ? "Ready" : "Unavailable";
    header.append(title, badge);
    const detail = document.createElement("small");
    detail.textContent = provider.message || provider.version || provider.reason || "No details";
    item.append(header, detail);
    elements.providersList.append(item);
  }
}

function renderPendingPairs(requests) {
  elements.pendingPairs.replaceChildren();
  for (const request of requests) {
    const item = document.createElement("div");
    item.className = "listItem";
    const header = document.createElement("div");
    header.className = "listItemHeader";
    const title = document.createElement("strong");
    title.textContent = request.clientName;
    const use = document.createElement("button");
    use.className = "secondary";
    use.textContent = "Use ID";
    use.addEventListener("click", () => {
      elements.pairRequestId.value = request.requestId;
      writeStatus(`Selected ${request.requestId}`);
    });
    header.append(title, use);
    const detail = document.createElement("small");
    detail.textContent = `${request.requestId} · ${request.origin ?? "no-origin"} · ${request.requestedProviders?.join(",") ?? ""}`;
    item.append(header, detail);
    elements.pendingPairs.append(item);
  }
}

function renderSessions(sessions) {
  elements.sessionsList.replaceChildren();
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "listItem";
    const header = document.createElement("div");
    header.className = "listItemHeader";
    const title = document.createElement("strong");
    title.textContent = `${session.sessionId} · ${session.provider}`;
    const use = document.createElement("button");
    use.className = "secondary";
    use.textContent = "Use";
    use.addEventListener("click", () => persistSession(session));
    header.append(title, use);
    const detail = document.createElement("small");
    detail.textContent = `${session.mode} · native ${session.nativeSessionState ?? "N/A"} · messages ${session.messageCount}`;
    item.append(header, detail);
    elements.sessionsList.append(item);
  }
}

function renderClients(clients) {
  elements.adminList.replaceChildren();
  for (const client of clients) {
    const item = document.createElement("div");
    item.className = "listItem";
    const header = document.createElement("div");
    header.className = "listItemHeader";
    const title = document.createElement("strong");
    title.textContent = `${client.clientName} · ${client.clientId}`;
    const use = document.createElement("button");
    use.className = "secondary";
    use.textContent = "Use ID";
    use.addEventListener("click", () => {
      elements.adminClientId.value = client.clientId;
      writeStatus(`Selected ${client.clientId}`);
    });
    header.append(title, use);
    const detail = document.createElement("small");
    detail.textContent = `${client.origin ?? "no-origin"} · ${client.allowedProviders.join(",")} · default ${client.defaultProvider}`;
    item.append(header, detail);
    elements.adminList.append(item);
  }
}

async function runHealth() {
  const { response, body } = await apiFetch("/health");
  if (response?.ok) {
    writeStatus(`Running on ${body.host}:${body.port}`);
  }
}

async function requestPair() {
  const nonce = token("nonce");
  const requestedCapabilities = [];
  if (elements.capChat.checked) requestedCapabilities.push("llm.chat");
  if (elements.capStream.checked) requestedCapabilities.push("llm.stream");
  if (elements.capProviders.checked) requestedCapabilities.push("llm.listProviders");
  const body = {
    clientName: elements.pairClientName.value,
    clientType: elements.pairClientType.value,
    origin: elements.pairOrigin.value,
    requestedCapabilities,
    requestedProviders: parseCsv(elements.pairProviders.value),
    clientNonce: nonce,
  };
  let result = await apiFetch("/v1/pair/request", { method: "POST", body });
  if (!result.response?.ok && result.body?.code === "provider_not_requested" && body.requestedProviders.includes("fake")) {
    body.requestedProviders = body.requestedProviders.filter((provider) => provider !== "fake");
    elements.pairProviders.value = body.requestedProviders.join(",");
    elements.pairAllowProviders.value = body.requestedProviders.join(",");
    result = await apiFetch("/v1/pair/request", { method: "POST", body });
  }
  if (result.response?.ok) {
    elements.pairAllowProviders.value = body.requestedProviders.join(",");
    persistPairRequest(result.body.requestId, nonce);
    writeStatus("Pair request created. Approve it in the app or admin panel, then poll status.");
  }
}

async function pollPairStatus() {
  const requestId = elements.pairRequestId.value || state.pairRequest?.requestId;
  const clientNonce = elements.pairClientNonce.value || state.pairRequest?.clientNonce;
  if (!requestId || !clientNonce) {
    writeStatus("Create or enter a pair request first.");
    return;
  }
  const path = `/v1/pair/status?requestId=${encodeURIComponent(requestId)}&clientNonce=${encodeURIComponent(clientNonce)}`;
  const result = await apiFetch(path);
  if (result.body?.status === "allowed" && result.body.clientId && result.body.credential) {
    persistClient(result.body.clientId, result.body.credential);
    writeStatus("Paired.");
    await loadProviders("client");
  } else {
    writeStatus(`Pairing status: ${result.body?.status ?? "unknown"}`);
  }
}

async function loadAdminStatus() {
  if (!requireAdmin()) return;
  const result = await apiFetch("/admin/status", { auth: "admin" });
  if (result.response?.ok) {
    renderPendingPairs(result.body.pendingPairRequests ?? []);
    writeStatus("Admin status loaded.");
  }
}

async function allowPair() {
  if (!requireAdmin()) return;
  const requestId = elements.pairRequestId.value.trim();
  if (!requestId) {
    writeStatus("Enter a pair request id.");
    return;
  }
  const path = `/admin/pairing/${encodeURIComponent(requestId)}/allow`;
  if (!confirmDanger("POST", path, requestId)) return;
  const body = {
    allowedProviders: parseCsv(elements.pairAllowProviders.value),
    defaultProvider: elements.pairDefaultProvider.value.trim() || undefined,
  };
  await apiFetch(path, { method: "POST", auth: "admin", body });
}

async function denyPair() {
  if (!requireAdmin()) return;
  const requestId = elements.pairRequestId.value.trim();
  if (!requestId) {
    writeStatus("Enter a pair request id.");
    return;
  }
  const path = `/admin/pairing/${encodeURIComponent(requestId)}/deny`;
  if (!confirmDanger("POST", path, requestId)) return;
  await apiFetch(path, { method: "POST", auth: "admin" });
}

async function loadProviders(kind) {
  if (kind === "client") {
    if (!requireClient()) return;
    const result = await apiFetch("/v1/providers", { auth: "client" });
    if (result.response?.ok) {
      renderProviders(result.body.providers ?? []);
    }
    return;
  }
  if (!requireAdmin()) return;
  const result = await apiFetch("/admin/providers", { auth: "admin" });
  if (result.response?.ok) {
    renderProviders(result.body.providers ?? []);
  }
}

function chatBody() {
  const body = {
    stream: elements.chatStream.checked,
    messages: parseMessages(elements.chatMessages.value),
  };
  const behavior = elements.chatSessionBehavior.value;
  if (behavior === "stateless") {
    body.provider = elements.chatProviderSelect.value;
  } else if (behavior === "create") {
    body.provider = elements.chatProviderSelect.value;
    body.session = {
      create: true,
      mode: elements.chatCreateMode.value,
    };
    const cwd = elements.chatWorkingDirectory.value.trim();
    if (cwd) {
      body.session.workingDirectory = cwd;
    }
  } else {
    body.session = { id: elements.chatSessionId.value.trim() };
  }
  return body;
}

async function sendChat() {
  if (!requireClient()) return;
  const body = chatBody();
  state.activeAbortController = new AbortController();
  state.activeRequestId = null;
  writeChatOutput("");
  const result = await apiFetch("/v1/chat", {
    method: "POST",
    auth: "client",
    body,
    stream: body.stream,
    signal: state.activeAbortController.signal,
    onEvent: (event) => {
      if (event.type === "start") {
        state.activeRequestId = event.requestId;
        if (event.session) persistSession(event.session);
        writeStatus(`Started ${event.requestId}`);
      } else if (event.type === "delta") {
        writeChatOutput(event.content ?? "", true);
      } else if (event.type === "done") {
        if (event.session) persistSession(event.session);
        writeStatus(`Done: ${event.finishReason}`);
      } else if (event.type === "error") {
        writeStatus(event.message ?? "Stream error.");
      }
    },
  });
  state.activeAbortController = null;
  if (!body.stream && result.response?.ok) {
    state.activeRequestId = result.body.requestId;
    if (result.body.session) persistSession(result.body.session);
    writeChatOutput(result.body.content ?? "");
    writeStatus(`Done: ${result.body.finishReason}`);
  }
}

async function cancelActiveRequest() {
  state.activeAbortController?.abort();
  if (!state.activeRequestId || !state.clientId || !state.credential) {
    writeStatus("No active request id to cancel.");
    return;
  }
  await apiFetch(`/v1/requests/${encodeURIComponent(state.activeRequestId)}/cancel`, {
    method: "POST",
    auth: "client",
  });
}

async function createSession() {
  if (!requireClient()) return;
  const body = {
    provider: elements.sessionProviderSelect.value,
    mode: elements.sessionModeSelect.value,
    messages: parseJsonTextarea(elements.sessionCreateMessages.value, []),
  };
  const cwd = elements.sessionWorkingDirectory.value.trim();
  if (cwd) body.workingDirectory = cwd;
  const result = await apiFetch("/v1/sessions", { method: "POST", auth: "client", body });
  if (result.response?.ok) {
    persistSession(result.body.session);
  }
}

async function listSessions() {
  if (!requireClient()) return;
  const result = await apiFetch("/v1/sessions", { auth: "client" });
  if (result.response?.ok) {
    renderSessions(result.body.sessions ?? []);
  }
}

async function getSession() {
  if (!requireClient()) return;
  const sessionId = elements.sessionIdInput.value.trim();
  if (!sessionId) {
    writeStatus("Enter a session id.");
    return;
  }
  const result = await apiFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { auth: "client" });
  if (result.response?.ok) {
    persistSession(result.body.session);
  }
}

async function deleteSession() {
  if (!requireClient()) return;
  const sessionId = elements.sessionIdInput.value.trim();
  if (!sessionId) {
    writeStatus("Enter a session id.");
    return;
  }
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  if (!confirmDanger("DELETE", path, sessionId)) return;
  const result = await apiFetch(path, { method: "DELETE", auth: "client" });
  if (result.response?.ok && state.session?.sessionId === sessionId) {
    clearSessionLocal();
  }
}

async function sendSessionChat() {
  if (!requireClient()) return;
  const sessionId = elements.sessionIdInput.value.trim();
  if (!sessionId) {
    writeStatus("Enter a session id.");
    return;
  }
  const body = {
    stream: elements.sessionChatStream.checked,
    messages: parseMessages(elements.sessionChatMessages.value),
  };
  const result = await apiFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    auth: "client",
    body,
    stream: body.stream,
    onEvent: (event) => {
      if (event.type === "start") {
        state.activeRequestId = event.requestId;
        if (event.session) persistSession(event.session);
      } else if (event.type === "done" && event.session) {
        persistSession(event.session);
      }
    },
  });
  if (!body.stream && result.response?.ok) {
    persistSession(result.body.session);
  }
}

async function openAiModels() {
  if (!requireClient()) return;
  await apiFetch("/openai/v1/models", { auth: "client" });
}

async function openAiChat() {
  if (!requireClient()) return;
  const body = {
    model: elements.openAiModel.value.trim(),
    stream: elements.openAiStream.checked,
    messages: parseMessages(elements.openAiMessages.value),
  };
  await apiFetch("/openai/v1/chat/completions", {
    method: "POST",
    auth: "client",
    body,
    stream: body.stream,
  });
}

async function adminStatus() {
  await loadAdminStatus();
}

async function adminSettingsGet() {
  if (!requireAdmin()) return;
  const result = await apiFetch("/admin/settings", { auth: "admin" });
  if (result.response?.ok) {
    elements.adminSettingsPatch.value = formatJson(result.body.settings);
  }
}

async function adminSettingsPatch() {
  if (!requireAdmin()) return;
  const body = parseJsonTextarea(elements.adminSettingsPatch.value, {});
  if (!confirmDanger("PATCH", "/admin/settings", "settings")) return;
  await apiFetch("/admin/settings", { method: "PATCH", auth: "admin", body });
}

async function adminDiagnostics() {
  if (!requireAdmin()) return;
  await apiFetch("/admin/diagnostics", { auth: "admin" });
}

async function adminClients() {
  if (!requireAdmin()) return;
  const result = await apiFetch("/admin/clients", { auth: "admin" });
  if (result.response?.ok) {
    renderClients(result.body.clients ?? []);
  }
}

async function adminClientPatch() {
  if (!requireAdmin()) return;
  const clientId = elements.adminClientId.value.trim();
  if (!clientId) {
    writeStatus("Enter a client id.");
    return;
  }
  const body = parseJsonTextarea(elements.adminClientPatch.value, {});
  const path = `/admin/clients/${encodeURIComponent(clientId)}`;
  if (!confirmDanger("PATCH", path, clientId)) return;
  await apiFetch(path, { method: "PATCH", auth: "admin", body });
}

async function adminClientDelete() {
  if (!requireAdmin()) return;
  const clientId = elements.adminClientId.value.trim();
  if (!clientId) {
    writeStatus("Enter a client id.");
    return;
  }
  const path = `/admin/clients/${encodeURIComponent(clientId)}`;
  if (!confirmDanger("DELETE", path, clientId)) return;
  await apiFetch(path, { method: "DELETE", auth: "admin" });
}

async function adminLogs() {
  if (!requireAdmin()) return;
  const limit = Number(elements.adminLogLimit.value || "100");
  await apiFetch(`/admin/logs?limit=${encodeURIComponent(String(limit))}`, { auth: "admin" });
}

async function adminLogsClear() {
  if (!requireAdmin()) return;
  if (!confirmDanger("POST", "/admin/logs/clear", "all logs")) return;
  await apiFetch("/admin/logs/clear", { method: "POST", auth: "admin" });
}

function startAdminEvents() {
  if (!requireAdmin()) return;
  if (state.adminEventsAbortController) {
    writeStatus("Admin events stream is already running.");
    return;
  }
  state.adminEventsAbortController = new AbortController();
  elements.adminEventsButton.disabled = true;
  writeStatus("Admin events connected.");
  void apiFetch("/admin/events", {
    auth: "admin",
    stream: true,
    signal: state.adminEventsAbortController.signal,
    onEvent: (event) => {
      elements.resultOutput.textContent += `\n${formatJson(event)}`;
    },
  }).finally(() => {
    state.adminEventsAbortController = null;
    elements.adminEventsButton.disabled = false;
    writeStatus("Admin events stopped.");
  });
}

function stopAdminEvents() {
  state.adminEventsAbortController?.abort();
}

function wire(id, event, handler) {
  elements[id].addEventListener(event, () => {
    Promise.resolve(handler()).catch((error) => {
      writeStatus(error instanceof Error ? error.message : String(error));
    });
  });
}

function setupNavigation() {
  for (const button of document.querySelectorAll(".navButton")) {
    button.addEventListener("click", () => {
      for (const item of document.querySelectorAll(".navButton")) {
        item.classList.toggle("active", item === button);
      }
      const key = button.dataset.section;
      for (const section of document.querySelectorAll(".apiSection")) {
        section.classList.toggle("active", section.id === `section-${key}`);
      }
    });
  }
}

function setupEvents() {
  wire("healthButton", "click", runHealth);
  wire("runHealthButton", "click", runHealth);
  wire("saveAdminTokenButton", "click", () => {
    state.adminToken = elements.adminTokenInput.value.trim();
    sessionStorage.setItem(adminTokenKey, state.adminToken);
    writeStatus("Admin token saved for this tab.");
  });
  wire("clearAdminTokenButton", "click", () => {
    state.adminToken = "";
    sessionStorage.removeItem(adminTokenKey);
    renderAdminToken();
    writeStatus("Admin token cleared.");
  });
  wire("pairRequestButton", "click", requestPair);
  wire("pairStatusButton", "click", pollPairStatus);
  wire("forgetButton", "click", () => {
    if (confirmDanger("LOCAL", "Forget Local Credential", state.clientId ?? "")) {
      clearClient();
      writeStatus("Local credential cleared.");
    }
  });
  wire("adminPendingButton", "click", loadAdminStatus);
  wire("adminAllowPairButton", "click", allowPair);
  wire("adminDenyPairButton", "click", denyPair);
  wire("clientProvidersButton", "click", () => loadProviders("client"));
  wire("adminProvidersButton", "click", () => loadProviders("admin"));
  wire("sendChatButton", "click", sendChat);
  wire("cancelButton", "click", cancelActiveRequest);
  wire("newSessionButton", "click", () => {
    clearSessionLocal();
    writeStatus("Current session cleared locally.");
  });
  wire("createSessionButton", "click", createSession);
  wire("listSessionsButton", "click", listSessions);
  wire("getSessionButton", "click", getSession);
  wire("deleteSessionButton", "click", deleteSession);
  wire("sessionChatButton", "click", sendSessionChat);
  wire("openAiModelsButton", "click", openAiModels);
  wire("openAiChatButton", "click", openAiChat);
  wire("adminStatusButton", "click", adminStatus);
  wire("adminDiagnosticsButton", "click", adminDiagnostics);
  wire("adminEventsButton", "click", startAdminEvents);
  wire("adminEventsStopButton", "click", stopAdminEvents);
  wire("adminSettingsGetButton", "click", adminSettingsGet);
  wire("adminSettingsPatchButton", "click", adminSettingsPatch);
  wire("adminClientsButton", "click", adminClients);
  wire("adminClientPatchButton", "click", adminClientPatch);
  wire("adminClientDeleteButton", "click", adminClientDelete);
  wire("adminLogsButton", "click", adminLogs);
  wire("adminLogsClearButton", "click", adminLogsClear);
  wire("copyJsonButton", "click", () => {
    const record = lastRecord();
    return record ? copyText(formatJson(record.responseBody)) : writeStatus("No response to copy.");
  });
  wire("copyCurlButton", "click", () => {
    const record = lastRecord();
    return record ? copyText(record.curl) : writeStatus("No curl to copy.");
  });
  wire("clearHistoryButton", "click", () => {
    state.history = [];
    state.selectedHistoryId = null;
    elements.resultOutput.textContent = "";
    renderHistory();
  });
}

function init() {
  elements.pairOrigin.value = window.location.origin;
  if (state.pairRequest) {
    elements.pairRequestId.value = state.pairRequest.requestId;
    elements.pairClientNonce.value = state.pairRequest.clientNonce;
  }
  if (state.session?.sessionId) {
    elements.chatSessionId.value = state.session.sessionId;
    elements.sessionIdInput.value = state.session.sessionId;
  }
  renderClient();
  renderSession();
  renderAdminToken();
  setProviderOptions();
  setupNavigation();
  setupEvents();
  void runHealth();
}

init();
