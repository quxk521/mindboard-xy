const { app, BrowserWindow, dialog, ipcMain, shell, webUtils } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let converterModulePromise;

function converterModule() {
  if (!converterModulePromise) {
    const modulePath = path.join(__dirname, "..", "scripts", "convert-obsidian-canvas.mjs");
    converterModulePromise = import(pathToFileURL(modulePath).href);
  }
  return converterModulePromise;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    title: "Canvas Converter",
    backgroundColor: "#f5f3ee",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "converter-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, "..", "converter.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("converter:pick-canvas", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 Obsidian Canvas 文件",
    properties: ["openFile"],
    filters: [{ name: "Obsidian Canvas", extensions: ["canvas"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("converter:pick-vault", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 Obsidian 库目录",
    properties: ["openDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("converter:pick-output", async (_event, inputPath) => {
  const converter = await converterModule();
  const defaultPath = inputPath ? converter.defaultOutputPath(path.resolve(inputPath)) : path.join(app.getPath("documents"), "board.mindboard");
  const result = await dialog.showSaveDialog({
    title: "保存 MindBoard 文件",
    defaultPath,
    filters: [{ name: "MindBoard", extensions: ["mindboard"] }]
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle("converter:guess-defaults", async (_event, inputPath) => {
  if (!inputPath) return null;
  const converter = await converterModule();
  const resolvedInputPath = path.resolve(inputPath);
  const canvasDir = path.dirname(resolvedInputPath);
  return {
    outputPath: converter.defaultOutputPath(resolvedInputPath),
    vaultDir: converter.findVaultRoot(canvasDir) || canvasDir
  };
});

ipcMain.handle("converter:convert", async (_event, options) => {
  const converter = await converterModule();
  const result = converter.convertFile({
    inputPath: options?.inputPath,
    outputPath: options?.outputPath,
    vaultDir: options?.vaultDir,
    embedImages: options?.embedImages !== false
  });
  return {
    inputPath: result.inputPath,
    outputPath: result.outputPath,
    vaultDir: result.vaultDir,
    warnings: result.warnings,
    stats: {
      nodes: result.board.nodes.length,
      groups: result.board.groups.length,
      edges: result.board.edges.length
    }
  };
});

ipcMain.handle("converter:reveal-output", (_event, outputPath) => {
  if (outputPath) shell.showItemInFolder(outputPath);
});

ipcMain.handle("converter:get-file-path", (_event, file) => {
  if (webUtils?.getPathForFile) return webUtils.getPathForFile(file);
  return file?.path || "";
});
