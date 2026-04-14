const {app, BrowserWindow, Menu, dialog, ipcMain, shell} = require("electron");
const path = require("node:path");
const {createBackupService} = require("./backup-service.cjs");

// 解析命令行参数
// 在打包环境中，Electron 会添加额外参数，需要过滤掉
function parseCommandLineArgs() {
    const allArgs = process.argv.slice(1); // 从第一个参数开始（跳过electron路径）
    
    // 过滤掉Electron相关的参数
    const userArgs = allArgs.filter(arg => {
        return !arg.includes('electron') && 
               !arg.includes('.exe') && 
               !arg.includes('app.asar') &&
               arg !== '.' &&
               !arg.startsWith('--inspect') &&
               !arg.startsWith('--remote-debugging');
    });
    
    console.log('所有参数:', process.argv);
    console.log('过滤后参数:', userArgs);
    
    return userArgs;
}

// 获取正确的配置文件路径
function getConfigPath(userArgs) {
    const configFlagIndex = userArgs.findIndex((item) => item === "--config" || item === "-c");
    
    // 如果用户指定了配置文件路径
    if (configFlagIndex >= 0 && userArgs[configFlagIndex + 1]) {
        return userArgs[configFlagIndex + 1];
    }
    
    // 打包环境：配置文件在 resources 目录下
    if (process.execPath && process.execPath.endsWith('.exe')) {
        const exeDir = path.dirname(process.execPath);
        const resourcesDir = path.join(exeDir, 'resources');
        const resourcesConfigPath = path.join(resourcesDir, 'backup.config.json');
        
        console.log('检查打包环境配置文件:', resourcesConfigPath);
        
        // 检查resources目录下的配置文件
        try {
            const fs = require('fs');
            if (fs.existsSync(resourcesConfigPath)) {
                console.log('找到打包环境配置文件');
                return resourcesConfigPath;
            }
        } catch (error) {
            console.log('打包环境配置文件检查失败:', error.message);
        }
        
        // 回退到app.asar内的配置文件（开发环境）
        const asarConfigPath = path.join(resourcesDir, 'app.asar', 'backup.config.json');
        console.log('回退到asar内配置文件:', asarConfigPath);
        return asarConfigPath;
    }
    
    // 开发环境
    const devConfigPath = path.join(__dirname, "..", "backup.config.json");
    console.log('使用开发环境配置文件:', devConfigPath);
    return devConfigPath;
}

const args = parseCommandLineArgs();
const isBackupOnly = args.includes("--backup") || args.includes("-b");
const configPath = getConfigPath(args);

console.log('备份模式:', isBackupOnly);
console.log('配置文件路径:', configPath);

let mainWindow;
let settingsWindow;

function loadRenderer(window, hash = "") {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
        window.loadURL(`${devServerUrl}${hash}`);
        return;
    }
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"), {hash: hash});
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 760,
        title: "个人数据中心",
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWindow.on('page-title-updated', (e) => e.preventDefault());
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
    settingsWindow.on('page-title-updated', (e) => e.preventDefault());
    loadRenderer(settingsWindow, "#/settings/backup-setting");
    settingsWindow.on("closed", () => {
        settingsWindow = null;
    });
}

app.whenReady().then(async () => {
    // 获取exe文件的路径，用于设置日志目录
    let logsDir;
    try {
        // 在打包后，app.getPath('exe')会返回exe文件的路径
        const exePath = app.getPath('exe');
        const exeDir = path.dirname(exePath);
        logsDir = path.join(exeDir, "logs");
    } catch (error) {
        // 在开发环境中，使用原来的路径
        logsDir = path.join(__dirname, "..", "logs");
    }
    
    const service = createBackupService({ 
        settingsFile: configPath,
        logsDir: logsDir,
    });
    
    // 如果是仅备份模式，执行备份后退出
    if (isBackupOnly) {
        console.log(`开始备份...`);
        try {
            const settings = await service.loadSettings();
            
            if (!settings.sourceFolders?.length || !settings.backupDestination) {
                throw new Error(`配置文件无效，请检查 ${configPath}`);
            }
            
            // 检查sourceFolders的结构，转换为selectedSources格式
            const sources = Array.isArray(settings.sourceFolders) ? settings.sourceFolders.map(item => {
                if (typeof item === 'string') {
                    return {
                        name: path.basename(item),
                        path: item
                    };
                }
                // 确保name和path属性存在
                if (item && typeof item.path === 'string') {
                    return {
                        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : path.basename(item.path),
                        path: item.path.trim()
                    };
                }
                return null;
            }).filter(Boolean) : [];
            
            const result = await service.runBackup({ selectedSources: sources });
            console.log(`备份结果:`, JSON.stringify(result, null, 2));
            
            // 检查日志目录是否存在并可以写入
            try {
                const fs = require('fs');
                const testLogPath = path.join(logsDir, 'test-write.log');
                fs.writeFileSync(testLogPath, `测试写入: ${new Date().toISOString()}`);
                fs.unlinkSync(testLogPath);
                console.log(`日志目录可写: ${logsDir}`);
            } catch (error) {
                console.warn(`日志目录写入测试失败: ${error.message}`);
                console.warn(`尝试使用备用日志目录...`);
                
                // 尝试使用临时目录作为备用
                const os = require('os');
                const tempLogsDir = path.join(os.tmpdir(), 'personal-data-center', 'logs');
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
            label: ''
        },
        {
            label: '设置',
            click: () => createSettingsWindow(),
        }
    ]

    ipcMain.handle('save-config', async (event, config) => {
        try {
            await service.saveSettings(config);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    
    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu);
    createMainWindow();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});