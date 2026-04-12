const fs = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");

const DEFAULT_SETTINGS = {
    sourceFolders: [],
    backupDestination: "",
};

async function ensureDir(dirPath) {
    if (!dirPath) return;
    await fs.mkdir(dirPath, {recursive: true});
}

async function pathExists(targetPath) {
    if (!targetPath) return false;
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function runRarArchive({sourceFolder, destinationFolder, name}) {
    return new Promise((resolve, reject) => {
        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
            now.getDate(),
        ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(
            2,
            "0",
        )}${String(now.getSeconds()).padStart(2, "0")}`;
        const safeName = (name || path.basename(sourceFolder)).replace(/[^\w\u4e00-\u9fa5\-]/g, "_");
        const archivePath = path.join(destinationFolder, `${safeName}_${timestamp}.rar`);

        const args = ["a", "-ep1", archivePath, sourceFolder];
        const child = spawn("rar", args, {shell: true});

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        child.on("error", (error) => {
            reject(new Error(`RAR 执行失败: ${error.message}`));
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve({archivePath, log: stdout.trim()});
                return;
            }
            reject(
                new Error(
                    `RAR 压缩失败，退出码 ${code}。请确认已安装 WinRAR/rar 并将 rar 命令加入 PATH。\n${stderr || stdout}`,
                ),
            );
        });
    });
}

function formatDateTime(value = new Date()) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(
        2,
        "0",
    )} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(
        value.getSeconds(),
    ).padStart(2, "0")}`;
}

function formatDate(value = new Date()) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(
        2,
        "0",
    )}`;
}

function createBackupService({settingsFile, logsDir}) {
    async function loadSettings() {
        const exists = await pathExists(settingsFile);
        if (!exists) return DEFAULT_SETTINGS;
        const raw = await fs.readFile(settingsFile, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            sourceFolders: Array.isArray(parsed.sourceFolders) ? parsed.sourceFolders : [],
            backupDestination: typeof parsed.backupDestination === "string" ? parsed.backupDestination : "",
        };
    }

    async function saveSettings(settings) {
        const normalized = {
            sourceFolders: Array.isArray(settings.sourceFolders)
                ? [...new Map(settings.sourceFolders
                    .map((item) => {
                        if (typeof item === "string" && item.trim()) {
                            return [item.trim(), item.trim()];
                        }
                        if (item && typeof item.path === "string" && item.path.trim()) {
                            return [item.path.trim(), {
                                name: typeof item.name === "string" ? item.name.trim() : path.basename(item.path.trim()),
                                path: item.path.trim()
                            }];
                        }
                        return null;
                    })
                    .filter(Boolean))
                    .values()]
                : [],
            backupDestination: typeof settings.backupDestination === "string" ? settings.backupDestination.trim() : "",
        };
        await ensureDir(path.dirname(settingsFile));
        await fs.writeFile(settingsFile, JSON.stringify(normalized, null, 2), "utf-8");
        return normalized;
    }

    function listSourcePaths(sourceFolders) {
        if (!Array.isArray(sourceFolders)) return [];
        return sourceFolders
            .map((item) => {
                if (typeof item === "string") return item.trim();
                if (item && typeof item.path === "string") return item.path.trim();
                return "";
            })
            .filter(Boolean);
    }

    async function appendBackupLog({startedAt, selectedNames, failedNames, results}) {
        const dir = logsDir || path.join(path.dirname(settingsFile), "logs");
        await ensureDir(dir);
        const logPath = path.join(dir, `backup-${formatDate(startedAt)}.log`);
        const lines = [
            "------------------------------",
            `备份时间: ${formatDateTime(startedAt)}`,
            `备份名称: ${selectedNames.length > 0 ? selectedNames.join(", ") : "无"}`,
            `备份结果: ${failedNames.length > 0 ? `失败(${failedNames.join(", ")})` : "全部成功"}`,
            `详细结果: ${JSON.stringify(results.map((item) => {
                if (item.success) {
                    return `[${item.sourceName} 成功 ${item.archivePath ? item.archivePath.replace(/\\/g, "/") : ""}]`;
                } else {
                    return `[${item.sourceName} 失败 ${item.error || "未知错误"}]`;
                }
            }))}`,
            "",
        ];
        await fs.appendFile(logPath, lines.join("\n"), "utf-8");
    }

    async function runBackup({selectedFolders, selectedSources, backupDestination} = {}) {
        const startedAt = new Date();
        const settings = await loadSettings();
        const dest = typeof backupDestination === "string" && backupDestination.trim() ? backupDestination.trim() : settings.backupDestination;
        if (!dest) throw new Error("未设置备份存放路径");
        // 创建日期命名的子文件夹
        const dateFolder = formatDate(startedAt);
        const backupDir = path.join(dest, dateFolder);
        await ensureDir(backupDir);

        let candidates =
            Array.isArray(selectedSources) && selectedSources.length > 0
                ? selectedSources
                    .map((item) => ({
                        name: typeof item?.name === "string" ? item.name.trim() : "",
                        path: typeof item?.path === "string" ? item.path.trim() : "",
                    }))
                    .filter((item) => item.path)
                : [];
        if (!candidates.length) {
            let fallbackPaths = [];
            if (Array.isArray(selectedFolders) && selectedFolders.length > 0) {
                // 处理selectedFolders，可能是字符串数组或对象数组
                fallbackPaths = selectedFolders.map((p) => {
                    if (typeof p === 'string') {
                        return p.trim();
                    }
                    if (p && typeof p.path === 'string') {
                        return p.path.trim();
                    }
                    return '';
                }).filter(Boolean);
            } else {
                fallbackPaths = listSourcePaths(settings.sourceFolders);
            }
            candidates = fallbackPaths.map((item) => ({name: path.basename(item), path: item}));
        }
        if (!candidates.length) throw new Error("没有可备份的源文件夹");

        const uniqueSources = [...new Map(candidates.map((item) => [item.path, item])).values()];
        const results = [];
        for (const source of uniqueSources) {
            const sourceFolder = source.path;
            const sourceName = source.name || path.basename(sourceFolder);
            const exists = await pathExists(sourceFolder);
            if (!exists) {
                results.push({sourceFolder, sourceName, success: false, error: "源路径不存在"});
                continue;
            }
            try {
                const result = await runRarArchive({
                    sourceFolder,
                    destinationFolder: backupDir,
                    name: sourceName,
                });
                results.push({sourceFolder, sourceName, success: true, archivePath: result.archivePath});
            } catch (error) {
                results.push({sourceFolder, sourceName, success: false, error: error.message});
            }
        }
        const failedNames = results.filter((item) => !item.success).map((item) => item.sourceName);
        const selectedNames = uniqueSources.map((item) => item.name || path.basename(item.path));
        await appendBackupLog({startedAt, selectedNames, failedNames, results});

        return {
            destination: backupDir,
            results,
            successCount: results.filter((item) => item.success).length,
            failedCount: results.filter((item) => !item.success).length,
        };
    }

    async function readBackupLog() {
        const dir = logsDir || path.join(path.dirname(settingsFile), "logs");
        const logPath = path.join(dir, `backup-${formatDate()}.log`);
        try {
            const content = await fs.readFile(logPath, "utf-8");
            return content;
        } catch (error) {
            return "暂无日志文件";
        }
    }

    return {
        loadSettings,
        saveSettings,
        runBackup,
        readBackupLog,
    };
}

module.exports = {
    createBackupService,
};