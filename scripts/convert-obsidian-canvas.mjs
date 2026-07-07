#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_W = 96;
const MIN_NODE_H = 48;
const DEFAULT_TEXT_W = 240;
const DEFAULT_TEXT_H = 120;
const DEFAULT_LINK_W = 240;
const DEFAULT_LINK_H = 84;
const DEFAULT_IMAGE_W = 320;
const DEFAULT_IMAGE_H = 220;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"]);
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const VALID_SIDES = new Set(["top", "right", "bottom", "left"]);

const colors = {
  text: "#26231f",
  edge: "#7a756b",
  paper: "#fffdf8",
  link: "#e9f3ff"
};

const nodeColorMap = {
  "1": "#fdecef",
  "2": "#fff1cc",
  "3": "#fff7d6",
  "4": "#e9f8ef",
  "5": "#e9f3ff",
  "6": "#f0edff"
};

const edgeColorMap = {
  "1": "#a12834",
  "2": "#ad7c19",
  "3": "#c49b22",
  "4": "#5d8f55",
  "5": "#0f7887",
  "6": "#7659b8"
};

const groupColorMap = {
  "1": "rgba(161, 40, 52, 0.08)",
  "2": "rgba(173, 124, 25, 0.1)",
  "3": "rgba(196, 155, 34, 0.1)",
  "4": "rgba(93, 143, 85, 0.1)",
  "5": "rgba(15, 120, 135, 0.08)",
  "6": "rgba(118, 89, 184, 0.09)"
};

function usage() {
  return `
用法:
  node scripts/convert-obsidian-canvas.mjs <输入.canvas> [输出.mindboard] [--vault <Obsidian库目录>]

选项:
  -o, --output <文件>        指定输出 .mindboard 文件
  --vault <目录>            指定 Obsidian vault 根目录，用来解析图片和 Markdown 文件
  --no-embed-images         不把图片写入输出文件，只保留图片节点占位
  -h, --help                显示帮助

示例:
  node scripts/convert-obsidian-canvas.mjs "C:\\Vault\\画板.canvas" --vault "C:\\Vault"
  node scripts/convert-obsidian-canvas.mjs "C:\\Vault\\画板.canvas" "C:\\Temp\\画板.mindboard" --vault "C:\\Vault"
`.trim();
}

function parseArgs(argv) {
  const parsed = { positional: [], embedImages: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--no-embed-images") parsed.embedImages = false;
    else if (arg === "-o" || arg === "--output") parsed.output = argv[++i];
    else if (arg === "--vault") parsed.vault = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`未知选项: ${arg}`);
    else parsed.positional.push(arg);
  }
  if (!parsed.output && parsed.positional.length > 1) parsed.output = parsed.positional[1];
  return parsed;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON: ${filePath}\n${error.message}`);
  }
}

function findVaultRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".obsidian"))) return current;
    const next = path.dirname(current);
    if (next === current) return undefined;
    current = next;
  }
}

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeId(value, prefix, used) {
  const raw = String(value || Math.random().toString(36).slice(2));
  const safe = raw.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "item";
  let id = `${prefix}_${safe}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `${prefix}_${safe}_${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function sanitizeAssetName(value) {
  return path
    .basename(String(value || "asset"))
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

function normalizeSide(side, fallback) {
  return VALID_SIDES.has(side) ? side : fallback;
}

function normalizeColor(value, fallback, map = nodeColorMap) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return map[color] || fallback;
}

function nodeRect(node, fallbackW, fallbackH) {
  return {
    x: numberOr(node.x, 0),
    y: numberOr(node.y, 0),
    w: Math.max(MIN_NODE_W, numberOr(node.width, fallbackW)),
    h: Math.max(MIN_NODE_H, numberOr(node.height, fallbackH))
  };
}

function splitObsidianFileRef(file) {
  const raw = safeDecode(String(file || ""));
  const hashIndex = raw.indexOf("#");
  if (hashIndex === -1) return { file: raw, subpath: "" };
  return {
    file: raw.slice(0, hashIndex),
    subpath: raw.slice(hashIndex + 1)
  };
}

function filePathFromMaybeUrl(value) {
  if (!value.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function resolveCanvasFile(fileRef, { canvasDir, vaultDir }) {
  const split = splitObsidianFileRef(fileRef);
  const normalized = split.file.replace(/[\\/]+/g, path.sep);
  const fromUrl = filePathFromMaybeUrl(split.file);
  const candidates = [];
  if (fromUrl) candidates.push(fromUrl);
  if (path.isAbsolute(normalized)) candidates.push(normalized);
  candidates.push(path.join(vaultDir, normalized));
  candidates.push(path.join(canvasDir, normalized));
  const absolutePath = candidates.find((candidate) => fs.existsSync(candidate));
  return {
    raw: String(fileRef || ""),
    file: split.file,
    subpath: split.subpath,
    absolutePath,
    exists: Boolean(absolutePath)
  };
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

function imageDataUrl(filePath) {
  return `data:${mimeForPath(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function isImageFile(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isTextFile(fileName) {
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function makeTextNode(id, canvasNode, text) {
  const rect = nodeRect(canvasNode, DEFAULT_TEXT_W, DEFAULT_TEXT_H);
  return {
    id,
    kind: "text",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    text: text || "",
    scrollY: 0,
    textColor: colors.text,
    color: normalizeColor(canvasNode.color, colors.paper)
  };
}

function makeLinkNode(id, canvasNode) {
  const rect = nodeRect(canvasNode, DEFAULT_LINK_W, DEFAULT_LINK_H);
  const url = String(canvasNode.url || "");
  return {
    id,
    kind: "link",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    text: url,
    url,
    scrollY: 0,
    textColor: colors.text,
    color: normalizeColor(canvasNode.color, colors.link)
  };
}

function makeImageNode(id, canvasNode, fileInfo, options, warnings) {
  const rect = nodeRect(canvasNode, DEFAULT_IMAGE_W, DEFAULT_IMAGE_H);
  const node = {
    id,
    kind: "image",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    text: "",
    color: normalizeColor(canvasNode.color, colors.paper),
    crop: { left: 0, top: 0, right: 1, bottom: 1 },
    assetName: sanitizeAssetName(fileInfo.file || "image.png")
  };

  if (options.embedImages && fileInfo.absolutePath) {
    node.dataUrl = imageDataUrl(fileInfo.absolutePath);
  } else if (!fileInfo.absolutePath) {
    warnings.push(`图片文件未找到，已保留占位: ${fileInfo.raw}`);
  }
  return node;
}

function makeFileTextNode(id, canvasNode, fileInfo, warnings) {
  let text = `文件: ${fileInfo.raw}`;
  if (fileInfo.absolutePath && isTextFile(fileInfo.absolutePath)) {
    text = fs.readFileSync(fileInfo.absolutePath, "utf8");
    if (fileInfo.subpath) text = `# ${fileInfo.subpath}\n\n${text}`;
  } else if (!fileInfo.absolutePath) {
    warnings.push(`文件未找到，已转成文本占位: ${fileInfo.raw}`);
  }
  return makeTextNode(id, canvasNode, text);
}

function makeGroup(canvasNode, id) {
  const rect = nodeRect(canvasNode, 360, 240);
  return {
    id,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    title: canvasNode.label || "分组",
    color: normalizeColor(canvasNode.color, "rgba(15, 120, 135, 0.08)", groupColorMap)
  };
}

function edgeArrow(edge) {
  const fromArrow = edge.fromEnd === "arrow";
  const toArrow = edge.toEnd === "arrow" || (!edge.fromEnd && !edge.toEnd);
  if (fromArrow && toArrow) return "both";
  if (!fromArrow && !toArrow) return "none";
  return "forward";
}

function convertEdges(canvasEdges, idMap, usedIds, warnings) {
  const edges = [];
  for (const edge of canvasEdges) {
    const fromId = idMap.get(edge.fromNode);
    const toId = idMap.get(edge.toNode);
    if (!fromId || !toId) {
      warnings.push(`已跳过无法连接的连线: ${edge.id || `${edge.fromNode}->${edge.toNode}`}`);
      continue;
    }

    const fromArrowOnly = edge.fromEnd === "arrow" && edge.toEnd !== "arrow";
    const id = sanitizeId(edge.id || `${edge.fromNode}_${edge.toNode}`, "edge", usedIds);
    if (fromArrowOnly) {
      edges.push({
        id,
        fromNode: toId,
        fromSide: normalizeSide(edge.toSide, "left"),
        toNode: fromId,
        toSide: normalizeSide(edge.fromSide, "right"),
        color: normalizeColor(edge.color, colors.edge, edgeColorMap),
        label: edge.label || "",
        arrow: "forward"
      });
    } else {
      edges.push({
        id,
        fromNode: fromId,
        fromSide: normalizeSide(edge.fromSide, "right"),
        toNode: toId,
        toSide: normalizeSide(edge.toSide, "left"),
        color: normalizeColor(edge.color, colors.edge, edgeColorMap),
        label: edge.label || "",
        arrow: edgeArrow(edge)
      });
    }
  }
  return edges;
}

function fitInitialView(nodes, groups) {
  const items = [...nodes, ...groups];
  if (!items.length) return { x: 0, y: 0, scale: 1, gridVisible: true };
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  return { x: 120 - minX, y: 100 - minY, scale: 1, gridVisible: true };
}

function convertCanvas(canvas, options) {
  if (!Array.isArray(canvas.nodes)) throw new Error("输入文件缺少 nodes 数组");
  if (canvas.edges && !Array.isArray(canvas.edges)) throw new Error("输入文件的 edges 不是数组");

  const usedIds = new Set();
  const idMap = new Map();
  const nodes = [];
  const groups = [];
  const warnings = [];

  for (const canvasNode of canvas.nodes) {
    if (!canvasNode?.id) {
      warnings.push("已跳过缺少 id 的节点");
      continue;
    }

    if (canvasNode.type === "group") {
      groups.push(makeGroup(canvasNode, sanitizeId(canvasNode.id, "group", usedIds)));
      continue;
    }

    const id = sanitizeId(canvasNode.id, "node", usedIds);
    idMap.set(canvasNode.id, id);

    if (canvasNode.type === "text") {
      nodes.push(makeTextNode(id, canvasNode, canvasNode.text || ""));
    } else if (canvasNode.type === "link") {
      nodes.push(makeLinkNode(id, canvasNode));
    } else if (canvasNode.type === "file") {
      const fileInfo = resolveCanvasFile(canvasNode.file, options);
      if (isImageFile(fileInfo.file)) nodes.push(makeImageNode(id, canvasNode, fileInfo, options, warnings));
      else nodes.push(makeFileTextNode(id, canvasNode, fileInfo, warnings));
    } else {
      warnings.push(`未知节点类型已转成文本: ${canvasNode.type || "unknown"}`);
      nodes.push(makeTextNode(id, canvasNode, canvasNode.text || canvasNode.label || canvasNode.file || ""));
    }
  }

  const edges = convertEdges(canvas.edges || [], idMap, usedIds, warnings);
  return {
    board: {
      version: 2,
      view: fitInitialView(nodes, groups),
      nodes,
      edges,
      groups,
      jumpAreas: {}
    },
    warnings
  };
}

function defaultOutputPath(inputPath) {
  return path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.mindboard`);
}

function convertFile({ inputPath, outputPath, vaultDir, embedImages = true }) {
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath || defaultOutputPath(resolvedInputPath));
  const canvasDir = path.dirname(resolvedInputPath);
  const resolvedVaultDir = path.resolve(vaultDir || findVaultRoot(canvasDir) || canvasDir);
  const canvas = safeReadJson(resolvedInputPath);
  const { board, warnings } = convertCanvas(canvas, {
    canvasDir,
    vaultDir: resolvedVaultDir,
    embedImages
  });

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  return {
    inputPath: resolvedInputPath,
    outputPath: resolvedOutputPath,
    vaultDir: resolvedVaultDir,
    board,
    warnings
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.positional[0]) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = path.resolve(args.positional[0]);
  const outputPath = path.resolve(args.output || defaultOutputPath(inputPath));
  const canvasDir = path.dirname(inputPath);
  const vaultDir = path.resolve(args.vault || findVaultRoot(canvasDir) || canvasDir);
  const { board, warnings } = convertFile({
    inputPath,
    outputPath,
    vaultDir,
    embedImages: args.embedImages
  });

  console.log(`已转换: ${inputPath}`);
  console.log(`输出文件: ${outputPath}`);
  console.log(`Vault目录: ${vaultDir}`);
  console.log(`节点: ${board.nodes.length}，分组: ${board.groups.length}，连线: ${board.edges.length}`);
  if (warnings.length) {
    console.log("\n警告:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

const cliEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (cliEntry) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { convertCanvas, convertFile, defaultOutputPath, findVaultRoot, parseArgs, usage };
