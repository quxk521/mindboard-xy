const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("mindboard", {
  loadBoard: () => ipcRenderer.invoke("board:load"),
  saveBoard: (board) => ipcRenderer.invoke("board:save", board),
  pickImages: () => ipcRenderer.invoke("dialog:pick-images"),
  importFilePaths: (paths) => ipcRenderer.invoke("asset:import-file-paths", paths),
  readClipboardImage: () => ipcRenderer.invoke("clipboard:read-image"),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  exportBoard: (board) => ipcRenderer.invoke("dialog:export-board", board),
  importBoard: () => ipcRenderer.invoke("dialog:import-board"),
  getPathForFile: (file) => {
    if (webUtils?.getPathForFile) {
      return webUtils.getPathForFile(file);
    }
    return file?.path ?? "";
  }
});
