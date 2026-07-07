const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("canvasConverter", {
  pickCanvas: () => ipcRenderer.invoke("converter:pick-canvas"),
  pickVault: () => ipcRenderer.invoke("converter:pick-vault"),
  pickOutput: (inputPath) => ipcRenderer.invoke("converter:pick-output", inputPath),
  guessDefaults: (inputPath) => ipcRenderer.invoke("converter:guess-defaults", inputPath),
  convert: (options) => ipcRenderer.invoke("converter:convert", options),
  revealOutput: (outputPath) => ipcRenderer.invoke("converter:reveal-output", outputPath),
  getPathForFile: (file) => {
    if (webUtils?.getPathForFile) return webUtils.getPathForFile(file);
    return file?.path || "";
  }
});
