import { createIcons, icons } from "lucide";
import "./styles.css";
import type {
  BoardEdge,
  BoardGroup,
  BoardNode,
  BoardState,
  CropState,
  ImportedImage,
  Side,
  Tool
} from "./types";

const canvas = document.querySelector<HTMLCanvasElement>("#boardCanvas");
const editor = document.querySelector<HTMLTextAreaElement>("#inlineEditor");
const toastEl = document.querySelector<HTMLDivElement>("#toast");
const contextMenu = document.querySelector<HTMLDivElement>("#contextMenu");

if (!canvas || !editor || !toastEl || !contextMenu) {
  throw new Error("MindBoard UI failed to initialize.");
}

const ctx = canvas.getContext("2d", { alpha: false });
if (!ctx) {
  throw new Error("Canvas 2D is unavailable.");
}

createIcons({ icons });

const NODE_RADIUS = 8;
const HANDLE_RADIUS = 5;
const MIN_NODE_W = 120;
const MIN_NODE_H = 72;
const GRID = 32;
const DPR_MAX = 2;
const TEXT_PADDING = 16;
const GROUP_PAD = 24;
const MAX_IMAGE_CACHE = 350;

const colors = {
  bg: "#f5f3ee",
  gridFine: "#e8e3da",
  gridStrong: "#ddd6cb",
  text: "#26231f",
  muted: "#77736b",
  border: "#d6cec0",
  selected: "#0f7887",
  accent: "#0f7887",
  edge: "#7a756b",
  shadow: "rgba(31, 28, 23, 0.12)"
};

const state: {
  board: BoardState;
  tool: Tool;
  selectedNodes: Set<string>;
  selectedEdges: Set<string>;
  selectedGroups: Set<string>;
  hoverNode?: string;
  hoverHandle?: { nodeId: string; side: Side };
  pointer?: PointerInteraction;
  editingNode?: string;
  saveTimer?: number;
  redrawQueued: boolean;
  spaceDown: boolean;
  pointerWorld: Point;
  imageCache: Map<string, HTMLImageElement>;
  textCache: Map<string, WrappedText>;
  imageBitmapCache: Map<string, HTMLCanvasElement>;
} = {
  board: { version: 2, view: { x: 0, y: 0, scale: 1 }, nodes: [], edges: [], groups: [] },
  tool: "select",
  selectedNodes: new Set(),
  selectedEdges: new Set(),
  selectedGroups: new Set(),
  redrawQueued: false,
  spaceDown: false,
  pointerWorld: { x: 0, y: 0 },
  imageCache: new Map(),
  textCache: new Map(),
  imageBitmapCache: new Map()
};

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

type PointerInteraction =
  | {
      type: "pan";
      startScreen: Point;
      startView: Point;
    }
  | {
      type: "drag-node";
      startWorld: Point;
      nodeStarts: Map<string, Point>;
      groupStarts: Map<string, Point>;
    }
  | {
      type: "resize-node";
      nodeId: string;
      corner: ResizeCorner;
      startWorld: Point;
      startRect: Rect;
      aspect?: number;
    }
  | {
      type: "connect";
      fromNode: string;
      fromSide: Side;
      to: Point;
    }
  | {
      type: "marquee";
      startWorld: Point;
      currentWorld: Point;
    }
  | {
      type: "drag-group";
      groupId: string;
      startWorld: Point;
      groupStart: Point;
      nodeStarts: Map<string, Point>;
    };

type ResizeCorner = "nw" | "ne" | "se" | "sw";

type WrappedText = {
  key: string;
  lines: string[];
  clipped: boolean;
};

type Hit =
  | { type: "node"; node: BoardNode }
  | { type: "handle"; node: BoardNode; side: Side }
  | { type: "resize"; node: BoardNode; corner: ResizeCorner }
  | { type: "edge"; edge: BoardEdge }
  | { type: "group"; group: BoardGroup }
  | { type: "none" };

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function snap(value: number) {
  return Math.round(value / 8) * 8;
}

function normalizeBoard(board: BoardState): BoardState {
  return {
    version: board.version || 2,
    view: {
      x: Number.isFinite(board.view?.x) ? board.view.x : 0,
      y: Number.isFinite(board.view?.y) ? board.view.y : 0,
      scale: clamp(Number.isFinite(board.view?.scale) ? board.view.scale : 1, 0.12, 3)
    },
    nodes: Array.isArray(board.nodes)
      ? board.nodes.map((node) => ({
          ...node,
          color: node.color || "#fffdf8",
          text: node.text ?? "",
          w: Math.max(MIN_NODE_W, Number(node.w) || 220),
          h: Math.max(MIN_NODE_H, Number(node.h) || 120)
        }))
      : [],
    edges: Array.isArray(board.edges)
      ? board.edges.map((edge) => ({
          ...edge,
          color: edge.color || colors.edge,
          label: edge.label || "",
          arrow: edge.arrow || "forward"
        }))
      : [],
    groups: Array.isArray(board.groups) ? board.groups : []
  };
}

function boardForSave(): BoardState {
  return {
    ...state.board,
    nodes: state.board.nodes.map(({ assetUrl: _assetUrl, ...node }) => ({ ...node }))
  };
}

function screenToWorld(point: Point): Point {
  return {
    x: (point.x - state.board.view.x) / state.board.view.scale,
    y: (point.y - state.board.view.y) / state.board.view.scale
  };
}

function worldToScreen(point: Point): Point {
  return {
    x: point.x * state.board.view.scale + state.board.view.x,
    y: point.y * state.board.view.scale + state.board.view.y
  };
}

function screenPoint(event: PointerEvent | MouseEvent | WheelEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function nodeCenter(node: BoardNode): Point {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function sidePoint(node: BoardNode, side: Side): Point {
  if (side === "top") return { x: node.x + node.w / 2, y: node.y };
  if (side === "right") return { x: node.x + node.w, y: node.y + node.h / 2 };
  if (side === "bottom") return { x: node.x + node.w / 2, y: node.y + node.h };
  return { x: node.x, y: node.y + node.h / 2 };
}

function oppositeSide(side: Side): Side {
  if (side === "top") return "bottom";
  if (side === "right") return "left";
  if (side === "bottom") return "top";
  return "right";
}

function resizeHandles(node: BoardNode) {
  return [
    { corner: "nw" as const, x: node.x, y: node.y },
    { corner: "ne" as const, x: node.x + node.w, y: node.y },
    { corner: "se" as const, x: node.x + node.w, y: node.y + node.h },
    { corner: "sw" as const, x: node.x, y: node.y + node.h }
  ];
}

function rectsOverlap(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pointInRect(point: Point, rect: Rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function visibleWorld(): Rect {
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

function setTool(tool: Tool) {
  state.tool = tool;
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === tool);
  });
}

function selectOnlyNode(nodeId: string) {
  state.selectedNodes = new Set([nodeId]);
  state.selectedEdges.clear();
  state.selectedGroups.clear();
  bringNodesToFront([nodeId]);
  updateInspector();
  queueRedraw();
}

function clearSelection() {
  state.selectedNodes.clear();
  state.selectedEdges.clear();
  state.selectedGroups.clear();
  updateInspector();
}

function bringNodesToFront(ids: string[]) {
  const wanted = new Set(ids);
  const back = state.board.nodes.filter((node) => !wanted.has(node.id));
  const front = state.board.nodes.filter((node) => wanted.has(node.id));
  state.board.nodes = [...back, ...front];
}

function getNode(id: string) {
  return state.board.nodes.find((node) => node.id === id);
}

function getGroup(id: string) {
  return state.board.groups.find((group) => group.id === id);
}

function groupedNodeIds(group: BoardGroup) {
  return state.board.nodes
    .filter((node) => {
      const center = nodeCenter(node);
      return pointInRect(center, group);
    })
    .map((node) => node.id);
}

function makeTextNode(point: Point, text = "新笔记"): BoardNode {
  return {
    id: uid("node"),
    kind: "text",
    x: snap(point.x - 120),
    y: snap(point.y - 54),
    w: 240,
    h: 108,
    text,
    color: "#fffdf8"
  };
}

function makeLinkNode(point: Point): BoardNode {
  return {
    id: uid("node"),
    kind: "link",
    x: snap(point.x - 140),
    y: snap(point.y - 56),
    w: 280,
    h: 112,
    text: "https://example.com",
    url: "https://example.com",
    color: "#e9f3ff"
  };
}

function makeImageNode(point: Point, image: ImportedImage): BoardNode {
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
    assetUrl: image.assetUrl,
    crop: { left: 0, top: 0, right: 1, bottom: 1 }
  };
}

function makeEdge(fromNode: string, fromSide: Side, toNode: string, toSide: Side): BoardEdge {
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

function addNode(node: BoardNode, edit = false) {
  state.board.nodes.push(node);
  selectOnlyNode(node.id);
  scheduleSave();
  if (edit && node.kind !== "image") {
    requestAnimationFrame(() => editNode(node.id));
  }
}

function addEdge(edge: BoardEdge) {
  const exists = state.board.edges.some(
    (item) =>
      item.fromNode === edge.fromNode &&
      item.toNode === edge.toNode &&
      item.fromSide === edge.fromSide &&
      item.toSide === edge.toSide
  );
  if (!exists && edge.fromNode !== edge.toNode) {
    state.board.edges.push(edge);
    scheduleSave();
  }
}

function removeSelection() {
  if (state.editingNode) finishEditing(true);
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
  const idMap = new Map<string, string>();
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
      fromNode: idMap.get(edge.fromNode)!,
      toNode: idMap.get(edge.toNode)!
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
  drawGrid(width, height);

  ctx.save();
  ctx.translate(state.board.view.x, state.board.view.y);
  ctx.scale(state.board.view.scale, state.board.view.scale);
  drawWorld();
  ctx.restore();

  drawMarqueeScreen();
  repositionEditor();
}

function queueRedraw() {
  if (state.redrawQueued) return;
  state.redrawQueued = true;
  requestAnimationFrame(draw);
}

function drawGrid(width: number, height: number) {
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
  if (state.pointer?.type === "connect") {
    drawConnectionPreview(state.pointer);
  }
  for (const node of state.board.nodes) {
    if (rectsOverlap(node, view)) drawNode(node);
  }
}

function drawGroup(group: BoardGroup) {
  ctx.save();
  ctx.fillStyle = group.color || "rgba(15, 120, 135, 0.08)";
  ctx.strokeStyle = state.selectedGroups.has(group.id) ? colors.selected : "rgba(66, 60, 50, 0.18)";
  ctx.lineWidth = state.selectedGroups.has(group.id) ? 2 : 1;
  roundRect(group.x, group.y, group.w, group.h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#5b564d";
  ctx.font = "600 14px Inter, Segoe UI, sans-serif";
  ctx.fillText(group.title || "分组", group.x + 14, group.y + 24);
  ctx.restore();
}

function drawNode(node: BoardNode) {
  const selected = state.selectedNodes.has(node.id);
  ctx.save();
  ctx.shadowColor = colors.shadow;
  ctx.shadowBlur = selected ? 18 : 10;
  ctx.shadowOffsetY = selected ? 8 : 4;
  ctx.fillStyle = node.color || "#fffdf8";
  ctx.strokeStyle = selected ? colors.selected : colors.border;
  ctx.lineWidth = selected ? 2 : 1;
  roundRect(node.x, node.y, node.w, node.h, NODE_RADIUS);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.stroke();

  if (node.kind === "image") drawImageNode(node);
  else drawTextNode(node);

  if (selected || state.hoverNode === node.id || state.board.view.scale > 0.55) {
    drawNodeHandles(node, selected);
  }
  if (selected) {
    drawResizeHandles(node);
  }
  ctx.restore();
}

function drawTextNode(node: BoardNode) {
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
    return;
  }

  ctx.fillStyle = colors.text;
  ctx.font = `${node.kind === "link" ? "500" : "450"} ${fontSize}px Inter, "Microsoft YaHei UI", sans-serif`;
  ctx.textBaseline = "top";
  const topOffset = title ? 34 : TEXT_PADDING;
  const availableW = Math.max(20, node.w - TEXT_PADDING * 2);
  const availableH = Math.max(20, node.h - topOffset - TEXT_PADDING);
  const layout = wrappedText(node, availableW, availableH, fontSize);
  const lineHeight = Math.round(fontSize * 1.45);
  for (let i = 0; i < layout.lines.length; i += 1) {
    ctx.fillText(layout.lines[i], node.x + TEXT_PADDING, node.y + topOffset + i * lineHeight);
  }
  if (layout.clipped && scale > 0.35) {
    ctx.fillStyle = "rgba(38, 35, 31, 0.42)";
    ctx.fillText("...", node.x + node.w - 32, node.y + node.h - 28);
  }
  ctx.restore();
}

function wrappedText(node: BoardNode, width: number, height: number, fontSize: number): WrappedText {
  const key = `${node.id}:${node.text}:${Math.round(width)}:${Math.round(height)}:${fontSize}`;
  const cached = state.textCache.get(key);
  if (cached) return cached;
  if (state.textCache.size > 1200) state.textCache.clear();

  const lineHeight = Math.round(fontSize * 1.45);
  const maxLines = Math.max(1, Math.floor(height / lineHeight));
  const source = node.text || (node.kind === "link" ? node.url || "" : "新笔记");
  const paragraphs = source.split(/\r?\n/);
  const lines: string[] = [];
  let clipped = false;

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
      if (lines.length >= maxLines) {
        clipped = true;
        break;
      }
    }
    if (clipped) break;
    lines.push(line);
    if (lines.length >= maxLines) {
      clipped = true;
      break;
    }
  }

  const finalLines = lines.slice(0, maxLines);
  if (clipped && finalLines.length) {
    finalLines[finalLines.length - 1] = ellipsize(finalLines[finalLines.length - 1], width);
  }
  const layout = { key, lines: finalLines, clipped };
  state.textCache.set(key, layout);
  return layout;
}

function ellipsize(text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}...`).width > width) {
    value = value.slice(0, -1);
  }
  return `${value}...`;
}

function drawImageNode(node: BoardNode) {
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

function loadImage(node: BoardNode) {
  if (!node.assetUrl) return undefined;
  const cached = state.imageCache.get(node.assetUrl);
  if (cached) return cached;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => queueRedraw();
  img.src = node.assetUrl;
  state.imageCache.set(node.assetUrl, img);
  if (state.imageCache.size > MAX_IMAGE_CACHE) {
    const first = state.imageCache.keys().next().value;
    if (first) state.imageCache.delete(first);
  }
  return img;
}

function normalizedCrop(crop?: CropState): CropState {
  const next = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
  return {
    left: clamp(next.left, 0, 0.95),
    top: clamp(next.top, 0, 0.95),
    right: clamp(next.right, 0.05, 1),
    bottom: clamp(next.bottom, 0.05, 1)
  };
}

function drawNodeHandles(node: BoardNode, selected: boolean) {
  const sides: Side[] = ["top", "right", "bottom", "left"];
  for (const side of sides) {
    const p = sidePoint(node, side);
    const hover = state.hoverHandle?.nodeId === node.id && state.hoverHandle.side === side;
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS / state.board.view.scale + 2, 0, Math.PI * 2);
    ctx.fillStyle = hover || selected ? "#0f7887" : "#ffffff";
    ctx.strokeStyle = "#0f7887";
    ctx.lineWidth = 1.5 / state.board.view.scale;
    ctx.fill();
    ctx.stroke();
  }
}

function drawResizeHandles(node: BoardNode) {
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

function edgeVisible(edge: BoardEdge, view: Rect) {
  const from = getNode(edge.fromNode);
  const to = getNode(edge.toNode);
  if (!from || !to) return false;
  return rectsOverlap(from, view) || rectsOverlap(to, view);
}

function drawEdge(edge: BoardEdge) {
  const from = getNode(edge.fromNode);
  const to = getNode(edge.toNode);
  if (!from || !to) return;
  const a = sidePoint(from, edge.fromSide);
  const b = sidePoint(to, edge.toSide);
  const selected = state.selectedEdges.has(edge.id);
  const cp = bezierControlPoints(a, edge.fromSide, b, edge.toSide);
  ctx.save();
  ctx.strokeStyle = selected ? colors.selected : edge.color || colors.edge;
  ctx.lineWidth = selected ? 2.5 / state.board.view.scale : 1.7 / state.board.view.scale;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(cp.c1.x, cp.c1.y, cp.c2.x, cp.c2.y, b.x, b.y);
  ctx.stroke();
  if (edge.arrow !== "none") drawArrow(cp.c2, b, ctx.strokeStyle.toString());
  if (edge.arrow === "both") drawArrow(cp.c1, a, ctx.strokeStyle.toString());
  if (edge.label) {
    const mid = cubic(a, cp.c1, cp.c2, b, 0.5);
    ctx.font = "600 12px Inter, sans-serif";
    const textW = ctx.measureText(edge.label).width + 16;
    ctx.fillStyle = "#fffefb";
    ctx.strokeStyle = "rgba(63, 58, 49, 0.16)";
    roundRect(mid.x - textW / 2, mid.y - 12, textW, 24, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(edge.label, mid.x - textW / 2 + 8, mid.y + 4);
  }
  ctx.restore();
}

function drawConnectionPreview(pointer: Extract<PointerInteraction, { type: "connect" }>) {
  const from = getNode(pointer.fromNode);
  if (!from) return;
  const a = sidePoint(from, pointer.fromSide);
  const b = pointer.to;
  const cp = bezierControlPoints(a, pointer.fromSide, b, oppositeSide(pointer.fromSide));
  ctx.save();
  ctx.strokeStyle = colors.selected;
  ctx.lineWidth = 2 / state.board.view.scale;
  ctx.setLineDash([8 / state.board.view.scale, 6 / state.board.view.scale]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(cp.c1.x, cp.c1.y, cp.c2.x, cp.c2.y, b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawArrow(from: Point, to: Point, color: string) {
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

function bezierControlPoints(a: Point, aSide: Side, b: Point, bSide: Side) {
  const distance = Math.max(80, Math.min(280, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const v1 = sideVector(aSide);
  const v2 = sideVector(bSide);
  return {
    c1: { x: a.x + v1.x * distance, y: a.y + v1.y * distance },
    c2: { x: b.x + v2.x * distance, y: b.y + v2.y * distance }
  };
}

function sideVector(side: Side) {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "right") return { x: 1, y: 0 };
  if (side === "bottom") return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function cubic(a: Point, b: Point, c: Point, d: Point, t: number) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * b.x + 3 * mt * t ** 2 * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * b.y + 3 * mt * t ** 2 * c.y + t ** 3 * d.y
  };
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawMarqueeScreen() {
  if (state.pointer?.type !== "marquee") return;
  const a = worldToScreen(state.pointer.startWorld);
  const b = worldToScreen(state.pointer.currentWorld);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  ctx.save();
  ctx.fillStyle = "rgba(15, 120, 135, 0.09)";
  ctx.strokeStyle = "rgba(15, 120, 135, 0.75)";
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function hitTest(world: Point, includeEdges = true): Hit {
  const handleHit = hitHandle(world);
  if (handleHit) return handleHit;

  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    if (state.selectedNodes.has(node.id)) {
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

function hitHandle(world: Point): Extract<Hit, { type: "handle" }> | undefined {
  const radius = 11 / state.board.view.scale;
  for (let i = state.board.nodes.length - 1; i >= 0; i -= 1) {
    const node = state.board.nodes[i];
    for (const side of ["top", "right", "bottom", "left"] as Side[]) {
      const p = sidePoint(node, side);
      if (Math.hypot(world.x - p.x, world.y - p.y) <= radius) {
        return { type: "handle", node, side };
      }
    }
  }
  return undefined;
}

function hitResize(world: Point, node: BoardNode): ResizeCorner | undefined {
  const radius = 10 / state.board.view.scale;
  for (const handle of resizeHandles(node)) {
    if (Math.hypot(world.x - handle.x, world.y - handle.y) <= radius) return handle.corner;
  }
  return undefined;
}

function hitEdge(world: Point): BoardEdge | undefined {
  const tolerance = 8 / state.board.view.scale;
  for (let i = state.board.edges.length - 1; i >= 0; i -= 1) {
    const edge = state.board.edges[i];
    const from = getNode(edge.fromNode);
    const to = getNode(edge.toNode);
    if (!from || !to) continue;
    const a = sidePoint(from, edge.fromSide);
    const b = sidePoint(to, edge.toSide);
    const cp = bezierControlPoints(a, edge.fromSide, b, edge.toSide);
    for (let t = 0.05; t <= 1; t += 0.05) {
      const p = cubic(a, cp.c1, cp.c2, b, t);
      if (Math.hypot(world.x - p.x, world.y - p.y) <= tolerance) return edge;
    }
  }
  return undefined;
}

function handlePointerDown(event: PointerEvent) {
  hideContextMenu();
  finishEditing(true);
  canvas.setPointerCapture(event.pointerId);
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  state.pointerWorld = world;

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
  if (hit.type === "handle") {
    state.pointer = { type: "connect", fromNode: hit.node.id, fromSide: hit.side, to: world };
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
      aspect: hit.node.kind === "image" ? hit.node.w / hit.node.h : undefined
    };
    return;
  }
  if (hit.type === "node") {
    if (event.shiftKey) {
      if (state.selectedNodes.has(hit.node.id)) state.selectedNodes.delete(hit.node.id);
      else state.selectedNodes.add(hit.node.id);
    } else if (!state.selectedNodes.has(hit.node.id)) {
      state.selectedNodes = new Set([hit.node.id]);
      state.selectedEdges.clear();
      state.selectedGroups.clear();
    }
    bringNodesToFront([...state.selectedNodes]);
    const selectedNodes = state.board.nodes.filter((node) => state.selectedNodes.has(node.id));
    state.pointer = {
      type: "drag-node",
      startWorld: world,
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
    state.selectedNodes.clear();
    state.selectedGroups.clear();
    state.selectedEdges = new Set([hit.edge.id]);
    updateInspector();
    queueRedraw();
    return;
  }
  if (hit.type === "group") {
    state.selectedGroups = new Set([hit.group.id]);
    state.selectedNodes.clear();
    state.selectedEdges.clear();
    const nodeIds = new Set(groupedNodeIds(hit.group));
    state.pointer = {
      type: "drag-group",
      groupId: hit.group.id,
      startWorld: world,
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
  state.pointer = { type: "marquee", startWorld: world, currentWorld: world };
  queueRedraw();
}

function handlePointerMove(event: PointerEvent) {
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  state.pointerWorld = world;
  if (!state.pointer) {
    const hit = hitTest(world, false);
    state.hoverNode = hit.type === "node" || hit.type === "handle" || hit.type === "resize" ? hit.node.id : undefined;
    state.hoverHandle = hit.type === "handle" ? { nodeId: hit.node.id, side: hit.side } : undefined;
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
    state.pointer.to = world;
    const hit = hitHandle(world);
    state.hoverHandle = hit ? { nodeId: hit.node.id, side: hit.side } : undefined;
    queueRedraw();
    return;
  }
  if (state.pointer.type === "drag-node") {
    const dx = world.x - state.pointer.startWorld.x;
    const dy = world.y - state.pointer.startWorld.y;
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
    resizeNode(node, state.pointer, world);
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

function handlePointerUp(event: PointerEvent) {
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  const pointer = state.pointer;
  state.pointer = undefined;
  if (!pointer) return;

  if (pointer.type === "connect") {
    const hit = hitHandle(world);
    if (hit && hit.node.id !== pointer.fromNode) {
      addEdge(makeEdge(pointer.fromNode, pointer.fromSide, hit.node.id, hit.side));
    } else {
      const newNode = makeTextNode(world);
      addNode(newNode);
      addEdge(makeEdge(pointer.fromNode, pointer.fromSide, newNode.id, oppositeSide(pointer.fromSide)));
      requestAnimationFrame(() => editNode(newNode.id));
    }
  }
  if (["drag-node", "drag-group", "resize-node", "marquee", "pan"].includes(pointer.type)) {
    scheduleSave();
  }
  state.hoverHandle = undefined;
  updateInspector();
  queueRedraw();
}

function handleDoubleClick(event: MouseEvent) {
  const world = screenToWorld(screenPoint(event));
  const hit = hitTest(world);
  if (hit.type === "node") {
    if (hit.node.kind === "link" && event.ctrlKey && hit.node.url) {
      window.open(hit.node.url);
      return;
    }
    editNode(hit.node.id);
    return;
  }
  if (hit.type === "edge") {
    const label = window.prompt("连线标签", hit.edge.label || "");
    if (label !== null) {
      hit.edge.label = label;
      scheduleSave();
      queueRedraw();
    }
    return;
  }
  if (hit.type === "group") {
    const title = window.prompt("分组标题", hit.group.title || "分组");
    if (title !== null) {
      hit.group.title = title;
      scheduleSave();
      queueRedraw();
    }
    return;
  }
  addNode(makeTextNode(world), true);
}

function handleWheel(event: WheelEvent) {
  event.preventDefault();
  finishEditing(true);
  const screen = screenPoint(event);
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

function updateCursor(hit: Hit) {
  if (state.spaceDown) {
    canvas.style.cursor = "grab";
  } else if (hit.type === "handle") {
    canvas.style.cursor = "crosshair";
  } else if (hit.type === "resize") {
    canvas.style.cursor = hit.corner === "nw" || hit.corner === "se" ? "nwse-resize" : "nesw-resize";
  } else if (hit.type === "node" || hit.type === "group") {
    canvas.style.cursor = "move";
  } else {
    canvas.style.cursor = "default";
  }
}

function resizeNode(
  node: BoardNode,
  pointer: Extract<PointerInteraction, { type: "resize-node" }>,
  world: Point
) {
  const dx = world.x - pointer.startWorld.x;
  const dy = world.y - pointer.startWorld.y;
  let { x, y, w, h } = pointer.startRect;
  if (pointer.corner.includes("e")) w = pointer.startRect.w + dx;
  if (pointer.corner.includes("s")) h = pointer.startRect.h + dy;
  if (pointer.corner.includes("w")) {
    x = pointer.startRect.x + dx;
    w = pointer.startRect.w - dx;
  }
  if (pointer.corner.includes("n")) {
    y = pointer.startRect.y + dy;
    h = pointer.startRect.h - dy;
  }

  if (pointer.aspect) {
    if (Math.abs(dx) > Math.abs(dy)) h = w / pointer.aspect;
    else w = h * pointer.aspect;
    if (pointer.corner.includes("w")) x = pointer.startRect.x + pointer.startRect.w - w;
    if (pointer.corner.includes("n")) y = pointer.startRect.y + pointer.startRect.h - h;
  }

  node.w = snap(Math.max(MIN_NODE_W, w));
  node.h = snap(Math.max(MIN_NODE_H, h));
  node.x = snap(x);
  node.y = snap(y);
  state.textCache.clear();
}

function marqueeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}

function editNode(nodeId: string) {
  const node = getNode(nodeId);
  if (!node || node.kind === "image") return;
  state.editingNode = nodeId;
  selectOnlyNode(nodeId);
  editor.value = node.text || "";
  editor.style.display = "block";
  editor.focus();
  editor.select();
  repositionEditor();
}

function finishEditing(save: boolean) {
  if (!state.editingNode) return;
  const node = getNode(state.editingNode);
  if (node && save) {
    node.text = editor.value;
    if (node.kind === "link") node.url = editor.value.trim();
    state.textCache.clear();
    scheduleSave();
  }
  state.editingNode = undefined;
  editor.style.display = "none";
  queueRedraw();
}

function repositionEditor() {
  if (!state.editingNode || editor.style.display === "none") return;
  const node = getNode(state.editingNode);
  if (!node) return;
  const topOffset = node.kind === "link" ? 34 : TEXT_PADDING;
  const p = worldToScreen({ x: node.x + TEXT_PADDING, y: node.y + topOffset });
  const scale = state.board.view.scale;
  editor.style.left = `${p.x}px`;
  editor.style.top = `${p.y}px`;
  editor.style.width = `${Math.max(40, (node.w - TEXT_PADDING * 2) * scale)}px`;
  editor.style.height = `${Math.max(36, (node.h - topOffset - TEXT_PADDING) * scale)}px`;
  editor.style.fontSize = `${(node.kind === "link" ? 14 : 15) * scale}px`;
  editor.style.lineHeight = `${1.42}`;
}

function zoomAtCenter(factor: number) {
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

async function addImagesAt(images: ImportedImage[], point = state.pointerWorld) {
  let offset = 0;
  for (const image of images) {
    addNode(makeImageNode({ x: point.x + offset, y: point.y + offset }, image));
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

async function pasteImage() {
  const image = await window.mindboard.readClipboardImage();
  if (image) {
    await addImagesAt([image]);
    showToast("已从剪贴板粘贴图片");
  } else {
    showToast("剪贴板里没有图片");
  }
}

function updateInspector() {
  const empty = document.querySelector<HTMLElement>(".inspector-empty");
  const content = document.querySelector<HTMLElement>(".inspector-content");
  if (!empty || !content) return;
  const selected = [...state.selectedNodes].map(getNode).filter(Boolean) as BoardNode[];
  empty.classList.toggle("hidden", selected.length > 0);
  content.classList.toggle("hidden", selected.length === 0);
  if (!selected.length) return;
  const node = selected[0];
  const width = document.querySelector<HTMLInputElement>("[data-inspector='width']");
  const height = document.querySelector<HTMLInputElement>("[data-inspector='height']");
  if (width) width.value = Math.round(node.w).toString();
  if (height) height.value = Math.round(node.h).toString();
  const cropPanel = document.querySelector<HTMLElement>(".crop-panel");
  cropPanel?.classList.toggle("hidden", node.kind !== "image");
  if (node.kind === "image") {
    const crop = normalizedCrop(node.crop);
    setCropInput("left", crop.left * 100);
    setCropInput("top", crop.top * 100);
    setCropInput("right", crop.right * 100);
    setCropInput("bottom", crop.bottom * 100);
  }
}

function setCropInput(name: keyof CropState, value: number) {
  const input = document.querySelector<HTMLInputElement>(`[data-crop='${name}']`);
  if (input) input.value = Math.round(value).toString();
}

function changeSelectedSize(axis: "w" | "h", value: number) {
  const nodes = [...state.selectedNodes].map(getNode).filter(Boolean) as BoardNode[];
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

function changeSelectedColor(color: string) {
  for (const id of state.selectedNodes) {
    const node = getNode(id);
    if (node) node.color = color;
  }
  scheduleSave();
  queueRedraw();
}

function changeCrop(name: keyof CropState, value: number) {
  const node = getNode([...state.selectedNodes][0]);
  if (!node || node.kind !== "image") return;
  const crop = normalizedCrop(node.crop);
  crop[name] = value / 100;
  if (crop.right - crop.left < 0.08) {
    if (name === "left") crop.left = crop.right - 0.08;
    if (name === "right") crop.right = crop.left + 0.08;
  }
  if (crop.bottom - crop.top < 0.08) {
    if (name === "top") crop.top = crop.bottom - 0.08;
    if (name === "bottom") crop.bottom = crop.top + 0.08;
  }
  node.crop = normalizedCrop(crop);
  const aspect = (node.crop.right - node.crop.left) / (node.crop.bottom - node.crop.top);
  node.h = Math.max(MIN_NODE_H, node.w / aspect);
  updateInspector();
  scheduleSave();
  queueRedraw();
}

function resetCrop() {
  const node = getNode([...state.selectedNodes][0]);
  if (!node || node.kind !== "image") return;
  node.crop = { left: 0, top: 0, right: 1, bottom: 1 };
  scheduleSave();
  updateInspector();
  queueRedraw();
}

function scheduleSave() {
  if (state.saveTimer) window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    void window.mindboard.saveBoard(boardForSave()).catch((error) => {
      console.error(error);
      showToast("自动保存失败");
    });
  }, 350);
}

function updateZoomReadout() {
  const readout = document.querySelector<HTMLElement>(".zoom-readout");
  if (readout) readout.textContent = `${Math.round(state.board.view.scale * 100)}%`;
}

function showToast(message: string) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  window.clearTimeout(Number(toastEl.dataset.timer || 0));
  const timer = window.setTimeout(() => toastEl.classList.add("hidden"), 2200);
  toastEl.dataset.timer = String(timer);
}

function showContextMenu(point: Point, items: Array<{ label: string; action: () => void }>) {
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

function handleContextMenu(event: MouseEvent) {
  event.preventDefault();
  const screen = screenPoint(event);
  const world = screenToWorld(screen);
  const hit = hitTest(world);
  state.pointerWorld = world;
  const items: Array<{ label: string; action: () => void }> = [];
  if (hit.type === "node") {
    selectOnlyNode(hit.node.id);
    if (hit.node.kind !== "image") items.push({ label: "编辑", action: () => editNode(hit.node.id) });
    if (hit.node.kind === "image") items.push({ label: "重置裁剪", action: resetCrop });
    items.push({ label: "复制", action: duplicateSelection });
    items.push({ label: "删除", action: removeSelection });
  } else {
    items.push({ label: "新建文本", action: () => addNode(makeTextNode(world), true) });
    items.push({ label: "添加图片", action: () => void pickImages() });
    items.push({ label: "新建分组", action: createGroupFromSelection });
    items.push({ label: "粘贴图片", action: () => void pasteImage() });
  }
  showContextMenu(screen, items);
}

function installEventHandlers() {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
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
    if (event.code === "Space") {
      state.spaceDown = true;
      canvas.style.cursor = "grab";
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
      void pasteImage();
    }
    if (event.key === "Escape") {
      hideContextMenu();
      clearSelection();
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
  editor.addEventListener("input", () => {
    const node = getNode(state.editingNode || "");
    if (node) {
      node.text = editor.value;
      state.textCache.clear();
      queueRedraw();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action || "";
      if (["select", "text", "image", "link"].includes(action)) {
        if (action === "image") void pickImages();
        else setTool(action as Tool);
      }
      if (action === "delete") removeSelection();
      if (action === "duplicate") duplicateSelection();
      if (action === "group") createGroupFromSelection();
      if (action === "crop") updateInspector();
      if (action === "zoom-in") zoomAtCenter(1.18);
      if (action === "zoom-out") zoomAtCenter(1 / 1.18);
      if (action === "zoom-reset") {
        state.board.view.scale = 1;
        updateZoomReadout();
        queueRedraw();
        scheduleSave();
      }
      if (action === "fit") fitContent();
      if (action === "export") void exportBoard();
      if (action === "import") void importBoard();
      if (action === "reset-crop") resetCrop();
    });
  });

  document.querySelector<HTMLInputElement>("[data-inspector='width']")?.addEventListener("change", (event) => {
    changeSelectedSize("w", Number((event.target as HTMLInputElement).value));
  });
  document.querySelector<HTMLInputElement>("[data-inspector='height']")?.addEventListener("change", (event) => {
    changeSelectedSize("h", Number((event.target as HTMLInputElement).value));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
    button.addEventListener("click", () => changeSelectedColor(button.dataset.color || "#fffdf8"));
  });
  document.querySelectorAll<HTMLInputElement>("[data-crop]").forEach((input) => {
    input.addEventListener("input", () => changeCrop(input.dataset.crop as keyof CropState, Number(input.value)));
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const paths = files.map((file) => window.mindboard.getPathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    state.pointerWorld = screenToWorld({ x: event.clientX, y: event.clientY });
    window.mindboard
      .importFilePaths(paths)
      .then((images) => addImagesAt(images, state.pointerWorld))
      .then(() => {
        if (paths.length) showToast("已导入拖入的图片");
      })
      .catch((error) => {
        console.error(error);
        showToast("拖入图片失败");
      });
  });
}

async function exportBoard() {
  finishEditing(true);
  const result = await window.mindboard.exportBoard(boardForSave());
  if (result.ok) showToast("已导出 .mindboard");
}

async function importBoard() {
  finishEditing(true);
  const imported = await window.mindboard.importBoard();
  if (!imported) return;
  state.board = normalizeBoard(imported);
  clearSelection();
  updateZoomReadout();
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
    state.board.view = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, scale: 1 };
  }
  updateZoomReadout();
  updateInspector();
  queueRedraw();
}

void boot();
