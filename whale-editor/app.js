const GRID_SIZE = 16;
const SERVICE_RUNNING_FRAME_INTERVAL_MS = 500;
const REQUEST_PROCESSING_FRAME_INTERVAL_MS = 180;
const STORAGE_KEY = "whale-pixel-editor:v1";
const STORAGE_VERSION = 1;
const EXPORT_SCOPES = new Set(["current", "all"]);

const stateDefinitions = [
  { key: "serviceRunning", label: "Service Running" },
  { key: "serviceStopped", label: "Service Stopped" },
  { key: "requestProcessing", label: "Request Processing" },
  { key: "requestSucceeded", label: "Request Succeeded" },
  { key: "requestFailed", label: "Request Failed" },
  { key: "serviceStartFailed", label: "Service Start Failed" }
];

const newFrameTemplateRows = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "...........##.##",
  "....#####...###.",
  "...#######...#..",
  "..#########.##..",
  ".#############..",
  ".###.########...",
  ".###########....",
  ".##########.....",
  "..########......",
  "................",
  "................"
];

const defaultRows = deepFreeze({
  serviceRunning: [
    [
      "................",
      "................",
      "................",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................",
      "................"
    ],
    [
      "................",
      "................",
      "................",
      "................",
      "..........##.##.",
      "....#####..###..",
      "...#######..#...",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................",
      "................"
    ]
  ],
  serviceStopped: [
    [
      "................",
      "................",
      "................",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................",
      "................"
    ]
  ],
  requestProcessing: [
    [
      "................",
      "................",
      "......#.........",
      "......#.........",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ],
    [
      "................",
      "................",
      "................",
      "......##........",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ],
    [
      "................",
      "................",
      "................",
      "......#.........",
      "......#.........",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ],
    [
      "................",
      "................",
      "................",
      ".....##.........",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ]
  ],
  requestSucceeded: [
    [
      "................",
      "................",
      "................",
      "................",
      "....#.#.........",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ],
    [
      "................",
      ".....#..........",
      "...#...#........",
      "....#.#.........",
      ".....#..........",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ]
  ],
  requestFailed: [
    [
      "................",
      "................",
      "................",
      "......#.........",
      "................",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ],
    [
      "................",
      "................",
      ".....#.#........",
      "......#.........",
      ".....#.#........",
      "...........##.##",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ]
  ],
  serviceStartFailed: [
    [
      "................",
      "......#.........",
      "......#.........",
      "................",
      "......#.........",
      "...........##.#.",
      "....#####...###.",
      "...#######...#..",
      "..#########.##..",
      ".#############..",
      ".###.########...",
      ".###########....",
      ".##########.....",
      "..########......",
      "................",
      "................"
    ]
  ]
});

const dom = {
  statusText: document.querySelector("#statusText"),
  stateList: document.querySelector("#stateList"),
  frameList: document.querySelector("#frameList"),
  pixelGrid: document.querySelector("#pixelGrid"),
  menuIcon: document.querySelector("#menuIcon"),
  largePreview: document.querySelector("#largePreview"),
  pixelCount: document.querySelector("#pixelCount"),
  validationText: document.querySelector("#validationText"),
  exportOutput: document.querySelector("#exportOutput"),
  exportCurrentButton: document.querySelector("#exportCurrentButton"),
  exportAllButton: document.querySelector("#exportAllButton"),
  resetAllButton: document.querySelector("#resetAllButton"),
  copyButton: document.querySelector("#copyButton"),
  previousFrameButton: document.querySelector("#previousFrameButton"),
  nextFrameButton: document.querySelector("#nextFrameButton"),
  addFrameButton: document.querySelector("#addFrameButton"),
  duplicateFrameButton: document.querySelector("#duplicateFrameButton"),
  deleteFrameButton: document.querySelector("#deleteFrameButton"),
  selectModeButton: document.querySelector("#selectModeButton"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  selectionCount: document.querySelector("#selectionCount"),
  shiftUpButton: document.querySelector("#shiftUpButton"),
  shiftDownButton: document.querySelector("#shiftDownButton"),
  shiftLeftButton: document.querySelector("#shiftLeftButton"),
  shiftRightButton: document.querySelector("#shiftRightButton"),
  invertButton: document.querySelector("#invertButton"),
  clearButton: document.querySelector("#clearButton"),
  playButton: document.querySelector("#playButton")
};

let initialStorageMessage = null;

const state = createInitialState();

function createInitialState() {
  const draft = loadDraft();
  const selectedStateKey = draft?.selectedStateKey ?? stateDefinitions[0].key;
  const selectedFrameIndex = draft
    ? clampFrameIndex(draft.framesByState, selectedStateKey, draft.selectedFrameIndex)
    : 0;

  return {
    framesByState: draft?.framesByState ?? createFramesFromDefaultRows(),
    selectedStateKey,
    selectedFrameIndex,
    exportScope: draft?.exportScope ?? "current",
    storageMessage: initialStorageMessage,
    isPlaying: false,
    playTimer: null,
    animationFrameIndex: selectedFrameIndex,
    selectionMode: false,
    selectedPixels: new Set(),
    pointerDown: false,
    paintValue: true
  };
}

function createFramesFromDefaultRows() {
  return Object.fromEntries(
    Object.entries(defaultRows).map(([key, frames]) => [key, frames.map(stringRowsToFrame)])
  );
}

function loadDraft() {
  let rawDraft;
  try {
    rawDraft = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    initialStorageMessage = "Storage unavailable";
    return null;
  }

  if (!rawDraft) {
    return null;
  }

  try {
    return parseDraft(JSON.parse(rawDraft));
  } catch {
    initialStorageMessage = "Recovered default";
    removeStoredDraft();
    return null;
  }
}

function parseDraft(draft) {
  if (!draft || typeof draft !== "object" || draft.version !== STORAGE_VERSION) {
    throw new Error("Unsupported draft");
  }

  const framesByState = parseStoredFrames(draft.framesByState);
  const selectedStateKey = stateDefinitions.some((definition) => definition.key === draft.selectedStateKey)
    ? draft.selectedStateKey
    : stateDefinitions[0].key;
  const selectedFrameIndex = Number.isInteger(draft.selectedFrameIndex)
    ? draft.selectedFrameIndex
    : 0;
  const exportScope = EXPORT_SCOPES.has(draft.exportScope) ? draft.exportScope : "current";

  return {
    framesByState,
    selectedStateKey,
    selectedFrameIndex,
    exportScope
  };
}

function parseStoredFrames(storedFrames) {
  if (!storedFrames || typeof storedFrames !== "object" || Array.isArray(storedFrames)) {
    throw new Error("Invalid draft frames");
  }

  return Object.fromEntries(
    stateDefinitions.map((definition) => {
      const frames = storedFrames[definition.key];
      if (!Array.isArray(frames) || frames.length === 0) {
        throw new Error("Missing draft state");
      }

      return [definition.key, frames.map(parseStoredFrameRows)];
    })
  );
}

function parseStoredFrameRows(rows) {
  if (!validateStoredRows(rows)) {
    throw new Error("Invalid draft frame");
  }

  return stringRowsToFrame(rows);
}

function validateStoredRows(rows) {
  return (
    Array.isArray(rows) &&
    rows.length === GRID_SIZE &&
    rows.every((row) => typeof row === "string" && row.length === GRID_SIZE && /^[.#]+$/.test(row))
  );
}

function clampFrameIndex(framesByState, stateKey, index) {
  return clamp(index, 0, framesByState[stateKey].length - 1);
}

function saveDraft() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(createDraftPayload()));
    state.storageMessage = null;
  } catch {
    state.storageMessage = "Storage unavailable";
  }
}

function createDraftPayload() {
  return {
    version: STORAGE_VERSION,
    framesByState: serializeFramesByState(),
    selectedStateKey: state.selectedStateKey,
    selectedFrameIndex: state.selectedFrameIndex,
    exportScope: state.exportScope
  };
}

function serializeFramesByState() {
  return Object.fromEntries(
    stateDefinitions.map((definition) => [
      definition.key,
      state.framesByState[definition.key].map(frameToRows)
    ])
  );
}

function clearStoredDraft() {
  if (removeStoredDraft()) {
    state.storageMessage = null;
  } else {
    state.storageMessage = "Storage unavailable";
  }
}

function removeStoredDraft() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

function stringRowsToFrame(rows) {
  return rows.map((row) => [...row].map((value) => value === "#"));
}

function frameToRows(frame) {
  return frame.map((row) => row.map((value) => (value ? "#" : ".")).join(""));
}

function blankFrame() {
  return Array.from({ length: GRID_SIZE }, () => Array.from({ length: GRID_SIZE }, () => false));
}

function newFrameFromTemplate() {
  return stringRowsToFrame(newFrameTemplateRows);
}

function cloneFrame(frame) {
  return frame.map((row) => [...row]);
}

function currentFrames() {
  return state.framesByState[state.selectedStateKey];
}

function currentFrame() {
  return currentFrames()[state.selectedFrameIndex];
}

function currentDefinition() {
  return stateDefinitions.find((definition) => definition.key === state.selectedStateKey);
}

function setSelectedState(key) {
  clearSelection();
  state.selectedStateKey = key;
  state.selectedFrameIndex = 0;
  state.animationFrameIndex = 0;
  restartPreviewTimer();
  saveDraft();
  renderAll();
}

function setSelectedFrame(index) {
  clearSelection();
  const frames = currentFrames();
  state.selectedFrameIndex = clamp(index, 0, frames.length - 1);
  state.animationFrameIndex = state.selectedFrameIndex;
  restartPreviewTimer();
  saveDraft();
  renderAll();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderAll() {
  renderStatus();
  renderStates();
  renderFrames();
  renderGrid();
  renderPreviews();
  renderExport();
}

function renderStatus() {
  const definition = currentDefinition();
  dom.statusText.textContent = `${definition.key} · Frame ${state.selectedFrameIndex + 1}`;
  dom.deleteFrameButton.disabled = currentFrames().length <= 1;
  dom.selectModeButton.classList.toggle("is-active", state.selectionMode);
  dom.clearSelectionButton.disabled = state.selectedPixels.size === 0;
  dom.selectionCount.textContent = `${state.selectedPixels.size} selected`;
  dom.playButton.textContent = state.isPlaying ? "Pause" : "Play";
  dom.playButton.classList.toggle("is-active", state.isPlaying);
}

function renderStates() {
  const buttons = stateDefinitions.map((definition) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "state-button";
    button.classList.toggle("is-active", definition.key === state.selectedStateKey);
    button.addEventListener("click", () => setSelectedState(definition.key));

    const name = document.createElement("span");
    name.className = "state-name";
    name.textContent = definition.label;

    const count = document.createElement("span");
    count.className = "state-count";
    count.textContent = `${state.framesByState[definition.key].length}f`;

    button.replaceChildren(name, count);
    return button;
  });
  dom.stateList.replaceChildren(...buttons);
}

function renderFrames() {
  const frames = currentFrames();
  const buttons = frames.map((frame, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "frame-button";
    button.classList.toggle("is-active", index === state.selectedFrameIndex);
    button.addEventListener("click", () => setSelectedFrame(index));

    const label = document.createElement("span");
    label.className = "frame-name";
    label.textContent = `Frame ${index + 1}`;

    button.replaceChildren(label, createMiniGrid(frame));
    return button;
  });
  dom.frameList.replaceChildren(...buttons);
}

function createMiniGrid(frame) {
  const miniGrid = document.createElement("div");
  miniGrid.className = "mini-grid";
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const pixel = document.createElement("span");
      pixel.className = "mini-pixel";
      pixel.classList.toggle("on", frame[row][column]);
      miniGrid.append(pixel);
    }
  }
  return miniGrid;
}

function renderGrid() {
  const frame = currentFrame();
  const pixels = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const pixel = document.createElement("button");
      pixel.type = "button";
      pixel.className = "pixel";
      pixel.classList.toggle("on", frame[row][column]);
      pixel.classList.toggle("selected", frame[row][column] && state.selectedPixels.has(pixelKey(row, column)));
      pixel.dataset.row = String(row);
      pixel.dataset.column = String(column);
      pixel.setAttribute("aria-label", `Row ${row + 1}, column ${column + 1}`);
      pixel.addEventListener("pointerdown", handlePixelPointerDown);
      pixel.addEventListener("pointerenter", handlePixelPointerEnter);
      pixels.push(pixel);
    }
  }
  dom.pixelGrid.replaceChildren(...pixels);
}

function handlePixelPointerDown(event) {
  event.preventDefault();
  const pixel = event.currentTarget;
  const row = Number(pixel.dataset.row);
  const column = Number(pixel.dataset.column);
  if (state.selectionMode) {
    toggleSelectedPixel(row, column);
    return;
  }
  state.pointerDown = true;
  state.paintValue = !currentFrame()[row][column];
  setPixel(row, column, state.paintValue, pixel);
}

function handlePixelPointerEnter(event) {
  if (state.selectionMode || !state.pointerDown) {
    return;
  }
  const pixel = event.currentTarget;
  setPixel(Number(pixel.dataset.row), Number(pixel.dataset.column), state.paintValue, pixel);
}

window.addEventListener("pointerup", () => {
  if (!state.pointerDown) {
    return;
  }
  state.pointerDown = false;
  renderFrames();
});

function setPixel(row, column, value, element) {
  const frame = currentFrame();
  if (frame[row][column] === value) {
    return;
  }
  frame[row][column] = value;
  if (!value) {
    state.selectedPixels.delete(pixelKey(row, column));
  }
  element?.classList.toggle("on", value);
  element?.classList.toggle("selected", value && state.selectedPixels.has(pixelKey(row, column)));
  saveDraft();
  renderStatus();
  renderPreviews();
  renderExport();
}

function pixelKey(row, column) {
  return `${row},${column}`;
}

function parsePixelKey(key) {
  const [row, column] = key.split(",").map(Number);
  return { row, column };
}

function toggleSelectionMode() {
  state.selectionMode = !state.selectionMode;
  state.pointerDown = false;
  renderStatus();
}

function toggleSelectedPixel(row, column) {
  const frame = currentFrame();
  if (!frame[row][column]) {
    return;
  }

  const key = pixelKey(row, column);
  if (state.selectedPixels.has(key)) {
    state.selectedPixels.delete(key);
  } else {
    state.selectedPixels.add(key);
  }
  renderGrid();
  renderStatus();
}

function clearSelection() {
  state.selectedPixels.clear();
  state.pointerDown = false;
}

function clearSelectionAndRender() {
  clearSelection();
  renderGrid();
  renderStatus();
}

function renderPreviews() {
  const frames = currentFrames();
  const frame = state.isPlaying ? frames[state.animationFrameIndex % frames.length] : currentFrame();
  renderFrameToElement(dom.menuIcon, frame, "preview-pixel");
  renderFrameToCanvas(dom.largePreview, frame);
  dom.pixelCount.textContent = `${countPixels(currentFrame())} pixels`;
  dom.validationText.textContent = state.storageMessage ?? (allFramesValid() ? "Valid" : "Invalid");
}

function renderFrameToElement(container, frame, className) {
  const pixels = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const pixel = document.createElement("span");
      pixel.className = className;
      pixel.classList.toggle("on", frame[row][column]);
      pixels.push(pixel);
    }
  }
  container.replaceChildren(...pixels);
}

function renderFrameToCanvas(canvas, frame) {
  const context = canvas.getContext("2d");
  const size = canvas.width;
  const cell = size / GRID_SIZE;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, size, size);
  context.fillStyle = "#f7fafc";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#172033";
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      if (frame[row][column]) {
        context.fillRect(column * cell, row * cell, cell, cell);
      }
    }
  }
}

function countPixels(frame) {
  return frame.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

function addFrame() {
  const frames = currentFrames();
  frames.push(newFrameFromTemplate());
  setSelectedFrame(frames.length - 1);
}

function duplicateFrame() {
  const frames = currentFrames();
  frames.splice(state.selectedFrameIndex + 1, 0, cloneFrame(currentFrame()));
  setSelectedFrame(state.selectedFrameIndex + 1);
}

function deleteFrame() {
  const frames = currentFrames();
  if (frames.length <= 1) {
    return;
  }
  frames.splice(state.selectedFrameIndex, 1);
  setSelectedFrame(Math.min(state.selectedFrameIndex, frames.length - 1));
}

function clearFrame() {
  clearSelection();
  replaceCurrentFrame(blankFrame());
}

function invertFrame() {
  clearSelection();
  replaceCurrentFrame(currentFrame().map((row) => row.map((value) => !value)));
}

function shiftFrame(deltaRow, deltaColumn) {
  clearSelection();
  const source = currentFrame();
  const next = blankFrame();
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const targetRow = row + deltaRow;
      const targetColumn = column + deltaColumn;
      if (
        targetRow >= 0 &&
        targetRow < GRID_SIZE &&
        targetColumn >= 0 &&
        targetColumn < GRID_SIZE
      ) {
        next[targetRow][targetColumn] = source[row][column];
      }
    }
  }
  replaceCurrentFrame(next);
}

function replaceCurrentFrame(frame) {
  currentFrames()[state.selectedFrameIndex] = frame;
  saveDraft();
  renderAll();
}

function togglePlayback() {
  state.isPlaying = !state.isPlaying;
  if (state.isPlaying) {
    state.animationFrameIndex = state.selectedFrameIndex;
    restartPreviewTimer();
  } else {
    window.clearTimeout(state.playTimer);
    state.playTimer = null;
  }
  renderStatus();
  renderPreviews();
}

function restartPreviewTimer() {
  if (!state.isPlaying) {
    return;
  }

  window.clearTimeout(state.playTimer);
  state.playTimer = null;
  if (currentFrames().length > 1) {
    scheduleNextPreviewFrame(previewDelayForCurrentFrame());
  }
}

function scheduleNextPreviewFrame(delay) {
  window.clearTimeout(state.playTimer);
  state.playTimer = window.setTimeout(advancePreviewFrame, delay);
}

function advancePreviewFrame() {
  if (!state.isPlaying) {
    return;
  }

  state.playTimer = null;
  state.animationFrameIndex = (state.animationFrameIndex + 1) % currentFrames().length;
  renderPreviews();
  restartPreviewTimer();
}

function previewDelayForCurrentFrame() {
  return frameIntervalForState(state.selectedStateKey);
}

function frameIntervalForState(key) {
  switch (key) {
    case "serviceRunning":
      return SERVICE_RUNNING_FRAME_INTERVAL_MS;
    case "requestProcessing":
      return REQUEST_PROCESSING_FRAME_INTERVAL_MS;
    case "requestSucceeded":
      return 300;
    case "requestFailed":
      return 350;
    case "serviceStartFailed":
      return 700;
    case "serviceStopped":
    default:
      return 1000;
  }
}

function stopPlayback() {
  if (!state.isPlaying) {
    return;
  }
  state.isPlaying = false;
  window.clearTimeout(state.playTimer);
  state.playTimer = null;
}

function resetAll() {
  const selectedStateKey = state.selectedStateKey;
  const selectedFrameIndex = state.selectedFrameIndex;
  stopPlayback();
  clearSelection();
  state.framesByState = createFramesFromDefaultRows();
  state.selectedStateKey = selectedStateKey;
  state.selectedFrameIndex =
    selectedFrameIndex < currentFrames().length ? selectedFrameIndex : 0;
  state.animationFrameIndex = state.selectedFrameIndex;
  clearStoredDraft();
  renderAll();
}

function selectedCoordinates() {
  const frame = currentFrame();
  const coordinates = [];
  for (const key of [...state.selectedPixels]) {
    const coordinate = parsePixelKey(key);
    if (frame[coordinate.row]?.[coordinate.column]) {
      coordinates.push(coordinate);
    } else {
      state.selectedPixels.delete(key);
    }
  }
  return coordinates;
}

function moveSelectedPixels(deltaRow, deltaColumn) {
  const coordinates = selectedCoordinates();
  if (coordinates.length === 0) {
    renderStatus();
    return;
  }

  const targets = coordinates.map(({ row, column }) => ({
    row: row + deltaRow,
    column: column + deltaColumn
  }));
  const wouldLeaveGrid = targets.some(
    ({ row, column }) => row < 0 || row >= GRID_SIZE || column < 0 || column >= GRID_SIZE
  );
  if (wouldLeaveGrid) {
    return;
  }

  const frame = currentFrame();
  for (const { row, column } of coordinates) {
    frame[row][column] = false;
  }
  state.selectedPixels = new Set();
  for (const { row, column } of targets) {
    frame[row][column] = true;
    state.selectedPixels.add(pixelKey(row, column));
  }
  saveDraft();
  renderAll();
}

function handleKeyDown(event) {
  if (isTextEditingTarget(event.target) || state.selectedPixels.size === 0) {
    return;
  }

  const movement = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }[event.key];
  if (!movement) {
    return;
  }

  event.preventDefault();
  moveSelectedPixels(movement[0], movement[1]);
}

function isTextEditingTarget(target) {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target?.isContentEditable === true
  );
}

function allFramesValid() {
  return Object.values(state.framesByState)
    .flat()
    .every(validateFrame);
}

function validateFrame(frame) {
  return (
    frame.length === GRID_SIZE &&
    frame.every((row) => row.length === GRID_SIZE && row.every((value) => typeof value === "boolean"))
  );
}

function exportCurrent() {
  state.exportScope = "current";
  saveDraft();
  renderPreviews();
  renderExport();
}

function exportAll() {
  state.exportScope = "all";
  saveDraft();
  renderPreviews();
  renderExport();
}

function renderExport() {
  dom.exportCurrentButton.classList.toggle("is-active", state.exportScope === "current");
  dom.exportAllButton.classList.toggle("is-active", state.exportScope === "all");
  dom.exportOutput.value = state.exportScope === "current" ? formatState(state.selectedStateKey) : formatAllStates();
}

function formatAllStates() {
  return ["switch state {", ...stateDefinitions.map((definition) => indent(formatState(definition.key), 0)), "}"].join("\n");
}

function formatState(key) {
  const frames = state.framesByState[key];
  return [
    `case .${key}:`,
    "    return [",
    frames.map((frame) => indent(formatRowsCall(frame), 8)).join(",\n"),
    "    ]"
  ].join("\n");
}

function formatRowsCall(frame) {
  const rows = frameToRows(frame);
  return [
    "rows(",
    rows.map((row, index) => `    "${row}"${index === rows.length - 1 ? "" : ","}`).join("\n"),
    ")"
  ].join("\n");
}

function indent(text, spaces) {
  const padding = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

async function copyExport() {
  dom.exportOutput.select();
  try {
    await navigator.clipboard.writeText(dom.exportOutput.value);
  } catch {
    document.execCommand("copy");
  }
}

dom.exportCurrentButton.addEventListener("click", exportCurrent);
dom.exportAllButton.addEventListener("click", exportAll);
dom.resetAllButton.addEventListener("click", resetAll);
dom.copyButton.addEventListener("click", copyExport);
dom.selectModeButton.addEventListener("click", toggleSelectionMode);
dom.clearSelectionButton.addEventListener("click", clearSelectionAndRender);
dom.previousFrameButton.addEventListener("click", () => setSelectedFrame(state.selectedFrameIndex - 1));
dom.nextFrameButton.addEventListener("click", () => setSelectedFrame(state.selectedFrameIndex + 1));
dom.addFrameButton.addEventListener("click", addFrame);
dom.duplicateFrameButton.addEventListener("click", duplicateFrame);
dom.deleteFrameButton.addEventListener("click", deleteFrame);
dom.shiftUpButton.addEventListener("click", () => shiftFrame(-1, 0));
dom.shiftDownButton.addEventListener("click", () => shiftFrame(1, 0));
dom.shiftLeftButton.addEventListener("click", () => shiftFrame(0, -1));
dom.shiftRightButton.addEventListener("click", () => shiftFrame(0, 1));
dom.invertButton.addEventListener("click", invertFrame);
dom.clearButton.addEventListener("click", clearFrame);
dom.playButton.addEventListener("click", togglePlayback);
window.addEventListener("keydown", handleKeyDown);

renderAll();
