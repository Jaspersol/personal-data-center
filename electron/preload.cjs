const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("backupApi", {
  selectFolder: () => ipcRenderer.invoke("backup:select-folder"),
  runBackup: (payload) => ipcRenderer.invoke("backup:run", payload),
  openPath: (targetPath) => ipcRenderer.invoke("backup:open-path", targetPath),
  openSettings: () => ipcRenderer.invoke("backup:open-settings"),
  readLog: () => ipcRenderer.invoke("backup:read-log"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
});

contextBridge.exposeInMainWorld("updateApi", {
  getVersion: () => ipcRenderer.invoke("update:get-version"),
  check: () => ipcRenderer.invoke("update:check"),
  lastResult: () => ipcRenderer.invoke("update:last-result"),
  install: () => ipcRenderer.invoke("update:install"),
  openReleasePage: (url) => ipcRenderer.invoke("update:open-release-page", url),
  getAutoCheck: () => ipcRenderer.invoke("update:get-auto-check"),
  setAutoCheck: (enabled) => ipcRenderer.invoke("update:set-auto-check", enabled),
  onProgress: (callback) => subscribe("update:progress", callback),
  onCheckResult: (callback) => subscribe("update:check-result", callback),
});
