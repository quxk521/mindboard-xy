const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath("userData", path.join(process.env.PORTABLE_EXECUTABLE_DIR, "MindBoard Data"));
}

function workspaceDir() {
  return path.join(app.getPath("userData"), "workspace");
}

function assetDir() {
  return path.join(workspaceDir(), "assets");
}

function boardPath() {
  return path.join(workspaceDir(), "board.json");
}

function ensureWorkspace() {
  fs.mkdirSync(assetDir(), { recursive: true });
}

function defaultBoard() {
  return {
    version: 2,
    view: { x: 0, y: 0, scale: 1, gridVisible: true },
    nodes: [],
    edges: [],
    groups: [],
    jumpAreas: {}
  };
}

function cleanBoard(board) {
  const safe = board && typeof board === "object" ? board : defaultBoard();
  return {
    version: Number(safe.version) || 2,
    view: {
      x: Number(safe.view?.x) || 0,
      y: Number(safe.view?.y) || 0,
      scale: Number(safe.view?.scale) || 1,
      gridVisible: safe.view?.gridVisible !== false
    },
    nodes: Array.isArray(safe.nodes)
      ? safe.nodes.map((node) => {
          const { assetUrl, dataUrl, ...rest } = node;
          return rest;
        })
      : [],
    edges: Array.isArray(safe.edges) ? safe.edges : [],
    groups: Array.isArray(safe.groups) ? safe.groups : [],
    jumpAreas: safe.jumpAreas && typeof safe.jumpAreas === "object" ? safe.jumpAreas : {}
  };
}

function assetUrlFromRelative(relativePath) {
  const absolute = path.join(workspaceDir(), relativePath);
  return pathToFileURL(absolute).href;
}

function decorateBoard(board) {
  const decorated = cleanBoard(board);
  decorated.nodes = decorated.nodes.map((node) => {
    if (node.kind === "image" && node.asset) {
      return { ...node, assetUrl: assetUrlFromRelative(node.asset) };
    }
    return node;
  });
  return decorated;
}

function readBoard() {
  ensureWorkspace();
  if (!fs.existsSync(boardPath())) {
    return defaultBoard();
  }
  try {
    const text = fs.readFileSync(boardPath(), "utf8");
    return decorateBoard(JSON.parse(text));
  } catch (error) {
    console.error("Could not read board:", error);
    return defaultBoard();
  }
}

function writeBoard(board) {
  ensureWorkspace();
  fs.writeFileSync(boardPath(), JSON.stringify(cleanBoard(board), null, 2), "utf8");
}

function safeName(name) {
  const ext = path.extname(name).toLowerCase();
  const base = path
    .basename(name, ext)
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "asset"}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext || ".png"}`;
}

function imageInfo(relativePath) {
  const absolute = path.join(workspaceDir(), relativePath);
  const image = nativeImage.createFromPath(absolute);
  const size = image.getSize();
  return {
    asset: relativePath,
    assetUrl: assetUrlFromRelative(relativePath),
    width: size.width || 360,
    height: size.height || 240
  };
}

function importAssetFromPath(filePath) {
  ensureWorkspace();
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return null;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"].includes(ext)) {
    return null;
  }
  const filename = safeName(path.basename(filePath));
  const relativePath = path.join("assets", filename).replace(/\\/g, "/");
  fs.copyFileSync(filePath, path.join(workspaceDir(), relativePath));
  return imageInfo(relativePath);
}

function saveClipboardImage() {
  ensureWorkspace();
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }
  const filename = safeName("clipboard.png");
  const relativePath = path.join("assets", filename).replace(/\\/g, "/");
  fs.writeFileSync(path.join(workspaceDir(), relativePath), image.toPNG());
  return imageInfo(relativePath);
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

function boardWithEmbeddedAssets(board) {
  ensureWorkspace();
  const portable = cleanBoard(board);
  portable.nodes = portable.nodes.map((node) => {
    if (node.kind !== "image" || !node.asset) return node;
    const absolute = path.join(workspaceDir(), node.asset);
    if (!fs.existsSync(absolute)) return node;
    const data = fs.readFileSync(absolute).toString("base64");
    return {
      ...node,
      assetName: path.basename(node.asset),
      dataUrl: `data:${mimeForPath(absolute)};base64,${data}`
    };
  });
  return portable;
}

function writeDataUrlAsset(dataUrl, preferredName = "asset.png") {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "image/png";
  const encoded = match[3];
  const ext =
    mime === "image/jpeg"
      ? ".jpg"
      : mime === "image/webp"
        ? ".webp"
        : mime === "image/gif"
          ? ".gif"
          : mime === "image/bmp"
            ? ".bmp"
            : mime === "image/avif"
              ? ".avif"
              : mime === "image/svg+xml"
                ? ".svg"
                : ".png";
  const filename = safeName(preferredName.endsWith(ext) ? preferredName : `${preferredName}${ext}`);
  const relativePath = path.join("assets", filename).replace(/\\/g, "/");
  const buffer = match[2] ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded));
  fs.writeFileSync(path.join(workspaceDir(), relativePath), buffer);
  return relativePath;
}

function importPortableBoard(sourcePath) {
  ensureWorkspace();
  const importedBoard = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  importedBoard.nodes = Array.isArray(importedBoard.nodes)
    ? importedBoard.nodes.map((node) => {
        if (node.kind !== "image" || !node.dataUrl) return node;
        const relativePath = writeDataUrlAsset(node.dataUrl, node.assetName || "asset.png");
        const { dataUrl, assetName, ...rest } = node;
        return relativePath ? { ...rest, asset: relativePath } : rest;
      })
    : [];
  writeBoard(importedBoard);
  return decorateBoard(importedBoard);
}

function rendererEntry() {
  if (isDev) {
    return process.env.VITE_DEV_SERVER_URL;
  }
  return path.join(__dirname, "..", "index.html");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "MindBoard",
    backgroundColor: "#f5f3ee",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const entry = rendererEntry();
  if (isDev) {
    win.loadURL(entry);
  } else {
    win.loadFile(entry);
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  ensureWorkspace();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("board:load", () => readBoard());

ipcMain.handle("board:save", (_event, board) => {
  writeBoard(board);
  return { ok: true };
});

ipcMain.handle("dialog:pick-images", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择图片",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"] }]
  });
  if (result.canceled) return [];
  return result.filePaths.map(importAssetFromPath).filter(Boolean);
});

ipcMain.handle("asset:import-file-paths", (_event, paths) => {
  if (!Array.isArray(paths)) return [];
  return paths.map(importAssetFromPath).filter(Boolean);
});

ipcMain.handle("clipboard:read-image", () => saveClipboardImage());

ipcMain.handle("clipboard:read-text", () => clipboard.readText());

ipcMain.handle("dialog:export-board", async (_event, board) => {
  const result = await dialog.showSaveDialog({
    title: "导出 MindBoard",
    defaultPath: "board.mindboard",
    filters: [{ name: "MindBoard", extensions: ["mindboard"] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.writeFileSync(result.filePath, JSON.stringify(boardWithEmbeddedAssets(board), null, 2), "utf8");
  return { ok: true, path: result.filePath };
});

ipcMain.handle("dialog:import-board", async () => {
  const result = await dialog.showOpenDialog({
    title: "导入 MindBoard",
    properties: ["openFile"],
    filters: [{ name: "MindBoard", extensions: ["mindboard"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importPortableBoard(result.filePaths[0]);
});
