const canvas = document.querySelector("#boardCanvas");
const editor = document.querySelector("#inlineEditor");
const edgeEditor = document.querySelector("#edgeLabelEditor");
const toastEl = document.querySelector("#toast");
const contextMenu = document.querySelector("#contextMenu");
const imagePicker = document.querySelector("#imagePicker");
const boardPicker = document.querySelector("#boardPicker");
const ctx = canvas.getContext("2d", { alpha: false });

const NODE_RADIUS = 10;
const HANDLE_RADIUS = 5;
const HANDLE_VISIBLE_MIN_SCALE = 0.48;
const EDGE_HIT_TOLERANCE_PX = 22;
const EDGE_LABEL_HIT_TOLERANCE_PX = 30;
const CONNECT_SNAP_RADIUS = 34;
const CONNECT_DRAG_START_PX = 12;
const MIN_NODE_W = 96;
const MIN_NODE_H = 48;
const DEFAULT_TEXT_NODE_W = 168;
const DEFAULT_TEXT_NODE_H = MIN_NODE_H;
const DEFAULT_LINK_NODE_W = 240;
const DEFAULT_LINK_NODE_H = 84;
const GRID = 32;
const DPR_MAX = 2;
const TEXT_PADDING = 14;
const TEXT_CLIP_PAD = 4;
const GROUP_PAD = 24;
const MAX_IMAGE_CACHE = 350;
const HISTORY_LIMIT = 80;
const CROP_EDGE_HIT = 13;
const CROP_HANDLE_SIZE = 11;
const MIN_CROP_SPAN = 0.05;
const STORAGE_KEY = "mindboard.desktop.board.v2";
const WEB_DB_NAME = "mindboard-web";
const WEB_DB_VERSION = 1;
const WEB_BOARD_STORE = "boards";
const WEB_BOARD_KEY = "default";
const DEFAULT_BOARD_URL = "./0南大碎尸案.mindboard";
const JUMP_SLOTS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

const colors = {
  bg: "#f5f3ee",
  gridFine: "#e8e3da",
  gridStrong: "#ddd6cb",
  text: "#26231f",
  muted: "#77736b",
  border: "#d6cec0",
  selected: "#0f7887",
  edge: "#7a756b",
  shadow: "rgba(31, 28, 23, 0.12)"
};

const state = {
  board: { version: 2, view: { x: 0, y: 0, scale: 1, gridVisible: true }, nodes: [], edges: [], groups: [], jumpAreas: {} },
  tool: "select",
  selectedNodes: new Set(),
  selectedEdges: new Set(),
  selectedGroups: new Set(),
  lastJumpSelection: undefined,
  bindingJumpArea: false,
  clearingJumpArea: false,
  hoverNode: undefined,
  hoverHandle: undefined,
  hoverCrop: undefined,
  hoverEdge: undefined,
  pointer: undefined,
  editingNode: undefined,
  editingEdge: undefined,
  saveTimer: undefined,
  redrawQueued: false,
  spaceDown: false,
  pointerWorld: { x: 0, y: 0 },
  imageCache: new Map(),
  textCache: new Map(),
  history: { undo: [], redo: [], applying: false },
  editSession: undefined,
  edgeEditSession: undefined
};

let webDbPromise;

function emptyBoard() {
  return { version: 2, view: { x: 0, y: 0, scale: 1, gridVisible: true }, nodes: [], edges: [], groups: [], jumpAreas: {} };
}

function hasBoardContent(board) {
  return Boolean(board?.nodes?.length || board?.edges?.length || board?.groups?.length);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openWebDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (!webDbPromise) {
    webDbPromise = new Promise((resolve) => {
      const request = indexedDB.open(WEB_DB_NAME, WEB_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WEB_BOARD_STORE)) db.createObjectStore(WEB_BOARD_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("IndexedDB is unavailable; falling back to localStorage.", request.error);
        resolve(null);
      };
      request.onblocked = () => {
        console.warn("IndexedDB upgrade is blocked by another MindBoard tab.");
      };
    });
  }
  return webDbPromise;
}

async function loadWebBoard() {
  const db = await openWebDb();
  if (db) {
    const board = await idbRequest(db.transaction(WEB_BOARD_STORE, "readonly").objectStore(WEB_BOARD_STORE).get(WEB_BOARD_KEY));
    if (hasBoardContent(board)) return board;
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const board = JSON.parse(raw);
    if (hasBoardContent(board)) return board;
  }
  try {
    const response = await fetch(DEFAULT_BOARD_URL);
    if (response.ok) return response.json();
    console.warn(`Default board ${DEFAULT_BOARD_URL} returned ${response.status}.`);
  } catch (error) {
    console.warn("Could not load the default board; opening an empty board.", error);
  }
  return emptyBoard();
}

async function saveWebBoard(board) {
  const db = await openWebDb();
  if (db) {
    await idbRequest(db.transaction(WEB_BOARD_STORE, "readwrite").objectStore(WEB_BOARD_STORE).put(board, WEB_BOARD_KEY));
    return { ok: true };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  return { ok: true };
}

const localBridge = {
  async loadBoard() {
    return loadWebBoard();
  },
  async saveBoard(board) {
    return saveWebBoard(board);
  },
  async pickImages() {
    return pickFiles(imagePicker).then(filesToImages);
  },
  async importFilePaths() {
    return [];
  },
  async readClipboardImage() {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((value) => value.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return fileToImage(new File([blob], "clipboard.png", { type }));
    }
    return null;
  },
  async readClipboardText() {
    if (!navigator.clipboard?.readText) return "";
    return navigator.clipboard.readText();
  },
  async exportBoard(board) {
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "board.mindboard";
    anchor.click();
    URL.revokeObjectURL(url);
    return { ok: true };
  },
  async importBoard() {
    const files = await pickFiles(boardPicker);
    if (!files.length) return null;
    return JSON.parse(await files[0].text());
  },
  getPathForFile() {
    return "";
  }
};

if (!window.mindboard) {
  window.mindboard = localBridge;
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed.", error);
    });
  });
}

function pickFiles(input) {
  return new Promise((resolve) => {
    input.value = "";
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

async function filesToImages(files) {
  const images = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      images.push(await fileToImage(file));
    }
  }
  return images;
}

async function fileToImage(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const size = await imageSize(dataUrl);
  return {
    asset: file.name,
    assetUrl: dataUrl,
    dataUrl,
    width: size.width,
    height: size.height
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageSize(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 360, height: image.naturalHeight || 240 });
    image.onerror = () => resolve({ width: 360, height: 240 });
    image.src = src;
  });
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function snap(value) {
  return Math.round(value / 8) * 8;
}

function normalizeRect(rect) {
  if (!rect) return undefined;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h)
  };
}

function usefulRect(rect) {
  return Boolean(rect && rect.w >= 16 && rect.h >= 16);
}

function normalizeJumpAreas(input) {
  const areas = {};
  if (!input || typeof input !== "object") return areas;
  for (const slot of JUMP_SLOTS) {
    const rect = normalizeRect(input[slot]);
    if (usefulRect(rect)) areas[slot] = rect;
  }
  return areas;
}

function normalizeBoard(board) {
  const safe = board && typeof board === "object" ? board : {};
  return {
    version: safe.version || 2,
    view: {
      x: Number.isFinite(safe.view?.x) ? safe.view.x : 0,
      y: Number.isFinite(safe.view?.y) ? safe.view.y : 0,
      scale: clamp(Number.isFinite(safe.view?.scale) ? safe.view.scale : 1, 0.12, 3.5),
      gridVisible: safe.view?.gridVisible !== false
    },
    nodes: Array.isArray(safe.nodes)
      ? safe.nodes.map((node) => ({
          ...node,
          color: node.color || "#fffdf8",
          textColor: node.textColor || colors.text,
          text: node.text ?? "",
          w: Math.max(MIN_NODE_W, Number(node.w) || DEFAULT_TEXT_NODE_W),
          h: Math.max(MIN_NODE_H, Number(node.h) || DEFAULT_TEXT_NODE_H),
          scrollY: Math.max(0, Number(node.scrollY) || 0),
          assetUrl: node.assetUrl || node.dataUrl || node.assetUrl,
          crop: node.kind === "image" ? normalizedCrop(node.crop) : node.crop
        }))
      : [],
    edges: Array.isArray(safe.edges)
      ? safe.edges.map((edge) => ({
          ...edge,
          color: edge.color || colors.edge,
          label: edge.label || "",
          arrow: edge.arrow || "forward"
        }))
      : [],
    groups: Array.isArray(safe.groups) ? safe.groups : [],
    jumpAreas: normalizeJumpAreas(safe.jumpAreas)
  };
}

function boardForSave() {
  return {
    ...state.board,
    nodes: state.board.nodes.map((node) => ({ ...node, dataUrl: node.dataUrl || node.assetUrl }))
  };
}

function boardSnapshot() {
  return JSON.stringify(boardForSave());
}

function gridVisible() {
  return state.board.view?.gridVisible !== false;
}

function updateGridToggle() {
  const visible = gridVisible();
  const button = document.querySelector("[data-action='toggle-grid']");
  if (!button) return;
  button.classList.toggle("enabled", visible);
  button.setAttribute("aria-pressed", String(visible));
  button.title = visible ? "隐藏网格" : "显示网格";
}

function toggleGridVisibility(visible) {
  if (gridVisible() === visible) return;
  state.board.view.gridVisible = visible;
  updateGridToggle();
  scheduleSave();
  queueRedraw();
}

function updateHistoryButtons() {
  document.querySelector("[data-action='undo']")?.toggleAttribute("disabled", !state.history.undo.length);
  document.querySelector("[data-action='redo']")?.toggleAttribute("disabled", !state.history.redo.length);
}

function pushUndoSnapshot(snapshot) {
  const undo = state.history.undo;
  if (undo[undo.length - 1] !== snapshot) {
    undo.push(snapshot);
    if (undo.length > HISTORY_LIMIT) undo.shift();
  }
}

function recordHistory(snapshot = boardSnapshot()) {
  if (state.history.applying) return;
  pushUndoSnapshot(snapshot);
  state.history.redo = [];
  updateHistoryButtons();
}

function restoreBoardSnapshot(snapshot) {
  state.history.applying = true;
  try {
    const currentGridVisible = gridVisible();
    state.board = normalizeBoard(JSON.parse(snapshot));
    state.board.view.gridVisible = currentGridVisible;
    state.pointer = undefined;
    state.hoverNode = undefined;
    state.hoverHandle = undefined;
    state.hoverCrop = undefined;
    state.hoverEdge = undefined;
    state.editingNode = undefined;
    state.editingEdge = undefined;
    state.editSession = undefined;
    state.edgeEditSession = undefined;
    editor.style.display = "none";
    edgeEditor.style.display = "none";
    clearSelection();
    exitJumpModes();
    state.lastJumpSelection = undefined;
    state.textCache.clear();
    updateZoomReadout();
    updateGridToggle();
    updateInspector();
    updateJumpPanel();
    scheduleSave();
    queueRedraw();
  } finally {
    state.history.applying = false;
    updateHistoryButtons();
  }
}

function undoBoard() {
  if (state.editingNode) finishEditing(true);
  if (state.editingEdge) finishEdgeLabelEditing(true);
  const previous = state.history.undo.pop();
  if (!previous) {
    updateHistoryButtons();
    return;
  }
  state.history.redo.push(boardSnapshot());
  restoreBoardSnapshot(previous);
}

function redoBoard() {
  if (state.editingNode) finishEditing(true);
  if (state.editingEdge) finishEdgeLabelEditing(true);
  const next = state.history.redo.pop();
  if (!next) {
    updateHistoryButtons();
    return;
  }
  pushUndoSnapshot(boardSnapshot());
  restoreBoardSnapshot(next);
}

function screenToWorld(point) {
  return {
    x: (point.x - state.board.view.x) / state.board.view.scale,
    y: (point.y - state.board.view.y) / state.board.view.scale
  };
}

function worldToScreen(point) {
  return {
    x: point.x * state.board.view.scale + state.board.view.x,
    y: point.y * state.board.view.scale + state.board.view.y
  };
}

function screenPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function nodeCenter(node) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function sidePoint(node, side) {
  if (side === "top") return { x: node.x + node.w / 2, y: node.y };
  if (side === "right") return { x: node.x + node.w, y: node.y + node.h / 2 };
  if (side === "bottom") return { x: node.x + node.w / 2, y: node.y + node.h };
  return { x: node.x, y: node.y + node.h / 2 };
}

function oppositeSide(side) {
  if (side === "top") return "bottom";
  if (side === "right") return "left";
  if (side === "bottom") return "top";
  return "right";
}

function resizeHandles(node) {
  return [
    { corner: "nw", x: node.x, y: node.y },
    { corner: "ne", x: node.x + node.w, y: node.y },
    { corner: "se", x: node.x + node.w, y: node.y + node.h },
    { corner: "sw", x: node.x, y: node.y + node.h }
  ];
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function visibleWorld() {
  const topLeft = screenToWorld({ x: 0, y: 0 });
  const bottomRight = screenToWorld({ x: canvas.clientWidth, y: canvas.clientHeight });
  const pad = 260 / state.board.view.scale;
  return {
    x: topLeft.x - pad,
    y: topLeft.y - pad,
    w: bottomRight.x - topLeft.x + pad * 2,
    h: bottomRight.y - topLeft.y + pad * 2
  };
}

function setTool(tool) {
  state.tool = tool;
  if (tool !== "crop") state.hoverCrop = undefined;
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === tool);
  });
}

function selectedImageNode() {
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node?.kind === "image") return node;
  }
  return undefined;
}

function toggleCropMode() {
  finishEditing(true);
  finishEdgeLabelEditing(true);
  if (state.tool === "crop") {
    setTool("select");
    queueRedraw();
    return;
  }
  const node = selectedImageNode();
  if (!node) {
    showToast("先选择一张图片");
    return;
  }
  setTool("crop");
  state.hoverCrop = undefined;
  updateInspector();
  queueRedraw();
}

function selectOnlyNode(nodeId) {
  state.selectedNodes = new Set([nodeId]);
  state.selectedEdges.clear();
  state.selectedGroups.clear();
  state.hoverEdge = undefined;
  bringNodesToFront([nodeId]);
  const node = getNode(nodeId);
  if (state.tool === "crop" && node?.kind !== "image") setTool("select");
  updateInspector();
  queueRedraw();
}

function clearSelection() {
  state.selectedNodes.clear();
  state.selectedEdges.clear();
  state.selectedGroups.clear();
  state.hoverEdge = undefined;
  if (state.tool === "crop") setTool("select");
  state.hoverCrop = undefined;
  updateInspector();
}

function selectOnlyEdge(edgeId) {
  state.selectedNodes.clear();
  state.selectedGroups.clear();
  state.selectedEdges = new Set([edgeId]);
  state.hoverEdge = edgeId;
  updateInspector();
  queueRedraw();
}

function bringNodesToFront(ids) {
  const wanted = new Set(ids);
  const back = state.board.nodes.filter((node) => !wanted.has(node.id));
  const front = state.board.nodes.filter((node) => wanted.has(node.id));
  state.board.nodes = [...back, ...front];
}

function getNode(id) {
  return state.board.nodes.find((node) => node.id === id);
}

function getGroup(id) {
  return state.board.groups.find((group) => group.id === id);
}

function getEdge(id) {
  return state.board.edges.find((edge) => edge.id === id);
}

function groupedNodeIds(group) {
  return state.board.nodes
    .filter((node) => pointInRect(nodeCenter(node), group))
    .map((node) => node.id);
}

function makeTextNode(point, text = "新笔记") {
  return {
    id: uid("node"),
    kind: "text",
    x: snap(point.x - DEFAULT_TEXT_NODE_W / 2),
    y: snap(point.y - DEFAULT_TEXT_NODE_H / 2),
    w: DEFAULT_TEXT_NODE_W,
    h: DEFAULT_TEXT_NODE_H,
    text,
    scrollY: 0,
    textColor: colors.text,
    color: "#fffdf8"
  };
}

function makeLinkNode(point) {
  return {
    id: uid("node"),
    kind: "link",
    x: snap(point.x - DEFAULT_LINK_NODE_W / 2),
    y: snap(point.y - DEFAULT_LINK_NODE_H / 2),
    w: DEFAULT_LINK_NODE_W,
    h: DEFAULT_LINK_NODE_H,
    text: "https://example.com",
    url: "https://example.com",
    scrollY: 0,
    textColor: colors.text,
    color: "#e9f3ff"
  };
}

function makeImageNode(point, image) {
  const maxW = 380;
  const scale = Math.min(1, maxW / Math.max(1, image.width));
  const w = Math.max(180, Math.round(image.width * scale));
  const h = Math.max(120, Math.round(image.height * scale));
  return {
    id: uid("node"),
    kind: "image",
    x: snap(point.x - w / 2),
    y: snap(point.y - h / 2),
    w,
    h,
    text: "",
    color: "#fffdf8",
    asset: image.asset,
    assetUrl: image.assetUrl || image.dataUrl,
    dataUrl: image.dataUrl || image.assetUrl,
    crop: { left: 0, top: 0, right: 1, bottom: 1 }
  };
}

function makeEdge(fromNode, fromSide, toNode, toSide) {
  return {
    id: uid("edge"),
    fromNode,
    fromSide,
    toNode,
    toSide,
    color: colors.edge,
    label: "",
    arrow: "forward"
  };
}

function addNode(node, edit = false, options = {}) {
  if (options.record !== false) recordHistory();
  state.board.nodes.push(node);
  selectOnlyNode(node.id);
  scheduleSave();
  if (edit && node.kind !== "image") {
    requestAnimationFrame(() => editNode(node.id));
  }
}

function addEdge(edge, options = {}) {
  const exists = state.board.edges.some(
    (item) =>
      item.fromNode === edge.fromNode &&
      item.toNode === edge.toNode &&
      item.fromSide === edge.fromSide &&
      item.toSide === edge.toSide
  );
  if (!exists && edge.fromNode !== edge.toNode) {
    if (options.record !== false) recordHistory();
    state.board.edges.push(edge);
    scheduleSave();
  }
}

function removeSelection() {
  if (state.editingNode) finishEditing(true);
  if (state.editingEdge) finishEdgeLabelEditing(true);
  if (!state.selectedNodes.size && !state.selectedEdges.size && !state.selectedGroups.size) return;
  recordHistory();
  const nodes = new Set(state.selectedNodes);
  const edges = new Set(state.selectedEdges);
  const groups = new Set(state.selectedGroups);
  state.board.nodes = state.board.nodes.filter((node) => !nodes.has(node.id));
  state.board.edges = state.board.edges.filter(
    (edge) => !edges.has(edge.id) && !nodes.has(edge.fromNode) && !nodes.has(edge.toNode)
  );
  state.board.groups = state.board.groups.filter((group) => !groups.has(group.id));
  clearSelection();
  scheduleSave();
  queueRedraw();
}

function duplicateSelection() {
  if (!state.selectedNodes.size) return;
  recordHistory();
  const idMap = new Map();
  const copies = state.board.nodes
    .filter((node) => state.selectedNodes.has(node.id))
    .map((node) => {
      const id = uid("node");
      idMap.set(node.id, id);
      return { ...node, id, x: node.x + 32, y: node.y + 32 };
    });
  const edgeCopies = state.board.edges
    .filter((edge) => idMap.has(edge.fromNode) && idMap.has(edge.toNode))
    .map((edge) => ({
      ...edge,
      id: uid("edge"),
      fromNode: idMap.get(edge.fromNode),
      toNode: idMap.get(edge.toNode)
    }));
  state.board.nodes.push(...copies);
  state.board.edges.push(...edgeCopies);
  state.selectedNodes = new Set(copies.map((node) => node.id));
  bringNodesToFront([...state.selectedNodes]);
  updateInspector();
  scheduleSave();
  queueRedraw();
}

function createGroupFromSelection() {
  recordHistory();
  const selected = state.board.nodes.filter((node) => state.selectedNodes.has(node.id));
  if (!selected.length) {
    const p = state.pointerWorld;
    state.board.groups.push({
      id: uid("group"),
      x: snap(p.x - 180),
      y: snap(p.y - 120),
      w: 360,
      h: 240,
      title: "分组",
      color: "rgba(15, 120, 135, 0.08)"
    });
  } else {
    const minX = Math.min(...selected.map((node) => node.x)) - GROUP_PAD;
    const minY = Math.min(...selected.map((node) => node.y)) - GROUP_PAD;
    const maxX = Math.max(...selected.map((node) => node.x + node.w)) + GROUP_PAD;
    const maxY = Math.max(...selected.map((node) => node.y + node.h)) + GROUP_PAD;
    state.board.groups.push({
      id: uid("group"),
      x: snap(minX),
      y: snap(minY),
      w: snap(maxX - minX),
      h: snap(maxY - minY),
      title: "分组",
      color: "rgba(15, 120, 135, 0.08)"
    });
  }
  scheduleSave();
  queueRedraw();
}

function draw() {
  state.redrawQueued = false;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scaledW = Math.max(1, Math.floor(width * dpr));
  const scaledH = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== scaledW || canvas.height !== scaledH) {
    canvas.width = scaledW;
    canvas.height = scaledH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  if (gridVisible()) drawGrid(width, height);

  ctx.save();
  ctx.translate(state.board.view.x, state.board.view.y);
  ctx.scale(state.board.view.scale, state.board.view.scale);
  drawWorld();
  ctx.restore();

  repositionEditor();
  repositionEdgeLabelEditor();
}

function queueRedraw() {
  if (state.redrawQueued) return;
  state.redrawQueued = true;
  requestAnimationFrame(draw);
}

function drawGrid(width, height) {
  const scale = state.board.view.scale;
  const step = GRID * scale;
  if (step < 8) return;
  const startX = state.board.view.x % step;
  const startY = state.board.view.y % step;
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.gridFine;
  ctx.beginPath();
  for (let x = startX; x < width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = startY; y < height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const strong = step * 4;
  if (strong < 28) return;
  ctx.strokeStyle = colors.gridStrong;
  ctx.beginPath();
  for (let x = state.board.view.x % strong; x < width; x += strong) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = state.board.view.y % strong; y < height; y += strong) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

function drawWorld() {
  const view = visibleWorld();
  for (const group of state.board.groups) {
    if (rectsOverlap(group, view)) drawGroup(group);
  }
  for (const edge of state.board.edges) {
    if (edgeVisible(edge, view)) drawEdge(edge);
  }
  drawJumpSelection();
  drawMarqueeSelection();
  if (state.pointer?.type === "connect" && state.pointer.dragged) {
    drawConnectionPreview(state.pointer);
  }
  for (const node of state.board.nodes) {
    if (rectsOverlap(node, view)) drawNode(node);
  }
}

function drawGroup(group) {
  ctx.save();
  ctx.fillStyle = group.color || "rgba(15, 120, 135, 0.08)";
  ctx.strokeStyle = state.selectedGroups.has(group.id) ? colors.selected : "rgba(66, 60, 50, 0.18)";
  ctx.lineWidth = state.selectedGroups.has(group.id) ? 2 : 1;
  ctx.beginPath();
  roundRect(group.x, group.y, group.w, group.h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#5b564d";
  ctx.font = "600 14px Inter, Segoe UI, sans-serif";
  ctx.fillText(group.title || "分组", group.x + 14, group.y + 24);
  ctx.restore();
}

function drawNode(node) {
  const selected = state.selectedNodes.has(node.id);
  const cropping = selected && node.kind === "image" && state.tool === "crop";
  ctx.save();
  ctx.shadowColor = colors.shadow;
  ctx.shadowBlur = selected ? 18 : 10;
  ctx.shadowOffsetY = selected ? 8 : 4;
  ctx.fillStyle = node.color || "#fffdf8";
  ctx.strokeStyle = selected ? colors.selected : colors.border;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.beginPath();
  roundRect(node.x, node.y, node.w, node.h, NODE_RADIUS);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.stroke();

  if (node.kind === "image") drawImageNode(node);
  else drawTextNode(node);

  if (cropping) {
    drawCropOverlay(node);
  } else if (shouldShowNodeHandles(node, selected)) {
    drawNodeHandles(node, selected);
  }
  if (selected && !cropping) {
    drawResizeHandles(node);
  }
  ctx.restore();
}

function drawTextNode(node) {
  const scale = state.board.view.scale;
  const fontSize = node.kind === "link" ? 14 : 15;
  ctx.save();
  ctx.beginPath();
  roundRect(node.x + 1, node.y + 1, node.w - 2, node.h - 2, NODE_RADIUS);
  ctx.clip();

  const title = node.kind === "link" ? "网页" : "";
  if (title) {
    ctx.fillStyle = colors.muted;
    ctx.font = "650 12px Inter, Segoe UI, sans-serif";
    ctx.fillText(title, node.x + TEXT_PADDING, node.y + 22);
  }

  if (state.editingNode === node.id) {
    ctx.restore();
    updateJumpPanel();
    return;
  }

  ctx.fillStyle = node.textColor || colors.text;
  ctx.textBaseline = "middle";
  const textInfo = textNodeScrollInfo(node);
  const scrollY = clamp(Number(node.scrollY) || 0, 0, textInfo.maxScroll);
  const firstLine = Math.max(0, Math.floor(scrollY / textInfo.lineHeight) - (scrollY > 0 ? 1 : 0));
  const lastLine = Math.min(
    textInfo.layout.lines.length,
    Math.ceil((scrollY + textInfo.availableH) / textInfo.lineHeight) + (scrollY > 0 ? 1 : 0)
  );
  ctx.save();
  ctx.beginPath();
  ctx.rect(node.x + TEXT_PADDING, node.y + textInfo.clipTopOffset, textInfo.availableW, textInfo.clipH);
  ctx.clip();
  const textStartY = node.y + textInfo.topOffset + textInfo.contentOffsetY + textInfo.lineHeight / 2;
  for (let i = firstLine; i < lastLine; i += 1) {
    ctx.fillText(
      textInfo.layout.lines[i],
      node.x + TEXT_PADDING,
      textStartY + i * textInfo.lineHeight - scrollY
    );
  }
  ctx.restore();
  if (textInfo.maxScroll > 0 && state.selectedNodes.has(node.id)) {
    drawTextScrollbar(node, textInfo.topOffset, textInfo.availableH, scrollY, textInfo.maxScroll);
  } else if (textInfo.maxScroll > 0 && scale > 0.35) {
    ctx.fillStyle = "rgba(38, 35, 31, 0.42)";
    ctx.fillText("...", node.x + node.w - 32, node.y + node.h - 28);
  }
  ctx.restore();
}

function wrappedText(node, width, height, fontSize) {
  const key = `${node.id}:${node.text}:${Math.round(width)}:${Math.round(height)}:${fontSize}`;
  const cached = state.textCache.get(key);
  if (cached) return cached;
  if (state.textCache.size > 1200) state.textCache.clear();

  const lineHeight = Math.round(fontSize * 1.45);
  const source = node.text || (node.kind === "link" ? node.url || "" : "新笔记");
  const paragraphs = source.split(/\r?\n/);
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.includes(" ") ? paragraph.split(/(\s+)/) : Array.from(paragraph);
    let line = "";
    for (const word of words) {
      const next = line + word;
      if (!line || ctx.measureText(next).width <= width) {
        line = next;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }

  const layout = { key, lines, clipped: false };
  state.textCache.set(key, layout);
  return layout;
}

function textNodeScrollInfo(node) {
  const fontSize = node.kind === "link" ? 14 : 15;
  const topOffset = node.kind === "link" ? 34 : TEXT_PADDING;
  const availableW = Math.max(20, node.w - TEXT_PADDING * 2);
  const lineHeight = Math.round(fontSize * 1.45);
  const availableH = Math.max(lineHeight, node.h - topOffset - TEXT_PADDING);
  ctx.font = `${node.kind === "link" ? "500" : "450"} ${fontSize}px Inter, "Microsoft YaHei UI", sans-serif`;
  const layout = wrappedText(node, availableW, availableH, fontSize);
  const contentH = layout.lines.length * lineHeight;
  const maxScroll = Math.max(0, contentH - availableH);
  const clipTopOffset = Math.max(1, topOffset - TEXT_CLIP_PAD);
  const clipBottomOffset = Math.min(node.h - 1, topOffset + availableH);
  const bottomPadding = Math.max(0, node.h - topOffset - availableH);
  return {
    layout,
    fontSize,
    topOffset,
    clipTopOffset,
    clipH: Math.max(1, clipBottomOffset - clipTopOffset),
    availableW,
    availableH,
    lineHeight,
    bottomPadding,
    contentOffsetY: 0,
    maxScroll
  };
}

function drawTextScrollbar(node, topOffset, availableH, scrollY, maxScroll) {
  const trackX = node.x + node.w - 7;
  const trackY = node.y + topOffset;
  const trackH = availableH;
  const thumbH = Math.max(18 / state.board.view.scale, (trackH * trackH) / (trackH + maxScroll));
  const thumbY = trackY + (trackH - thumbH) * (scrollY / maxScroll);
  ctx.fillStyle = "rgba(38, 35, 31, 0.12)";
  ctx.beginPath();
  roundRect(trackX, trackY, 3, trackH, 2);
  ctx.fill();
  ctx.fillStyle = "rgba(15, 120, 135, 0.62)";
  ctx.beginPath();
  roundRect(trackX - 1, thumbY, 5, thumbH, 3);
  ctx.fill();
}

function ellipsize(text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}...`).width > width) {
    value = value.slice(0, -1);
  }
  return `${value}...`;
}

function drawImageNode(node) {
  const image = loadImage(node);
  const inner = { x: node.x + 1, y: node.y + 1, w: node.w - 2, h: node.h - 2 };
  ctx.save();
  ctx.beginPath();
  roundRect(inner.x, inner.y, inner.w, inner.h, NODE_RADIUS - 1);
  ctx.clip();

  if (image?.complete && image.naturalWidth > 0) {
    const crop = normalizedCrop(node.crop);
    const sx = crop.left * image.naturalWidth;
    const sy = crop.top * image.naturalHeight;
    const sw = Math.max(1, (crop.right - crop.left) * image.naturalWidth);
    const sh = Math.max(1, (crop.bottom - crop.top) * image.naturalHeight);
    ctx.drawImage(image, sx, sy, sw, sh, inner.x, inner.y, inner.w, inner.h);
  } else {
    ctx.fillStyle = "#ede7dc";
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
    ctx.fillStyle = colors.muted;
    ctx.font = "600 13px Inter, sans-serif";
    ctx.fillText("图片加载中", inner.x + 16, inner.y + 22);
  }
  ctx.restore();
}

function loadImage(node) {
  const src = node.assetUrl || node.dataUrl;
  if (!src) return undefined;
  const cached = state.imageCache.get(src);
  if (cached) return cached;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => queueRedraw();
  img.src = src;
  state.imageCache.set(src, img);
  if (state.imageCache.size > MAX_IMAGE_CACHE) {
    const first = state.imageCache.keys().next().value;
    if (first) state.imageCache.delete(first);
  }
  return img;
}

function normalizedCrop(crop) {
  const next = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
  return constrainCrop({
    left: clamp(next.left, 0, 0.95),
    top: clamp(next.top, 0, 0.95),
    right: clamp(next.right, 0.05, 1),
    bottom: clamp(next.bottom, 0.05, 1)
  });
}

function constrainCrop(crop) {
  let left = clamp(crop.left, 0, 1 - MIN_CROP_SPAN);
  let right = clamp(crop.right, MIN_CROP_SPAN, 1);
  if (right - left < MIN_CROP_SPAN) {
    if (left + MIN_CROP_SPAN <= 1) right = left + MIN_CROP_SPAN;
    else left = right - MIN_CROP_SPAN;
  }

  let top = clamp(crop.top, 0, 1 - MIN_CROP_SPAN);
  let bottom = clamp(crop.bottom, MIN_CROP_SPAN, 1);
  if (bottom - top < MIN_CROP_SPAN) {
    if (top + MIN_CROP_SPAN <= 1) bottom = top + MIN_CROP_SPAN;
    else top = bottom - MIN_CROP_SPAN;
  }

  return { left, top, right, bottom };
}

function connectionPreviewNodeId() {
  if (state.pointer?.type !== "connect") return undefined;
  return state.pointer.snapHandle?.node.id;
}

function isConnectionEndpoint(nodeId) {
  return state.pointer?.type === "connect" && (state.pointer.fromNode === nodeId || connectionPreviewNodeId() === nodeId);
}

function shouldShowNodeHandles(node, selected = state.selectedNodes.has(node.id)) {
  if (state.tool === "crop") return false;
  if (isConnectionEndpoint(node.id)) return true;
  if (state.board.view.scale < HANDLE_VISIBLE_MIN_SCALE) return false;
  return selected || state.hoverNode === node.id;
}

function canHitNodeHandle(node, world) {
  if (state.tool === "crop") return false;
  if (state.board.view.scale < HANDLE_VISIBLE_MIN_SCALE) return false;
  return state.selectedNodes.has(node.id) || state.hoverNode === node.id || pointInRect(world, node);
}

function drawNodeHandles(node, selected) {
  for (const side of ["top", "right", "bottom", "left"]) {
    const p = sidePoint(node, side);
    const hover = state.hoverHandle?.nodeId === node.id && state.hoverHandle.side === side;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (HANDLE_RADIUS + (hover ? 2 : 1)) / state.board.view.scale, 0, Math.PI * 2);
    ctx.fillStyle = hover ? "#0f7887" : "rgba(255, 255, 255, 0.86)";
    ctx.strokeStyle = selected ? "#0f7887" : "rgba(15, 120, 135, 0.72)";
    ctx.lineWidth = (hover ? 1.8 : 1.3) / state.board.view.scale;
    ctx.fill();
    ctx.stroke();
  }
}

function drawResizeHandles(node) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = colors.selected;
  ctx.lineWidth = 1.5 / state.board.view.scale;
  for (const handle of resizeHandles(node)) {
    const size = 9 / state.board.view.scale;
    ctx.beginPath();
    roundRect(handle.x - size / 2, handle.y - size / 2, size, size, 2 / state.board.view.scale);
    ctx.fill();
    ctx.stroke();
  }
}

function cropHandlePoints(node) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  return [
    { edge: "nw", x: node.x, y: node.y },
    { edge: "n", x: cx, y: node.y },
    { edge: "ne", x: node.x + node.w, y: node.y },
    { edge: "e", x: node.x + node.w, y: cy },
    { edge: "se", x: node.x + node.w, y: node.y + node.h },
    { edge: "s", x: cx, y: node.y + node.h },
    { edge: "sw", x: node.x, y: node.y + node.h },
    { edge: "w", x: node.x, y: cy }
  ];
}

function drawCropOverlay(node) {
  const scale = state.board.view.scale;
  const size = CROP_HANDLE_SIZE / scale;
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#dfb049";
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([10 / scale, 5 / scale]);
  ctx.strokeRect(node.x, node.y, node.w, node.h);
  ctx.setLineDash([]);

  for (const handle of cropHandlePoints(node)) {
    const hover = state.hoverCrop?.nodeId === node.id && state.hoverCrop.edge === handle.edge;
    ctx.beginPath();
    roundRect(handle.x - size / 2, handle.y - size / 2, size, size, 3 / scale);
    ctx.fillStyle = hover ? "#dfb049" : "#fffdf8";
    ctx.strokeStyle = "#ad7c19";
    ctx.lineWidth = 1.5 / scale;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function edgeVisible(edge, view) {
  const from = getNode(edge.fromNode);
  const to = getNode(edge.toNode);
  if (!from || !to) return false;
  return rectsOverlap(from, view) || rectsOverlap(to, view);
}

function drawEdge(edge) {
  const from = getNode(edge.fromNode);
  const to = getNode(edge.toNode);
  if (!from || !to) return;
  const a = sidePoint(from, edge.fromSide);
  const b = sidePoint(to, edge.toSide);
  const selected = state.selectedEdges.has(edge.id);
  const hovered = state.hoverEdge === edge.id;
  const cp = bezierControlPoints(a, edge.fromSide, b, edge.toSide);
  ctx.save();
  ctx.strokeStyle = selected ? colors.selected : hovered ? "#3f8f99" : edge.color || colors.edge;
  ctx.lineWidth = selected ? 2.8 / state.board.view.scale : hovered ? 2.3 / state.board.view.scale : 1.7 / state.board.view.scale;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(cp.c1.x, cp.c1.y, cp.c2.x, cp.c2.y, b.x, b.y);
  ctx.stroke();
  if (edge.arrow !== "none") drawArrow(cp.c2, b, ctx.strokeStyle.toString());
  if (edge.arrow === "both") drawArrow(cp.c1, a, ctx.strokeStyle.toString());
  if (edge.label) {
    const mid = cubic(a, cp.c1, cp.c2, b, 0.5);
    drawEdgeLabel(edge.label, mid);
  }
  ctx.restore();
}

function edgeLabelLines(label, maxWidth) {
  const source = String(label || "").trim();
  const lines = [];
  for (const paragraph of source.split(/\r?\n/)) {
    const words = paragraph.includes(" ") ? paragraph.split(/(\s+)/) : Array.from(paragraph);
    let line = "";
    for (const word of words) {
      const next = line + word;
      if (!line || ctx.measureText(next).width <= maxWidth) {
        line = next;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  if (lines.length > 4) {
    const visible = lines.slice(0, 4);
    visible[3] = `${visible[3].slice(0, Math.max(1, visible[3].length - 1))}...`;
    return visible;
  }
  return lines.filter((line) => line.length > 0);
}

function edgeLabelBox(label, point) {
  ctx.font = '600 12px Inter, "Microsoft YaHei UI", sans-serif';
  const maxTextW = 220;
  const lines = edgeLabelLines(label, maxTextW);
  if (!lines.length) return { lines, x: point.x, y: point.y, w: 0, h: 0 };
  const lineH = 17;
  const textW = Math.min(maxTextW, Math.max(...lines.map((line) => ctx.measureText(line).width))) + 18;
  const textH = lines.length * lineH + 10;
  return {
    lines,
    x: point.x - textW / 2,
    y: point.y - textH / 2,
    w: textW,
    h: textH,
    lineH
  };
}

function drawEdgeLabel(label, point) {
  ctx.save();
  const box = edgeLabelBox(label, point);
  if (!box.lines.length) {
    ctx.restore();
    return;
  }
  ctx.fillStyle = "#fffefb";
  ctx.strokeStyle = "rgba(63, 58, 49, 0.16)";
  ctx.beginPath();
  roundRect(box.x, box.y, box.w, box.h, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors.text;
  ctx.textBaseline = "top";
  box.lines.forEach((line, index) => {
    ctx.fillText(line, box.x + 9, box.y + 6 + index * box.lineH);
  });
  ctx.restore();
}

function edgeLabelAnchor(edge) {
  const from = getNode(edge.fromNode);
  const to = getNode(edge.toNode);
  if (!from || !to) return undefined;
  const a = sidePoint(from, edge.fromSide);
  const b = sidePoint(to, edge.toSide);
  const cp = bezierControlPoints(a, edge.fromSide, b, edge.toSide);
  return cubic(a, cp.c1, cp.c2, b, 0.5);
}

function drawConnectionPreview(pointer) {
  const from = getNode(pointer.fromNode);
  if (!from) return;
  const a = sidePoint(from, pointer.fromSide);
  const b = pointer.snapHandle ? sidePoint(pointer.snapHandle.node, pointer.snapHandle.side) : pointer.to;
  const targetSide = pointer.snapHandle ? pointer.snapHandle.side : oppositeSide(pointer.fromSide);
  const cp = bezierControlPoints(a, pointer.fromSide, b, targetSide);
  ctx.save();
  ctx.strokeStyle = colors.selected;
  ctx.lineWidth = 2 / state.board.view.scale;
  ctx.setLineDash([8 / state.board.view.scale, 6 / state.board.view.scale]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(cp.c1.x, cp.c1.y, cp.c2.x, cp.c2.y, b.x, b.y);
  ctx.stroke();
  if (pointer.snapHandle) {
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, CONNECT_SNAP_RADIUS / state.board.view.scale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 120, 135, 0.1)";
    ctx.strokeStyle = "rgba(15, 120, 135, 0.35)";
    ctx.lineWidth = 1.5 / state.board.view.scale;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(from, to, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 9 / state.board.view.scale;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - 0.45) * size, to.y - Math.sin(angle - 0.45) * size);
  ctx.lineTo(to.x - Math.cos(angle + 0.45) * size, to.y - Math.sin(angle + 0.45) * size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function bezierControlPoints(a, aSide, b, bSide) {
  const distance = Math.max(80, Math.min(280, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const v1 = sideVector(aSide);
  const v2 = sideVector(bSide);
  return {
    c1: { x: a.x + v1.x * distance, y: a.y + v1.y * distance },
    c2: { x: b.x + v2.x * distance, y: b.y + v2.y * distance }
  };
}

function sideVector(side) {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "bottom") return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function cubic(a, b, c, d, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * b.x + 3 * mt * t ** 2 * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * b.y + 3 * mt * t ** 2 * c.y + t ** 3 * d.y
  };
}

function roundRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawMarqueeSelection() {
  if (state.pointer?.type !== "marquee") return;
  const rect = marqueeRect(state.pointer.startWorld, state.pointer.currentWorld);
  ctx.save();
  ctx.strokeStyle = "rgba(15, 120, 135, 0.75)";
  ctx.lineWidth = 1.5 / state.board.view.scale;
  ctx.setLineDash([8 / state.board.view.scale, 6 / state.board.view.scale]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawJumpSelection() {
  const rect = state.lastJumpSelection || (state.bindingJumpArea ? selectedContentBounds() : undefined);
  if (!usefulRect(rect)) return;
  ctx.save();
  ctx.strokeStyle = state.bindingJumpArea ? "rgba(15, 120, 135, 0.82)" : "rgba(173, 124, 25, 0.72)";
  ctx.lineWidth = 1.5 / state.board.view.scale;
  ctx.setLineDash([8 / state.board.view.scale, 6 / state.board.view.scale]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function hitTest(world, includeEdges = true) {
  const cropHit = state.tool === "crop" ? hitCrop(world) : undefined;
  if (cropHit) return cropHit;

  const handleHit = state.tool === "crop" ? undefined : hitHandle(world);
  if (handleHit) return handleHit;

  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (state.selectedNodes.has(node.id) && state.tool !== "crop") {
      const resize = hitResize(world, node);
      if (resize) return { type: "resize", node, corner: resize };
    }
  }
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (pointInRect(world, node)) return { type: "node", node };
  }
  if (includeEdges) {
    const edge = hitEdge(world);
    if (edge) return { type: "edge", edge };
  }
  for (let i = state.board.groups.length - 1; i >= 0; i -= 1) {
    const group = state.board.groups[i];
    if (pointInRect(world, group)) return { type: "group", group };
  }
  return { type: "none" };
}

function hitCrop(world) {
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (!state.selectedNodes.has(node.id) || node.kind !== "image") continue;
    const edge = hitCropEdge(world, node);
    if (edge) return { type: "crop", node, edge };
  }
  return undefined;
}

function hitCropEdge(world, node) {
  const radius = CROP_EDGE_HIT / state.board.view.scale;
  const inX = world.x >= node.x - radius && world.x <= node.x + node.w + radius;
  const inY = world.y >= node.y - radius && world.y <= node.y + node.h + radius;
  if (!inX || !inY) return undefined;

  const nearLeft = Math.abs(world.x - node.x) <= radius;
  const nearRight = Math.abs(world.x - (node.x + node.w)) <= radius;
  const nearTop = Math.abs(world.y - node.y) <= radius;
  const nearBottom = Math.abs(world.y - (node.y + node.h)) <= radius;

  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearRight && nearBottom) return "se";
  if (nearLeft && nearBottom) return "sw";
  if (nearTop && world.x >= node.x && world.x <= node.x + node.w) return "n";
  if (nearRight && world.y >= node.y && world.y <= node.y + node.h) return "e";
  if (nearBottom && world.x >= node.x && world.x <= node.x + node.w) return "s";
  if (nearLeft && world.y >= node.y && world.y <= node.y + node.h) return "w";
  return undefined;
}

function hitHandle(world) {
  const radius = 11 / state.board.view.scale;
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (!canHitNodeHandle(node, world)) continue;
    for (const side of ["top", "right", "bottom", "left"]) {
      const p = sidePoint(node, side);
      if (Math.hypot(world.x - p.x, world.y - p.y) <= radius && !handleIsOccluded(world, p, i)) {
        return { type: "handle", node, side };
      }
    }
  }
  return undefined;
}

function handleIsOccluded(world, handlePoint, nodeIndex) {
  for (let i = state.board.nodes.length - 1; i > nodeIndex; i -= 1) {
    const node = state.board.nodes[i];
    if (pointInRect(world, node) || pointInRect(handlePoint, node)) {
      return true;
    }
  }
  return false;
}

function snapHandle(world, excludeNodeId) {
  const radius = CONNECT_SNAP_RADIUS / state.board.view.scale;
  let best;
  let bestDistance = radius;
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (node.id === excludeNodeId) continue;
    for (const side of ["top", "right", "bottom", "left"]) {
      const point = sidePoint(node, side);
      if (handleIsOccluded(world, point, i)) continue;
      const distance = Math.hypot(world.x - point.x, world.y - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { type: "handle", node, side };
      }
    }
  }
  return best;
}

function hitResize(world, node) {
  const radius = 10 / state.board.view.scale;
  for (const handle of resizeHandles(node)) {
    if (Math.hypot(world.x - handle.x, world.y - handle.y) <= radius) return handle.corner;
  }
  return undefined;
}

function hitEdge(world, tolerancePx = EDGE_HIT_TOLERANCE_PX) {
  const tolerance = tolerancePx / state.board.view.scale;
  let bestEdge;
  let bestDistance = tolerance;
  for (let i = state.board.edges.length - 1; i >= 0; i -= 1) {
    const edge = state.board.edges[i];
    const from = getNode(edge.fromNode);
    const to = getNode(edge.toNode);
    if (!from || !to) continue;
    const a = sidePoint(from, edge.fromSide);
    const b = sidePoint(to, edge.toSide);
    const cp = bezierControlPoints(a, edge.fromSide, b, edge.toSide);

    if (edge.label) {
      const mid = cubic(a, cp.c1, cp.c2, b, 0.5);
      const box = edgeLabelBox(edge.label, mid);
      const pad = 5 / state.board.view.scale;
      if (
        pointInRect(world, {
          x: box.x - pad,
          y: box.y - pad,
          w: box.w + pad * 2,
          h: box.h + pad * 2
        })
      ) {
        return edge;
      }
    }

    if (!pointNearCurveBounds(world, a, cp.c1, cp.c2, b, tolerance)) continue;

    const length = approximateBezierLength(a, cp.c1, cp.c2, b);
    const segments = clamp(Math.ceil((length * state.board.view.scale) / 6), 24, 220);
    let previous = a;
    for (let step = 1; step <= segments; step += 1) {
      const point = cubic(a, cp.c1, cp.c2, b, step / segments);
      const distance = pointToSegmentDistance(world, previous, point);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestEdge = edge;
      }
      previous = point;
    }
  }
  return bestEdge;
}

function pointNearCurveBounds(point, a, c1, c2, b, padding) {
  const minX = Math.min(a.x, c1.x, c2.x, b.x) - padding;
  const maxX = Math.max(a.x, c1.x, c2.x, b.x) + padding;
  const minY = Math.min(a.y, c1.y, c2.y, b.y) - padding;
  const maxY = Math.max(a.y, c1.y, c2.y, b.y) + padding;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

function approximateBezierLength(a, c1, c2, b) {
  return Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y);
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function handlePointerDown(event) {
  hideContextMenu();
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  state.pointerWorld = world;

  if (event.button === 0 && event.detail >= 2) {
    const edge = hitEdge(world, EDGE_LABEL_HIT_TOLERANCE_PX);
    if (edge) {
      event.preventDefault();
      finishEditing(true);
      finishEdgeLabelEditing(true);
      editEdgeLabel(edge);
      return;
    }
  }

  finishEditing(true);
  finishEdgeLabelEditing(true);
  canvas.setPointerCapture(event.pointerId);

  if (event.button === 1 || event.button === 2 || state.spaceDown) {
    state.pointer = { type: "pan", startScreen: screen, startView: { ...state.board.view } };
    return;
  }

  if (state.tool === "text") {
    addNode(makeTextNode(world), true);
    setTool("select");
    return;
  }
  if (state.tool === "link") {
    addNode(makeLinkNode(world), true);
    setTool("select");
    return;
  }

  const hit = hitTest(world);
  if (hit.type === "crop") {
    state.pointer = {
      type: "crop-image",
      nodeId: hit.node.id,
      edge: hit.edge,
      startWorld: world,
      startRect: { x: hit.node.x, y: hit.node.y, w: hit.node.w, h: hit.node.h },
      startCrop: normalizedCrop(hit.node.crop),
      historyRecorded: false
    };
    state.hoverCrop = { nodeId: hit.node.id, edge: hit.edge };
    queueRedraw();
    return;
  }
  if (hit.type === "handle") {
    state.pointer = {
      type: "connect",
      fromNode: hit.node.id,
      fromSide: hit.side,
      startScreen: screen,
      startWorld: world,
      to: world,
      snapHandle: undefined,
      dragged: false
    };
    state.hoverHandle = { nodeId: hit.node.id, side: hit.side };
    queueRedraw();
    return;
  }
  if (hit.type === "resize") {
    state.pointer = {
      type: "resize-node",
      nodeId: hit.node.id,
      corner: hit.corner,
      startWorld: world,
      startRect: { x: hit.node.x, y: hit.node.y, w: hit.node.w, h: hit.node.h },
      aspect: hit.node.kind === "image" ? hit.node.w / hit.node.h : undefined,
      historyRecorded: false
    };
    return;
  }
  if (hit.type === "node") {
    if (state.tool === "crop" && hit.node.kind === "image" && !state.selectedNodes.has(hit.node.id)) {
      selectOnlyNode(hit.node.id);
      return;
    }
    if (state.tool === "crop" && hit.node.kind !== "image") setTool("select");
    if (event.shiftKey) {
      if (state.selectedNodes.has(hit.node.id)) state.selectedNodes.delete(hit.node.id);
      else state.selectedNodes.add(hit.node.id);
    } else if (!state.selectedNodes.has(hit.node.id)) {
      state.selectedNodes = new Set([hit.node.id]);
      state.selectedEdges.clear();
      state.selectedGroups.clear();
      state.hoverEdge = undefined;
    }
    bringNodesToFront([...state.selectedNodes]);
    const selectedNodes = state.board.nodes.filter((node) => state.selectedNodes.has(node.id));
    state.pointer = {
      type: "drag-node",
      startWorld: world,
      historyRecorded: false,
      nodeStarts: new Map(selectedNodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      groupStarts: new Map(
        state.board.groups
          .filter((group) => state.selectedGroups.has(group.id))
          .map((group) => [group.id, { x: group.x, y: group.y }])
      )
    };
    updateInspector();
    queueRedraw();
    return;
  }
  if (hit.type === "edge") {
    selectOnlyEdge(hit.edge.id);
    return;
  }
  if (hit.type === "group") {
    state.selectedGroups = new Set([hit.group.id]);
    state.selectedNodes.clear();
    state.selectedEdges.clear();
    state.hoverEdge = undefined;
    const nodeIds = new Set(groupedNodeIds(hit.group));
    state.pointer = {
      type: "drag-group",
      groupId: hit.group.id,
      startWorld: world,
      historyRecorded: false,
      groupStart: { x: hit.group.x, y: hit.group.y },
      nodeStarts: new Map(
        state.board.nodes.filter((node) => nodeIds.has(node.id)).map((node) => [node.id, { x: node.x, y: node.y }])
      )
    };
    updateInspector();
    queueRedraw();
    return;
  }

  clearSelection();
  exitJumpModes();
  updateJumpPanel();
  state.pointer = { type: "marquee", startWorld: world, currentWorld: world };
  queueRedraw();
}

function handlePointerMove(event) {
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  state.pointerWorld = world;
  if (!state.pointer) {
    const hit = hitTest(world, true);
    state.hoverNode =
      hit.type === "node" || hit.type === "handle" || hit.type === "resize" || hit.type === "crop"
        ? hit.node.id
        : undefined;
    state.hoverHandle = hit.type === "handle" ? { nodeId: hit.node.id, side: hit.side } : undefined;
    state.hoverCrop = hit.type === "crop" ? { nodeId: hit.node.id, edge: hit.edge } : undefined;
    state.hoverEdge = hit.type === "edge" ? hit.edge.id : undefined;
    updateCursor(hit);
    queueRedraw();
    return;
  }

  if (state.pointer.type === "pan") {
    state.board.view.x = state.pointer.startView.x + (screen.x - state.pointer.startScreen.x);
    state.board.view.y = state.pointer.startView.y + (screen.y - state.pointer.startScreen.y);
    queueRedraw();
    scheduleSave();
    return;
  }
  if (state.pointer.type === "connect") {
    const moved = Math.hypot(screen.x - state.pointer.startScreen.x, screen.y - state.pointer.startScreen.y);
    state.pointer.dragged = state.pointer.dragged || moved >= CONNECT_DRAG_START_PX;
    if (!state.pointer.dragged) {
      state.pointer.to = state.pointer.startWorld;
      state.pointer.snapHandle = undefined;
      state.hoverHandle = { nodeId: state.pointer.fromNode, side: state.pointer.fromSide };
      queueRedraw();
      return;
    }
    const snap = snapHandle(world, state.pointer.fromNode);
    state.pointer.snapHandle = snap;
    state.pointer.to = snap ? sidePoint(snap.node, snap.side) : world;
    state.hoverHandle = snap ? { nodeId: snap.node.id, side: snap.side } : undefined;
    queueRedraw();
    return;
  }
  if (state.pointer.type === "drag-node") {
    const dx = world.x - state.pointer.startWorld.x;
    const dy = world.y - state.pointer.startWorld.y;
    if (!state.pointer.historyRecorded && Math.hypot(dx, dy) > 0.5 / state.board.view.scale) {
      recordHistory();
      state.pointer.historyRecorded = true;
    }
    for (const [id, start] of state.pointer.nodeStarts) {
      const node = getNode(id);
      if (!node) continue;
      node.x = snap(start.x + dx);
      node.y = snap(start.y + dy);
    }
    for (const [id, start] of state.pointer.groupStarts) {
      const group = getGroup(id);
      if (!group) continue;
      group.x = snap(start.x + dx);
      group.y = snap(start.y + dy);
    }
    queueRedraw();
    return;
  }
  if (state.pointer.type === "drag-group") {
    const dx = world.x - state.pointer.startWorld.x;
    const dy = world.y - state.pointer.startWorld.y;
    if (!state.pointer.historyRecorded && Math.hypot(dx, dy) > 0.5 / state.board.view.scale) {
      recordHistory();
      state.pointer.historyRecorded = true;
    }
    const group = getGroup(state.pointer.groupId);
    if (group) {
      group.x = snap(state.pointer.groupStart.x + dx);
      group.y = snap(state.pointer.groupStart.y + dy);
    }
    for (const [id, start] of state.pointer.nodeStarts) {
      const node = getNode(id);
      if (!node) continue;
      node.x = snap(start.x + dx);
      node.y = snap(start.y + dy);
    }
    queueRedraw();
    return;
  }
  if (state.pointer.type === "resize-node") {
    const node = getNode(state.pointer.nodeId);
    if (!node) return;
    if (
      !state.pointer.historyRecorded &&
      Math.hypot(world.x - state.pointer.startWorld.x, world.y - state.pointer.startWorld.y) > 0.5 / state.board.view.scale
    ) {
      recordHistory();
      state.pointer.historyRecorded = true;
    }
    resizeNode(node, state.pointer, world);
    updateInspector();
    queueRedraw();
    return;
  }
  if (state.pointer.type === "crop-image") {
    const node = getNode(state.pointer.nodeId);
    if (!node) return;
    if (
      !state.pointer.historyRecorded &&
      Math.hypot(world.x - state.pointer.startWorld.x, world.y - state.pointer.startWorld.y) > 0.5 / state.board.view.scale
    ) {
      recordHistory();
      state.pointer.historyRecorded = true;
    }
    cropImageNode(node, state.pointer, world);
    state.hoverCrop = { nodeId: node.id, edge: state.pointer.edge };
    updateInspector();
    queueRedraw();
    return;
  }
  if (state.pointer.type === "marquee") {
    state.pointer.currentWorld = world;
    const rect = marqueeRect(state.pointer.startWorld, world);
    state.selectedNodes = new Set(
      state.board.nodes.filter((node) => rectsOverlap(node, rect)).map((node) => node.id)
    );
    state.selectedGroups = new Set(
      state.board.groups.filter((group) => rectsOverlap(group, rect)).map((group) => group.id)
    );
    state.selectedEdges.clear();
    updateInspector();
    queueRedraw();
  }
}

function handlePointerUp(event) {
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  const pointer = state.pointer;
  state.pointer = undefined;
  if (!pointer) return;

  if (pointer.type === "connect") {
    if (!pointer.dragged) {
      state.hoverHandle = undefined;
      queueRedraw();
      return;
    }
    const hit = pointer.snapHandle || snapHandle(world, pointer.fromNode);
    if (hit && hit.node.id !== pointer.fromNode) {
      addEdge(makeEdge(pointer.fromNode, pointer.fromSide, hit.node.id, hit.side));
    } else {
      recordHistory();
      const newNode = makeTextNode(world);
      addNode(newNode, false, { record: false });
      addEdge(makeEdge(pointer.fromNode, pointer.fromSide, newNode.id, oppositeSide(pointer.fromSide)), { record: false });
      requestAnimationFrame(() => editNode(newNode.id));
    }
  }
  if (pointer.type === "marquee") {
    setLastJumpSelection(marqueeRect(pointer.startWorld, pointer.currentWorld));
  }
  if (["drag-node", "drag-group", "resize-node", "crop-image", "marquee", "pan"].includes(pointer.type)) {
    scheduleSave();
  }
  state.hoverHandle = undefined;
  updateInspector();
  queueRedraw();
}

function edgeForLabelEdit(world) {
  const directEdge = hitEdge(world, EDGE_LABEL_HIT_TOLERANCE_PX);
  if (directEdge) return directEdge;
  const hit = hitTest(world);
  if (hit.type === "edge") return hit.edge;
  return undefined;
}

function handleCanvasClick(event) {
  if (event.detail !== 2) return;
  const edge = edgeForLabelEdit(screenToWorld(screenPoint(event)));
  if (!edge) return;
  event.preventDefault();
  editEdgeLabel(edge);
}

function handleDoubleClick(event) {
  const world = screenToWorld(screenPoint(event));
  const edge = edgeForLabelEdit(world);
  if (edge) {
    editEdgeLabel(edge);
    return;
  }
  const hit = hitTest(world);
  if (hit.type === "node") {
    if (hit.node.kind === "link" && event.ctrlKey && hit.node.url) {
      window.open(hit.node.url);
      return;
    }
    editNode(hit.node.id);
    return;
  }
  if (hit.type === "group") {
    const title = window.prompt("分组标题", hit.group.title || "分组");
    if (title !== null) {
      if (title !== hit.group.title) recordHistory();
      hit.group.title = title;
      scheduleSave();
      queueRedraw();
    }
    return;
  }
  addNode(makeTextNode(world), true);
}

function topSelectedTextNodeAt(world) {
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (!pointInRect(world, node)) continue;
    return state.selectedNodes.has(node.id) && node.kind !== "image" ? node : undefined;
  }
  return undefined;
}

function wheelDeltaPixels(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  return event.deltaY * unit;
}

function scrollSelectedTextNode(world, event) {
  const node = topSelectedTextNodeAt(world);
  if (!node || !event.deltaY) return false;
  const info = textNodeScrollInfo(node);
  if (info.maxScroll <= 0) return false;
  const current = clamp(Number(node.scrollY) || 0, 0, info.maxScroll);
  node.scrollY = clamp(current + wheelDeltaPixels(event) / state.board.view.scale, 0, info.maxScroll);
  scheduleSave();
  queueRedraw();
  return true;
}

function handleWheel(event) {
  event.preventDefault();
  finishEditing(true);
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  if (!event.ctrlKey && !state.spaceDown && !event.shiftKey && scrollSelectedTextNode(world, event)) {
    return;
  }
  if (event.ctrlKey || state.spaceDown) {
    const before = screenToWorld(screen);
    const factor = Math.exp(-event.deltaY * 0.0012);
    state.board.view.scale = clamp(state.board.view.scale * factor, 0.12, 3.5);
    state.board.view.x = screen.x - before.x * state.board.view.scale;
    state.board.view.y = screen.y - before.y * state.board.view.scale;
    updateZoomReadout();
  } else if (event.shiftKey) {
    state.board.view.x -= event.deltaY;
  } else {
    state.board.view.x -= event.deltaX;
    state.board.view.y -= event.deltaY;
  }
  scheduleSave();
  queueRedraw();
}

function updateCursor(hit) {
  if (state.spaceDown) {
    canvas.style.cursor = "grab";
  } else if (hit.type === "crop") {
    canvas.style.cursor = cropCursor(hit.edge);
  } else if (hit.type === "handle") {
    canvas.style.cursor = "crosshair";
  } else if (hit.type === "resize") {
    canvas.style.cursor = hit.corner === "nw" || hit.corner === "se" ? "nwse-resize" : "nesw-resize";
  } else if (hit.type === "node" || hit.type === "group") {
    canvas.style.cursor = "move";
  } else if (hit.type === "edge") {
    canvas.style.cursor = "pointer";
  } else {
    canvas.style.cursor = "default";
  }
}

function cropCursor(edge) {
  if (edge === "nw" || edge === "se") return "nwse-resize";
  if (edge === "ne" || edge === "sw") return "nesw-resize";
  if (edge === "n" || edge === "s") return "ns-resize";
  return "ew-resize";
}

function resizeNode(node, pointer, world) {
  const dx = world.x - pointer.startWorld.x;
  const dy = world.y - pointer.startWorld.y;
  let { w, h } = pointer.startRect;
  if (pointer.corner.includes("e")) w = pointer.startRect.w + dx;
  if (pointer.corner.includes("s")) h = pointer.startRect.h + dy;
  if (pointer.corner.includes("w")) {
    w = pointer.startRect.w - dx;
  }
  if (pointer.corner.includes("n")) {
    h = pointer.startRect.h - dy;
  }

  if (pointer.aspect) {
    if (Math.abs(dx) > Math.abs(dy)) h = w / pointer.aspect;
    else w = h * pointer.aspect;
  }

  let finalW = Math.max(MIN_NODE_W, w);
  let finalH = Math.max(MIN_NODE_H, h);
  if (pointer.aspect) {
    if (finalW / pointer.aspect < finalH) finalW = finalH * pointer.aspect;
    else finalH = finalW / pointer.aspect;
    finalW = snap(finalW);
    finalH = finalW / pointer.aspect;
  } else {
    finalW = snap(finalW);
    finalH = snap(finalH);
  }

  const originalRight = pointer.startRect.x + pointer.startRect.w;
  const originalBottom = pointer.startRect.y + pointer.startRect.h;
  node.w = finalW;
  node.h = finalH;
  node.x = pointer.corner.includes("w") ? originalRight - finalW : pointer.startRect.x;
  node.y = pointer.corner.includes("n") ? originalBottom - finalH : pointer.startRect.y;
  state.textCache.clear();
}

function cropImageNode(node, pointer, world) {
  const rect = pointer.startRect;
  const startW = Math.max(1, rect.w);
  const startH = Math.max(1, rect.h);
  const crop = normalizedCrop(pointer.startCrop);
  const cropW = Math.max(MIN_CROP_SPAN, crop.right - crop.left);
  const cropH = Math.max(MIN_CROP_SPAN, crop.bottom - crop.top);
  const dx = world.x - pointer.startWorld.x;
  const dy = world.y - pointer.startWorld.y;

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  const nextCrop = { ...crop };

  if (pointer.edge.includes("w")) {
    const minDelta = ((0 - crop.left) / cropW) * startW;
    const maxBySize = startW - MIN_NODE_W;
    const maxByCrop = ((crop.right - MIN_CROP_SPAN - crop.left) / cropW) * startW;
    const applied = clamp(dx, minDelta, Math.min(maxBySize, maxByCrop));
    x = rect.x + applied;
    w = rect.w - applied;
    nextCrop.left = crop.left + (applied / startW) * cropW;
  }
  if (pointer.edge.includes("e")) {
    const minBySize = MIN_NODE_W - startW;
    const minByCrop = ((crop.left + MIN_CROP_SPAN - crop.right) / cropW) * startW;
    const maxDelta = ((1 - crop.right) / cropW) * startW;
    const applied = clamp(dx, Math.max(minBySize, minByCrop), maxDelta);
    w = rect.w + applied;
    nextCrop.right = crop.right + (applied / startW) * cropW;
  }
  if (pointer.edge.includes("n")) {
    const minDelta = ((0 - crop.top) / cropH) * startH;
    const maxBySize = startH - MIN_NODE_H;
    const maxByCrop = ((crop.bottom - MIN_CROP_SPAN - crop.top) / cropH) * startH;
    const applied = clamp(dy, minDelta, Math.min(maxBySize, maxByCrop));
    y = rect.y + applied;
    h = rect.h - applied;
    nextCrop.top = crop.top + (applied / startH) * cropH;
  }
  if (pointer.edge.includes("s")) {
    const minBySize = MIN_NODE_H - startH;
    const minByCrop = ((crop.top + MIN_CROP_SPAN - crop.bottom) / cropH) * startH;
    const maxDelta = ((1 - crop.bottom) / cropH) * startH;
    const applied = clamp(dy, Math.max(minBySize, minByCrop), maxDelta);
    h = rect.h + applied;
    nextCrop.bottom = crop.bottom + (applied / startH) * cropH;
  }

  node.x = x;
  node.y = y;
  node.w = Math.max(MIN_NODE_W, w);
  node.h = Math.max(MIN_NODE_H, h);
  node.crop = constrainCrop(nextCrop);
}

function marqueeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}

function selectedContentBounds() {
  const rects = [];
  for (const node of state.board.nodes) {
    if (state.selectedNodes.has(node.id)) rects.push(node);
  }
  for (const group of state.board.groups) {
    if (state.selectedGroups.has(group.id)) rects.push(group);
  }
  if (!rects.length) return undefined;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function currentBindableArea() {
  return state.lastJumpSelection || selectedContentBounds();
}

function setLastJumpSelection(rect) {
  const normalized = normalizeRect(rect);
  state.lastJumpSelection = usefulRect(normalized) ? normalized : undefined;
  updateJumpPanel();
}

function setJumpBindingMode(enabled) {
  if (enabled && !usefulRect(currentBindableArea())) {
    showToast("先用鼠标框选一个区域");
    return;
  }
  state.bindingJumpArea = enabled;
  if (enabled) state.clearingJumpArea = false;
  updateJumpPanel();
  queueRedraw();
}

function setJumpClearingMode(enabled) {
  state.clearingJumpArea = enabled;
  if (enabled) state.bindingJumpArea = false;
  updateJumpPanel();
  queueRedraw();
}

function bindJumpArea(slot) {
  const area = currentBindableArea();
  if (!usefulRect(area)) {
    showToast("先用鼠标框选一个区域");
    updateJumpPanel();
    return;
  }
  recordHistory();
  state.board.jumpAreas[slot] = { ...area };
  state.lastJumpSelection = { ...area };
  exitJumpModes();
  updateJumpPanel();
  scheduleSave();
  queueRedraw();
  showToast("已绑定跳转区域");
}

function clearJumpArea(slot) {
  if (!usefulRect(state.board.jumpAreas?.[slot])) {
    showToast("这个区域还没有绑定");
    updateJumpPanel();
    return;
  }
  recordHistory();
  delete state.board.jumpAreas[slot];
  exitJumpModes();
  updateJumpPanel();
  scheduleSave();
  queueRedraw();
  showToast("已取消绑定");
}

function exitJumpModes() {
  state.bindingJumpArea = false;
  state.clearingJumpArea = false;
}

function jumpToArea(slot) {
  exitJumpModes();
  const area = state.board.jumpAreas?.[slot];
  if (!usefulRect(area)) {
    showToast("这个区域还没有绑定");
    updateJumpPanel();
    return;
  }
  focusWorldRect(area);
  state.lastJumpSelection = { ...area };
  updateJumpPanel();
  scheduleSave();
  queueRedraw();
}

function focusWorldRect(rect) {
  const width = Math.max(80, rect.w);
  const height = Math.max(80, rect.h);
  const scale = clamp(
    Math.min((canvas.clientWidth - 220) / width, (canvas.clientHeight - 160) / height),
    0.12,
    2.2
  );
  state.board.view.scale = scale;
  state.board.view.x = canvas.clientWidth / 2 - (rect.x + rect.w / 2) * scale;
  state.board.view.y = canvas.clientHeight / 2 - (rect.y + rect.h / 2) * scale;
  updateZoomReadout();
}

function updateJumpPanel() {
  const bindButton = document.querySelector("[data-jump-action='bind']");
  const clearButton = document.querySelector("[data-jump-action='clear']");
  const canBindArea = state.bindingJumpArea && usefulRect(currentBindableArea());
  const clearingMode = state.clearingJumpArea;
  bindButton?.classList.toggle("active", state.bindingJumpArea);
  clearButton?.classList.toggle("active", clearingMode);
  document.querySelectorAll("[data-jump-slot]").forEach((button) => {
    const slot = button.dataset.jumpSlot;
    const isBound = usefulRect(state.board.jumpAreas?.[slot]);
    button.classList.toggle("bound", isBound && !canBindArea && !clearingMode);
    button.classList.toggle("binding-target", canBindArea);
    button.classList.toggle("clearing-target", clearingMode && isBound);
  });
}

function editNode(nodeId) {
  const node = getNode(nodeId);
  if (!node || node.kind === "image") return;
  finishEdgeLabelEditing(true);
  state.editingNode = nodeId;
  state.editSession = {
    snapshot: boardSnapshot(),
    text: node.text || "",
    url: node.url || ""
  };
  selectOnlyNode(nodeId);
  editor.value = node.text || "";
  editor.style.display = "block";
  editor.focus();
  editor.select();
  repositionEditor();
}

function finishEditing(save) {
  if (!state.editingNode) return;
  const node = getNode(state.editingNode);
  if (node && save) {
    const before = state.editSession;
    const nextText = editor.value;
    const nextUrl = node.kind === "link" ? editor.value.trim() : node.url || "";
    node.text = editor.value;
    if (node.kind === "link") node.url = editor.value.trim();
    state.textCache.clear();
    syncNodeScrollFromEditor();
    if (before && (before.text !== nextText || before.url !== nextUrl)) {
      recordHistory(before.snapshot);
    }
    scheduleSave();
  } else if (node && !save && state.editSession?.snapshot) {
    restoreBoardSnapshot(state.editSession.snapshot);
    return;
  }
  state.editingNode = undefined;
  state.editSession = undefined;
  editor.style.display = "none";
  queueRedraw();
}

function repositionEditor() {
  if (!state.editingNode || editor.style.display === "none") return;
  const node = getNode(state.editingNode);
  if (!node) return;
  const textInfo = textNodeScrollInfo(node);
  const p = worldToScreen({ x: node.x, y: node.y });
  const scale = state.board.view.scale;
  editor.style.left = `${p.x}px`;
  editor.style.top = `${p.y}px`;
  editor.style.width = `${Math.max(40, node.w * scale)}px`;
  editor.style.height = `${Math.max(36, node.h * scale)}px`;
  editor.style.padding = `${(textInfo.topOffset + textInfo.contentOffsetY) * scale}px ${TEXT_PADDING * scale}px ${textInfo.bottomPadding * scale}px`;
  editor.style.borderRadius = `${NODE_RADIUS * scale}px`;
  editor.style.fontSize = `${(node.kind === "link" ? 14 : 15) * scale}px`;
  editor.style.lineHeight = `${textInfo.lineHeight * scale}px`;
  editor.style.fontWeight = node.kind === "link" ? "500" : "450";
  editor.style.color = node.textColor || colors.text;
  const scrollTop = clamp(Number(node.scrollY) || 0, 0, textInfo.maxScroll) * scale;
  if (Math.abs(editor.scrollTop - scrollTop) > 1) editor.scrollTop = scrollTop;
}

function syncNodeScrollFromEditor() {
  const node = getNode(state.editingNode || "");
  if (!node) return;
  const info = textNodeScrollInfo(node);
  node.scrollY = clamp(editor.scrollTop / state.board.view.scale, 0, info.maxScroll);
}

function editEdgeLabel(edgeOrId) {
  const edge = typeof edgeOrId === "string" ? getEdge(edgeOrId) : edgeOrId;
  if (!edge) return;
  finishEditing(true);
  state.editingEdge = edge.id;
  state.edgeEditSession = {
    snapshot: boardSnapshot(),
    label: edge.label || ""
  };
  selectOnlyEdge(edge.id);
  edgeEditor.value = edge.label || "";
  edgeEditor.style.display = "block";
  repositionEdgeLabelEditor();
  edgeEditor.focus();
  edgeEditor.select();
}

function finishEdgeLabelEditing(save) {
  if (!state.editingEdge) return;
  const edge = getEdge(state.editingEdge);
  if (edge && save) {
    const before = state.edgeEditSession;
    const nextLabel = edgeEditor.value.trim();
    edge.label = nextLabel;
    if (before && before.label !== nextLabel) {
      recordHistory(before.snapshot);
    }
    scheduleSave();
  } else if (edge && !save && state.edgeEditSession?.snapshot) {
    restoreBoardSnapshot(state.edgeEditSession.snapshot);
    return;
  }
  state.editingEdge = undefined;
  state.edgeEditSession = undefined;
  edgeEditor.style.display = "none";
  queueRedraw();
}

function repositionEdgeLabelEditor() {
  if (!state.editingEdge || edgeEditor.style.display === "none") return;
  const edge = getEdge(state.editingEdge);
  if (!edge) return;
  const anchor = edgeLabelAnchor(edge);
  if (!anchor) return;
  const p = worldToScreen(anchor);
  const width = clamp(220 * state.board.view.scale, 160, 340);
  const height = clamp(58 * state.board.view.scale, 44, 120);
  edgeEditor.style.left = `${p.x - width / 2}px`;
  edgeEditor.style.top = `${p.y - height / 2}px`;
  edgeEditor.style.width = `${width}px`;
  edgeEditor.style.height = `${height}px`;
  edgeEditor.style.fontSize = `${clamp(12 * state.board.view.scale, 12, 15)}px`;
}

function zoomAtCenter(factor) {
  const screen = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  const before = screenToWorld(screen);
  state.board.view.scale = clamp(state.board.view.scale * factor, 0.12, 3.5);
  state.board.view.x = screen.x - before.x * state.board.view.scale;
  state.board.view.y = screen.y - before.y * state.board.view.scale;
  updateZoomReadout();
  scheduleSave();
  queueRedraw();
}

function fitContent() {
  const nodes = state.board.nodes;
  if (!nodes.length) {
    state.board.view = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, scale: 1 };
    updateZoomReadout();
    queueRedraw();
    return;
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.w));
  const maxY = Math.max(...nodes.map((node) => node.y + node.h));
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const scale = clamp(Math.min((canvas.clientWidth - 220) / contentW, (canvas.clientHeight - 160) / contentH), 0.18, 1.8);
  state.board.view.scale = scale;
  state.board.view.x = canvas.clientWidth / 2 - (minX + contentW / 2) * scale;
  state.board.view.y = canvas.clientHeight / 2 - (minY + contentH / 2) * scale;
  updateZoomReadout();
  scheduleSave();
  queueRedraw();
}

async function addImagesAt(images, point = state.pointerWorld) {
  if (!images.length) return;
  recordHistory();
  let offset = 0;
  for (const image of images) {
    addNode(makeImageNode({ x: point.x + offset, y: point.y + offset }, image), false, { record: false });
    offset += 34;
  }
}

async function pickImages() {
  const images = await window.mindboard.pickImages();
  if (images.length) {
    await addImagesAt(images);
    showToast(`已添加 ${images.length} 张图片`);
  }
}

function makeClipboardTextNode(point, text) {
  const cleaned = text.replace(/\r\n/g, "\n").trimEnd();
  const visualLines = cleaned
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 34)), 0);
  const isShort = cleaned.length <= 42 && !cleaned.includes("\n");
  const w = isShort ? 200 : cleaned.length > 80 || cleaned.includes("\n") ? 360 : 260;
  const h = isShort ? DEFAULT_TEXT_NODE_H : clamp(56 + visualLines * 22, 76, 420);
  return {
    ...makeTextNode(point, cleaned || "新笔记"),
    x: snap(point.x - w / 2),
    y: snap(point.y - h / 2),
    w,
    h
  };
}

async function pasteImage(options = {}) {
  try {
    const image = await window.mindboard.readClipboardImage();
    if (image) {
      await addImagesAt([image]);
      showToast("已从剪贴板粘贴图片");
      return true;
    }
    if (!options.silent) {
      showToast("剪贴板里没有图片");
    }
    return false;
  } catch {
    if (!options.silent) {
      showToast("浏览器需要剪贴板权限，或请直接拖入图片");
    }
    return false;
  }
}

async function pasteText(options = {}) {
  try {
    const text = await window.mindboard.readClipboardText?.();
    if (text && text.trim()) {
      addNode(makeClipboardTextNode(state.pointerWorld, text));
      showToast("已粘贴文本为新节点");
      return true;
    }
    if (!options.silent) {
      showToast("剪贴板里没有文本");
    }
    return false;
  } catch {
    if (!options.silent) {
      showToast("无法读取剪贴板文本");
    }
    return false;
  }
}

async function pasteClipboard() {
  if (await pasteImage({ silent: true })) return;
  if (await pasteText({ silent: true })) return;
  showToast("剪贴板里没有可粘贴的图片或文本");
}

function updateInspector() {
  const empty = document.querySelector(".inspector-empty");
  const nodeContent = document.querySelector(".node-inspector");
  const selected = [...state.selectedNodes].map(getNode).filter(Boolean);
  const hasNode = selected.length > 0;
  empty.classList.toggle("hidden", hasNode);
  nodeContent.classList.toggle("hidden", !hasNode);
  if (!hasNode) return;
  const node = selected[0];
  const width = document.querySelector("[data-inspector='width']");
  const height = document.querySelector("[data-inspector='height']");
  width.value = Math.round(node.w).toString();
  height.value = Math.round(node.h).toString();
  const cropPanel = document.querySelector(".crop-panel");
  cropPanel.classList.toggle("hidden", node.kind !== "image");
}

function changeSelectedSize(axis, value) {
  const nodes = [...state.selectedNodes].map(getNode).filter(Boolean);
  if (!nodes.length) return;
  recordHistory();
  for (const node of nodes) {
    if (node.kind === "image") {
      const aspect = node.w / node.h;
      if (axis === "w") {
        node.w = Math.max(MIN_NODE_W, value);
        node.h = Math.max(MIN_NODE_H, node.w / aspect);
      } else {
        node.h = Math.max(MIN_NODE_H, value);
        node.w = Math.max(MIN_NODE_W, node.h * aspect);
      }
    } else {
      node[axis] = Math.max(axis === "w" ? MIN_NODE_W : MIN_NODE_H, value);
    }
  }
  state.textCache.clear();
  updateInspector();
  scheduleSave();
  queueRedraw();
}

function changeSelectedColor(color) {
  let changed = false;
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node && node.color !== color) changed = true;
  }
  if (!changed) return;
  recordHistory();
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node) node.color = color;
  }
  scheduleSave();
  queueRedraw();
}

function changeSelectedTextColor(color) {
  let changed = false;
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node && node.kind !== "image" && node.textColor !== color) changed = true;
  }
  if (!changed) return;
  recordHistory();
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node && node.kind !== "image") node.textColor = color;
  }
  repositionEditor();
  scheduleSave();
  queueRedraw();
}

function clearEdgeLabel(edge) {
  if (!edge || !edge.label) return;
  recordHistory();
  edge.label = "";
  updateInspector();
  scheduleSave();
  queueRedraw();
}

function resetCrop() {
  const node = getNode([...state.selectedNodes][0]);
  if (!node || node.kind !== "image") return;
  const crop = normalizedCrop(node.crop);
  if (crop.left === 0 && crop.top === 0 && crop.right === 1 && crop.bottom === 1) return;
  recordHistory();
  const fullW = node.w / Math.max(MIN_CROP_SPAN, crop.right - crop.left);
  const fullH = node.h / Math.max(MIN_CROP_SPAN, crop.bottom - crop.top);
  node.x -= fullW * crop.left;
  node.y -= fullH * crop.top;
  node.w = Math.max(MIN_NODE_W, fullW);
  node.h = Math.max(MIN_NODE_H, fullH);
  node.crop = { left: 0, top: 0, right: 1, bottom: 1 };
  scheduleSave();
  updateInspector();
  queueRedraw();
}

function scheduleSave() {
  if (state.saveTimer) window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    window.mindboard.saveBoard(boardForSave()).catch((error) => {
      console.error(error);
      showToast("自动保存失败");
    });
  }, 350);
}

function updateZoomReadout() {
  const readout = document.querySelector(".zoom-readout");
  readout.textContent = `${Math.round(state.board.view.scale * 100)}%`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  window.clearTimeout(Number(toastEl.dataset.timer || 0));
  const timer = window.setTimeout(() => toastEl.classList.add("hidden"), 2200);
  toastEl.dataset.timer = String(timer);
}

function showContextMenu(point, items) {
  contextMenu.innerHTML = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.textContent = item.label;
    button.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
    contextMenu.append(button);
  }
  contextMenu.style.left = `${point.x}px`;
  contextMenu.style.top = `${point.y}px`;
  contextMenu.classList.remove("hidden");
}

function hideContextMenu() {
  contextMenu.classList.add("hidden");
}

function handleContextMenu(event) {
  event.preventDefault();
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  const hit = hitTest(world);
  state.pointerWorld = world;
  const items = [];
  if (hit.type === "node" || hit.type === "crop") {
    const node = hit.node;
    selectOnlyNode(node.id);
    if (node.kind !== "image") items.push({ label: "编辑", action: () => editNode(node.id) });
    if (node.kind === "image") items.push({ label: "重置裁剪", action: resetCrop });
    items.push({ label: "复制", action: duplicateSelection });
    items.push({ label: "删除", action: removeSelection });
  } else if (hit.type === "edge") {
    selectOnlyEdge(hit.edge.id);
    if (hit.edge.label) items.push({ label: "清空说明", action: () => clearEdgeLabel(hit.edge) });
    items.push({ label: "删除", action: removeSelection });
  } else {
    items.push({ label: "新建文本", action: () => addNode(makeTextNode(world), true) });
    items.push({ label: "添加图片", action: () => pickImages() });
    items.push({ label: "新建分组", action: createGroupFromSelection });
    items.push({ label: "粘贴", action: () => pasteClipboard() });
  }
  showContextMenu(screen, items);
}

function installEventHandlers() {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("click", handleCanvasClick);
  canvas.addEventListener("dblclick", handleDoubleClick);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  canvas.addEventListener("contextmenu", handleContextMenu);

  window.addEventListener("resize", queueRedraw);
  window.addEventListener("keydown", (event) => {
    if (event.target === editor) {
      if (event.key === "Escape") finishEditing(false);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") finishEditing(true);
      return;
    }
    if (event.target === edgeEditor) {
      if (event.key === "Escape") finishEdgeLabelEditing(false);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") finishEdgeLabelEditing(true);
      return;
    }
    if (event.code === "Space") {
      state.spaceDown = true;
      canvas.style.cursor = "grab";
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redoBoard();
      else undoBoard();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoBoard();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") removeSelection();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      state.selectedNodes = new Set(state.board.nodes.map((node) => node.id));
      state.selectedEdges.clear();
      state.selectedGroups.clear();
      updateInspector();
      queueRedraw();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
    }
    if (event.key === "Escape") {
      hideContextMenu();
      clearSelection();
      exitJumpModes();
      updateJumpPanel();
      queueRedraw();
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.spaceDown = false;
      canvas.style.cursor = "default";
    }
  });

  editor.addEventListener("blur", () => finishEditing(true));
  editor.addEventListener("wheel", (event) => {
    if (!state.editingNode) return;
    event.stopPropagation();
  });
  editor.addEventListener("scroll", () => {
    if (!state.editingNode) return;
    syncNodeScrollFromEditor();
    scheduleSave();
  });
  editor.addEventListener("input", () => {
    const node = getNode(state.editingNode || "");
    if (node) {
      node.text = editor.value;
      state.textCache.clear();
      syncNodeScrollFromEditor();
      repositionEditor();
      queueRedraw();
    }
  });
  edgeEditor.addEventListener("blur", () => finishEdgeLabelEditing(true));
  edgeEditor.addEventListener("wheel", (event) => {
    if (!state.editingEdge) return;
    event.stopPropagation();
  });
  edgeEditor.addEventListener("input", () => {
    const edge = getEdge(state.editingEdge || "");
    if (!edge) return;
    edge.label = edgeEditor.value;
    queueRedraw();
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action || "";
      if (["select", "text", "image", "link"].includes(action)) {
        if (action === "image") pickImages();
        else setTool(action);
      }
      if (action === "undo") undoBoard();
      if (action === "redo") redoBoard();
      if (action === "delete") removeSelection();
      if (action === "duplicate") duplicateSelection();
      if (action === "group") createGroupFromSelection();
      if (action === "crop") toggleCropMode();
      if (action === "toggle-grid") toggleGridVisibility(!gridVisible());
      if (action === "zoom-in") zoomAtCenter(1.18);
      if (action === "zoom-out") zoomAtCenter(1 / 1.18);
      if (action === "zoom-reset") {
        state.board.view.scale = 1;
        updateZoomReadout();
        queueRedraw();
        scheduleSave();
      }
      if (action === "fit") fitContent();
      if (action === "export") exportBoard();
      if (action === "import") importBoard();
      if (action === "reset-crop") resetCrop();
    });
  });

  document.querySelector("[data-jump-action='bind']")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.currentTarget.blur();
    setJumpBindingMode(!state.bindingJumpArea);
  });
  document.querySelector("[data-jump-action='clear']")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.currentTarget.blur();
    setJumpClearingMode(!state.clearingJumpArea);
  });
  document.querySelectorAll("[data-jump-slot]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.currentTarget.blur();
      const slot = button.dataset.jumpSlot;
      if (!slot) return;
      if (state.bindingJumpArea) bindJumpArea(slot);
      else if (state.clearingJumpArea) clearJumpArea(slot);
      else jumpToArea(slot);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const slot = button.dataset.jumpSlot;
      if (slot) clearJumpArea(slot);
    });
  });

  document.querySelector("[data-inspector='width']").addEventListener("change", (event) => {
    changeSelectedSize("w", Number(event.target.value));
  });
  document.querySelector("[data-inspector='height']").addEventListener("change", (event) => {
    changeSelectedSize("h", Number(event.target.value));
  });
  document.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => changeSelectedColor(button.dataset.color || "#fffdf8"));
  });
  document.querySelectorAll("[data-text-color]").forEach((button) => {
    button.addEventListener("click", () => changeSelectedTextColor(button.dataset.textColor || colors.text));
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    state.pointerWorld = screenToWorld({ x: event.clientX, y: event.clientY });
    const files = [...(event.dataTransfer?.files ?? [])];
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) {
      const images = await filesToImages(imageFiles);
      await addImagesAt(images, state.pointerWorld);
      showToast("已导入拖入的图片");
      return;
    }
    const paths = files.map((file) => window.mindboard.getPathForFile(file)).filter(Boolean);
    if (paths.length) {
      const images = await window.mindboard.importFilePaths(paths);
      await addImagesAt(images, state.pointerWorld);
      showToast("已导入拖入的图片");
    }
  });
}

async function exportBoard() {
  finishEditing(true);
  finishEdgeLabelEditing(true);
  const result = await window.mindboard.exportBoard(boardForSave());
  if (result.ok) showToast("已导出 .mindboard");
}

async function importBoard() {
  finishEditing(true);
  finishEdgeLabelEditing(true);
  const imported = await window.mindboard.importBoard();
  if (!imported) return;
  recordHistory();
  state.board = normalizeBoard(imported);
  clearSelection();
  updateZoomReadout();
  updateGridToggle();
  updateJumpPanel();
  queueRedraw();
  showToast("已导入画板");
}

async function boot() {
  installEventHandlers();
  try {
    state.board = normalizeBoard(await window.mindboard.loadBoard());
  } catch (error) {
    console.error(error);
    showToast("加载本地画板失败，已打开空白画板");
  }
  if (!state.board.nodes.length) {
    state.board.view = { ...state.board.view, x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, scale: 1 };
  }
  updateZoomReadout();
  updateGridToggle();
  updateInspector();
  updateJumpPanel();
  updateHistoryButtons();
  queueRedraw();
}

boot();
