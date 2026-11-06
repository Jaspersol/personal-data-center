const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { createBackupService } = require("./backup-service.cjs");

// 打包后 Electron 会向 argv 塞入自身参数（可执行文件路径、inspect 开关等），
// 需先过滤这些噪声再按用户参数解析
function parseCommandLineArgs() {
  const allArgs = process.argv.slice(1); // 从第一个参数开始（跳过 electron 路径）

  // 过滤掉 Electron 相关的参数
  const userArgs = allArgs.filter((arg) => {
    return (
      !arg.includes("electron") &&
      !arg.includes(".exe") &&
      !arg.includes("app.asar") &&
      arg !== "." &&
      !arg.startsWith("--inspect") &&
      !arg.startsWith("--remote-debugging")
    );
  });

  // 调试用：排查参数解析是否把 Electron 自身参数混进了用户参数
  console.log("所有参数:", process.argv);
  console.log("过滤后参数:", userArgs);

  return userArgs;
}

// 获取正确的配置文件路径
function getConfigPath(userArgs) {
  const configFlagIndex = userArgs.findIndex((item) => item === "--config" || item === "-c");

  // 如果用户指定了配置文件路径
  if (configFlagIndex >= 0 && userArgs[configFlagIndex + 1]) {
    return userArgs[configFlagIndex + 1];
  }

  // 打包环境：优先使用 userData 下的配置文件（可写，避免 Program Files 等只读位置导致写入失败）
  if (process.execPath && process.execPath.endsWith(".exe")) {
    const fs = require("fs");
    const exeDir = path.dirname(process.execPath);
    const resourcesDir = path.join(exeDir, "resources");
    const resourcesConfigPath = path.join(resourcesDir, "backup.config.json");
    const userDataConfigPath = path.join(app.getPath("userData"), "backup.config.json");

    // 调试用：排查打包后配置路径是否落在 userData 目录
    console.log("检查 userData 配置文件:", userDataConfigPath);

    if (fs.existsSync(userDataConfigPath)) {
      console.log("使用 userData 配置文件");
      return userDataConfigPath;
    }

    // 首次运行：从 resources 或 app.asar 内初始化 userData 配置文件
    const candidateSources = [
      resourcesConfigPath,
      path.join(resourcesDir, "app.asar", "backup.config.json"),
    ];
    for (const candidate of candidateSources) {
      try {
        if (fs.existsSync(candidate)) {
          fs.mkdirSync(path.dirname(userDataConfigPath), { recursive: true });
          fs.copyFileSync(candidate, userDataConfigPath);
          console.log(`已从 ${candidate} 初始化 userData 配置文件`);
          return userDataConfigPath;
        }
      } catch (error) {
        console.warn(`初始化 userData 配置文件失败 (${candidate}):`, error.message);
      }
    }

    // 无任何可用配置来源，直接使用 userData 路径（保存设置时自动创建）
    console.log("未找到现有配置文件，使用 userData 路径:", userDataConfigPath);
    return userDataConfigPath;
  }

  // 开发环境
  const devConfigPath = path.join(__dirname, "..", "backup.config.json");
  console.log("使用开发环境配置文件:", devConfigPath);
  return devConfigPath;
}

const args = parseCommandLineArgs();
const isBackupOnly = args.includes("--backup") || args.includes("-b");
const configPath = getConfigPath(args);

// 调试用：启动时打印最终生效的备份模式与配置路径
console.log("备份模式:", isBackupOnly);
console.log("配置文件路径:", configPath);

let mainWindow;
let settingsWindow;

function loadRenderer(window, hash = "") {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    window.loadURL(`${devServerUrl}${hash}`);
    return;
  }
  window.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: hash });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    title: "PDC",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("page-title-updated", (e) => e.preventDefault());
  loadRenderer(mainWindow, "#/main-view/backup");
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 680,
    title: "设置",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.on("page-title-updated", (e) => e.preventDefault());
  loadRenderer(settingsWindow, "#/settings/backup-setting");
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

app.whenReady().then(async () => {
  // 获取 exe 文件的路径，用于设置日志目录
  let logsDir;
  try {
    // 打包后 app.getPath("exe") 会返回 exe 文件的路径
    const exePath = app.getPath("exe");
    const exeDir = path.dirname(exePath);
    logsDir = path.join(exeDir, "logs");
  } catch {
    // 开发环境拿不到 exe 路径，退回到仓库内的 logs 目录
    logsDir = path.join(__dirname, "..", "logs");
  }

  const service = createBackupService({
    settingsFile: configPath,
    logsDir: logsDir,
  });

  // 如果是仅备份模式，执行备份后退出
  if (isBackupOnly) {
    console.log("开始备份...");
    try {
      const settings = await service.loadSettings();

      if (!settings.sourceFolders?.length || !settings.backupDestination) {
        throw new Error(`配置文件无效，请检查 ${configPath}`);
      }

      // 检查 sourceFolders 的结构，转换为 selectedSources 格式
      const sources = Array.isArray(settings.sourceFolders)
        ? settings.sourceFolders
            .map((item) => {
              if (typeof item === "string") {
                return {
                  name: path.basename(item),
                  path: item,
                };
              }
              // 确保 name 和 path 属性存在
              if (item && typeof item.path === "string") {
                return {
                  name:
                    typeof item.name === "string" && item.name.trim()
                      ? item.name.trim()
                      : path.basename(item.path),
                  path: item.path.trim(),
                };
              }
              return null;
            })
            .filter(Boolean)
        : [];

      const result = await service.runBackup({ selectedSources: sources });
      // 调试用：输出逐项备份结果，便于在无界面模式下定位失败项
      console.log("备份结果:", JSON.stringify(result, null, 2));

      // 调试用：确认备份日志实际写入了哪个目录，写不进去时会打印失败原因
      try {
        const fs = require("fs");
        const testLogPath = path.join(logsDir, "test-write.log");
        fs.writeFileSync(testLogPath, `测试写入: ${new Date().toISOString()}`);
        fs.unlinkSync(testLogPath);
        console.log(`日志目录可写: ${logsDir}`);
      } catch (error) {
        console.warn(`日志目录写入测试失败: ${error.message}`);
        console.warn("尝试使用备用日志目录...");

        // 尝试使用临时目录作为备用
        const os = require("os");
        const tempLogsDir = path.join(os.tmpdir(), "personal-data-center", "logs");
        console.log(`备用日志目录: ${tempLogsDir}`);
      }

      if (result.failedCount > 0) {
        process.exitCode = 1;
      }

      console.log(`备份完成，日志目录: ${logsDir}`);
    } catch (error) {
      console.error(error.message || error);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
    return;
  }

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

  ipcMain.handle("backup:read-log", async () => service.readBackupLog());

  const template = [
    {
      label: "",
    },
    {
      label: "设置",
      click: () => createSettingsWindow(),
    },
  ];

  ipcMain.handle("save-config", async (event, config) => {
    try {
      await service.saveSettings(config);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
