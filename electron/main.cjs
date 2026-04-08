const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { createBackupService } = require("./backup-service.cjs");

let mainWindow;
let settingsWindow;

function loadRenderer(window, hash = "") {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    window.loadURL(`${devServerUrl}${hash}`);
    return;
  }
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: hash.replace(/^#/, "") });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loadRenderer(mainWindow, "#/main");
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 680,
    parent: mainWindow,
    title: "设置",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loadRenderer(settingsWindow, "#/settings");
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

app.whenReady().then(() => {
  const service = createBackupService({
    settingsFile: path.join(app.getPath("userData"), "backup-settings.json"),
    logsDir: path.join(app.getPath("userData"), "logs"),
  });

  ipcMain.handle("backup:select-folder", async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(targetWindow, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("backup:run", async (_, payload) => service.runBackup(payload || {}));
  ipcMain.handle("backup:open-path", async (_, targetPath) => {
    if (!targetPath || typeof targetPath !== "string") return "路径为空";
    const result = await shell.openPath(targetPath);
    return result || "";
  });
  ipcMain.handle("backup:open-settings", async () => {
    createSettingsWindow();
    return true;
  });

  Menu.setApplicationMenu(null);
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
