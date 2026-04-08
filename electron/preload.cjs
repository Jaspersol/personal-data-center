const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backupApi", {
  selectFolder: () => ipcRenderer.invoke("backup:select-folder"),
  runBackup: (payload) => ipcRenderer.invoke("backup:run", payload),
  openPath: (targetPath) => ipcRenderer.invoke("backup:open-path", targetPath),
  openSettings: () => ipcRenderer.invoke("backup:open-settings"),
});
