const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createBackupService } = require("./backup-service.cjs");
const { createUpdateService, isGithubReleasePage } = require("./update-service.cjs");

// Electron 自身会向 argv 注入启动器路径、应用目录和调试开关。
// 只跳过这些固定项，不再按 "electron"/".exe" 子串过滤，
// 否则 --config 指向的路径只要含这些字样就会被误删
const ELECTRON_SWITCH_PREFIXES = [
  "--inspect",
  "--remote-debugging",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--enable-logging",
  "--log-file",
  "--user-data-dir",
  "--allow-file-access-from-files",
];

function isElectronSwitch(argument) {
  return ELECTRON_SWITCH_PREFIXES.some(
    (prefix) =>
      argument === prefix || argument.startsWith(`${prefix}=`) || argument.startsWith(`${prefix}-`),
  );
}

function parseCommandLineArgs(argv = process.argv) {
  const appRoot = path.resolve(__dirname, "..");
  const launcherArgs = new Set([".", appRoot, process.execPath]);

  const userArgs = argv.slice(1).filter((argument) => {
    if (launcherArgs.has(argument)) return false;
    return !isElectronSwitch(argument);
  });

  // 调试用：排查参数解析是否把 Electron 自身参数混进了用户参数
  console.log("所有参数:", argv);
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

function isInsideTempDir(targetPath) {
  try {
    const relative = path.relative(app.getPath("temp"), path.resolve(targetPath));
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    // 取不到临时目录时按“不在临时目录”处理
    return false;
  }
}

function ensureWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probePath = path.join(dirPath, `.write-test-${process.pid}`);
    fs.writeFileSync(probePath, "");
    fs.unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

// 日志目录固定在 userData 下：开发环境的 app.getPath("exe") 指向 node_modules/electron/dist，
// portable 版的 exe 目录则是临时解压目录，两者都不适合存放日志
function resolveLogsDir() {
  const candidates = [];
  try {
    candidates.push(path.join(app.getPath("userData"), "logs"));
  } catch {
    // 取不到 userData 时依赖后续候选
  }

  if (!app.isPackaged) {
    // 开发环境回退到仓库内的 logs 目录
    candidates.push(path.join(__dirname, "..", "logs"));
  }

  try {
    // 打包环境的回退目录必须位于临时目录之外，否则 portable 版日志会随解压目录一起消失
    const documentsLogsDir = path.join(app.getPath("documents"), "PersonalDataCenter", "logs");
    if (!isInsideTempDir(documentsLogsDir)) candidates.push(documentsLogsDir);
  } catch {
    // 取不到文档目录时忽略该候选
  }

  for (const candidate of candidates) {
    if (ensureWritableDir(candidate)) return candidate;
  }

  // 所有候选都不可写时退到临时目录，至少让本次备份留下日志
  const tempLogsDir = path.join(app.getPath("temp"), "PersonalDataCenter", "logs");
  ensureWritableDir(tempLogsDir);
  return tempLogsDir;
}

function formatMonthValue(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

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

function createSettingsWindow(hash = "#/settings/backup-setting") {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    loadRenderer(settingsWindow, hash);
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
  loadRenderer(settingsWindow, hash);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// 只有全部归档都通过校验后才写月度成功标记：auto-backup.bat 依据该标记跳过本月，
// 失败时不写，因此失败过的月份会在下次启动时重试
function writeBackupSuccessMarker({ logsDir, result }) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markerPath = path.join(logsDir, `backup-success-${formatMonthValue()}.log`);
    const lines = [
      `备份成功时间: ${new Date().toISOString()}`,
      `备份目录: ${result.destination}`,
      ...result.results.map(
        (item) => `${item.sourceName}\t${item.archivePath || ""}\t${item.archiveSize || 0}`,
      ),
      "",
    ];
    fs.writeFileSync(markerPath, lines.join("\n"), "utf-8");
    console.log(`已写入月度备份成功标记: ${markerPath}`);
  } catch (error) {
    // 标记写失败只影响自动备份的月度判断，不能把已成功的备份改判为失败
    console.error(`写入月度备份成功标记失败: ${error.message}`);
  }
}

app.whenReady().then(async () => {
  const logsDir = resolveLogsDir();

  const service = createBackupService({
    settingsFile: configPath,
    logsDir: logsDir,
    // 打包后把配置副本同步写回 resources；开发环境不写 node_modules 下的资源目录
    secondarySettingsFile: app.isPackaged
      ? path.join(process.resourcesPath, "backup.config.json")
      : null,
  });

  // 如果是仅备份模式，执行备份后退出
  if (isBackupOnly) {
    console.log("开始备份...");
    try {
      const settings = await service.loadSettings();
      const sourceFolders = Array.isArray(settings.sourceFolders) ? settings.sourceFolders : [];

      if (!sourceFolders.length) {
        throw new Error(`配置文件中没有备份源文件夹，请先在设置中添加（配置文件: ${configPath}）`);
      }
      if (!settings.backupDestination) {
        throw new Error(`配置文件未设置备份存放路径，请先在设置中配置（配置文件: ${configPath}）`);
      }

      // 检查 sourceFolders 的结构，转换为 selectedSources 格式
      const sources = sourceFolders
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
        .filter(Boolean);

      const result = await service.runBackup({ selectedSources: sources });
      // 调试用：输出逐项备份结果，便于在无界面模式下定位失败项
      console.log("备份结果:", JSON.stringify(result, null, 2));

      if (result.failedCount > 0) {
        process.exitCode = 1;
        console.error(`备份结束，但有 ${result.failedCount} 项失败，详见日志: ${logsDir}`);
      } else {
        writeBackupSuccessMarker({ logsDir, result });
        console.log(`备份完成，日志目录: ${logsDir}`);
      }
    } catch (error) {
      console.error(error.message || error);
      process.exitCode = 1;
    } finally {
      // app.quit() 内部按 0 退出，会丢掉失败时的退出码，自动备份脚本据此判断成败
      app.exit(process.exitCode || 0);
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

  const updater = createUpdateService({
    userDataDir: app.getPath("userData"),
    appVersion: app.getVersion(),
    emit: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      }
    },
  });

  ipcMain.handle("update:get-version", () => app.getVersion());
  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:last-result", () => updater.lastResult());
  ipcMain.handle("update:install", async () => {
    await updater.install();
    // 让 IPC 先返回成功，界面才能提示「正在安装」，随后退出让安装程序替换文件。
    setTimeout(() => app.exit(0), 400);
  });
  ipcMain.handle("update:open-release-page", async (_, url) => {
    if (!isGithubReleasePage(url)) throw new Error("只允许打开 GitHub 链接");
    await shell.openExternal(url);
  });
  ipcMain.handle("update:get-auto-check", () => updater.getAutoCheck());
  ipcMain.handle("update:set-auto-check", (_, enabled) => updater.setAutoCheck(enabled));

  const template = [
    {
      label: "",
    },
    {
      label: "设置",
      click: () => createSettingsWindow(),
    },
    {
      label: "关于与更新",
      click: () => createSettingsWindow("#/settings/update"),
    },
  ];

  ipcMain.handle("save-config", async (event, config) => {
    try {
      await service.saveSettings(config);
      return { success: true };
    } catch (error) {
      // 主配置成功、副本失败属于部分成功，界面需要按“已保存但未完全同步”提示
      return {
        success: false,
        partial: error.partial === true,
        savedPath: error.savedPath,
        failedPath: error.failedPath,
        error: error.message,
      };
    }
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  createMainWindow();

  // 启动时后台自动检查，仅在新版本时通知窗口并弹出系统通知。
  updater
    .autoCheck()
    .then((info) => {
      if (!info || !info.has_update) return;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("update:check-result", info);
      }
      if (Notification.isSupported()) {
        try {
          new Notification({
            title: "发现新版本",
            body: `PersonalDataCenter v${info.latest_version} 已发布，前往「关于与更新」升级`,
          }).show();
        } catch (error) {
          console.error("更新通知失败:", error.message);
        }
      }
    })
    .catch((error) => console.error("自动检查更新失败:", error.message));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
