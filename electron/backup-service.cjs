const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_SETTINGS = {
  sourceFolders: [],
  backupDestination: "",
};

async function ensureDir(dirPath) {
  if (!dirPath) return;
  await fs.mkdir(dirPath, { recursive: true });
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

let cachedDefaultWslDistroName;

function cleanCommandOutput(output) {
  if (!output) return "";
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(String(output));
  const utf8 = buffer.toString("utf8").replace(/\0/g, "").trim();
  if (utf8) return utf8;
  return buffer.toString("utf16le").replace(/\0/g, "").trim();
}

// 把 //wsl$/ 或 //wsl.localhost/ 形式的 UNC 路径改写为反斜杠形式，其余路径仅去掉首尾空白
function normalizeWslUncPath(targetPath) {
  if (typeof targetPath !== "string") return "";
  const trimmed = targetPath.trim();
  if (/^\/\/(wsl\$|wsl\.localhost)\//i.test(trimmed)) {
    return trimmed.replace(/\//g, "\\");
  }
  return trimmed;
}

// 把 /mnt/c/xxx 形式的 WSL 挂载路径转成 C:\xxx，非挂载路径返回空串表示“不适用”
function convertWslMountPath(targetPath) {
  const match = targetPath.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (!match) return "";

  const drive = match[1].toUpperCase();
  const rest = (match[2] || "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

// 判断是否为 Linux 侧的绝对路径（排除 UNC 的 //server 与已被转换的 /c: 形式）
function isLinuxAbsolutePath(targetPath) {
  return /^\/(?!\/)/.test(targetPath) && !/^\/[a-z]:/i.test(targetPath);
}

// 取 wsl -l -q 输出的首个发行版名并缓存；没有 WSL 环境时返回空串
function getDefaultWslDistroName() {
  if (cachedDefaultWslDistroName !== undefined) {
    return cachedDefaultWslDistroName;
  }

  cachedDefaultWslDistroName = "";
  try {
    const result = spawnSync("wsl.exe", ["-l", "-q"], { windowsHide: true });
    if (result.status !== 0) return cachedDefaultWslDistroName;

    const lines = cleanCommandOutput(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.replace(/^\*\s*/, "").trim())
      .filter(Boolean);
    cachedDefaultWslDistroName = lines[0] || "";
  } catch {
    cachedDefaultWslDistroName = "";
  }

  return cachedDefaultWslDistroName;
}

// 借助 wslpath -w 把 Linux 绝对路径转成 Windows 路径；调用失败时返回空串由上层兜底
function convertLinuxPathWithWslpath(targetPath) {
  try {
    const result = spawnSync("wsl.exe", ["wslpath", "-w", targetPath], { windowsHide: true });
    if (result.status !== 0) return "";

    const converted = cleanCommandOutput(result.stdout).split(/\r?\n/)[0]?.trim();
    return converted ? normalizeWslUncPath(converted) : "";
  } catch {
    return "";
  }
}

// 把用户填写的路径解析成 Windows 侧可访问的路径：/mnt 挂载直转盘符，纯 Linux 路径依次尝试
// wslpath 与 \\wsl.localhost\<distro> 前缀，都不适用时原样返回
function resolveFileSystemPath(targetPath) {
  const normalizedPath = normalizeWslUncPath(targetPath);
  const mountedWindowsPath = convertWslMountPath(normalizedPath);
  if (mountedWindowsPath) return mountedWindowsPath;

  if (isLinuxAbsolutePath(normalizedPath)) {
    const convertedByWsl = convertLinuxPathWithWslpath(normalizedPath);
    if (convertedByWsl) return convertedByWsl;

    const distroName = getDefaultWslDistroName();
    if (distroName) {
      return `\\\\wsl.localhost\\${distroName}${normalizedPath.replace(/\//g, "\\")}`;
    }
  }

  return normalizedPath;
}

// 判断源路径是否落在 WSL 内：是则返回 { distroName, linuxPath, windowsPath }，否则返回 null。
// 只有走 WSL 内 tar 的场景需要这套信息，Windows 路径走 rar 分支
function resolveWslSource(targetPath) {
  const normalizedPath = normalizeWslUncPath(targetPath);
  const uncMatch = normalizedPath.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i);
  if (uncMatch) {
    return {
      distroName: uncMatch[1],
      linuxPath: `/${(uncMatch[2] || "").replace(/\\/g, "/")}`.replace(/\/$/, "") || "/",
      windowsPath: normalizedPath,
    };
  }

  if (isLinuxAbsolutePath(normalizedPath) && !convertWslMountPath(normalizedPath)) {
    const distroName = getDefaultWslDistroName();
    if (!distroName) return null;
    return {
      distroName,
      linuxPath: normalizedPath,
      windowsPath: resolveFileSystemPath(normalizedPath),
    };
  }

  return null;
}

// 在指定发行版内用 test -e 探测 Linux 路径是否存在（Windows 侧 stat 看不到 WSL 内部路径）
function wslPathExists({ distroName, linuxPath }) {
  const result = spawnSync(
    "wsl.exe",
    ["-d", distroName, "-u", "root", "--", "test", "-e", linuxPath],
    { windowsHide: true },
  );
  return result.status === 0;
}

function getPathBaseName(targetPath) {
  const normalizedPath = normalizeWslUncPath(targetPath);
  return path.basename(normalizedPath) || path.posix.basename(normalizedPath) || normalizedPath;
}

function formatArchiveStamp(value) {
  const pad = (input, length = 2) => String(input).padStart(length, "0");
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}_${pad(
    value.getHours(),
  )}${pad(value.getMinutes())}${pad(value.getSeconds())}${pad(value.getMilliseconds(), 3)}`;
}

// 压缩包名带毫秒时间戳，并在写入前确认目标文件不存在，避免同一秒内同名覆盖；
// 万一仍然重名则追加递增序号，不再直接覆盖已有归档
async function createArchiveName({ sourceFolder, destinationFolder, name, extension }) {
  const stamp = formatArchiveStamp(new Date());
  const safeName =
    (name || getPathBaseName(sourceFolder) || "").replace(/[^\w\u4e00-\u9fa5-]/g, "_") || "backup";

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const counterSuffix = attempt === 0 ? "" : `_${attempt}`;
    const archivePath = path.join(
      destinationFolder,
      `${safeName}_${stamp}${counterSuffix}.${extension}`,
    );
    if (!(await pathExists(archivePath))) return archivePath;
  }

  throw new Error(`无法生成唯一的压缩包名称: ${safeName}_${stamp}.${extension}`);
}

// 归档写完后校验文件真实存在且非空，避免把“进程成功退出但没有任何产物”当成成功
async function verifyArchiveFile(archivePath) {
  try {
    const stats = await fs.stat(archivePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// 所有外部压缩工具都通过 argv 数组调用且不经过 shell：路径里的空格、& 等字符不会被解释。
// 用 spawn 而不是 execFile，避免大型目录的输出撞上 maxBuffer 上限把进程杀掉
function runExternalCommand(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let settled = false;

    child.stdout.on("data", (data) => {
      stdout = appendLimitedOutput(stdout, data);
    });
    child.stderr.on("data", (data) => {
      stderr = appendLimitedOutput(stderr, data);
    });

    child.on("error", (error) => {
      spawnError = error;
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, stdout, stderr, error });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, stdout, stderr, error: spawnError });
    });
  });
}

// tar 在归档过程中会因文件被并发读写、跳过 socket 等给出非致命警告；这些情况下 tar 退出码为 1
// 但归档仍然可用，因此把全部 stderr 行都归入白名单时按成功处理（兼容中英文 tar 输出）
function isNonFatalTarWarning(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.includes("file changed as we read it") ||
        line.includes("socket ignored") ||
        line.includes("Removing leading") ||
        line.includes("忽略 socket") ||
        line.includes("文件在我们读入时发生了变化"),
    )
  );
}

function appendLimitedOutput(current, chunk, maxLength = 65536) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
  const combined = current + text;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

async function runRarArchive({ sourceFolder, destinationFolder, name }) {
  const archivePath = await createArchiveName({
    sourceFolder,
    destinationFolder,
    name,
    extension: "rar",
  });

  // 每个路径都是单独的 argv 元素：不经 shell，含空格或 & 的路径安全
  const args = ["a", "-ep1", "-x*\\node_modules\\*", archivePath, sourceFolder];
  const { exitCode, stdout, stderr, error } = await runExternalCommand("rar", args);

  if (error) {
    const reason =
      error.code === "ENOENT"
        ? "未找到 rar 命令，请确认已安装 WinRAR 并将 rar 加入 PATH"
        : error.message;
    throw new Error(`RAR 执行失败: ${reason}`);
  }

  // rar 退出码 1 表示压缩完成但存在警告（例如个别文件被占用），归档依然可用
  if (exitCode === 0 || exitCode === 1) {
    if (exitCode === 1) {
      console.warn(`RAR 返回警告（退出码 1），归档继续: ${stderr.trim() || "无详细信息"}`);
    }
    return { archivePath, log: `${stdout}\n${stderr}`.trim() };
  }

  // 失败时清理半成品，避免下次同名判断和人工排查被残留文件干扰
  await fs.rm(archivePath, { force: true }).catch(() => {});
  throw new Error(
    `RAR 压缩失败，退出码 ${exitCode}。请确认已安装 WinRAR/rar 并将 rar 命令加入 PATH。\n${stderr || stdout}`,
  );
}

async function runWslTarArchive({ sourceFolder, destinationFolder, name, wslSource }) {
  const archivePath = await createArchiveName({
    sourceFolder,
    destinationFolder,
    name,
    extension: "tar.gz",
  });
  const archiveWriteStream = fsSync.createWriteStream(archivePath);

  return new Promise((resolve, reject) => {
    const sourceParent = path.posix.dirname(wslSource.linuxPath);
    const sourceBase = path.posix.basename(wslSource.linuxPath);
    const args = [
      "-d",
      wslSource.distroName,
      "-u",
      "root",
      "--",
      "tar",
      "--ignore-failed-read",
      "--warning=no-file-changed",
      "--exclude=*/node_modules",
      "--exclude=node_modules",
      "--exclude=*.socket",
      "-czf",
      "-",
      "-C",
      sourceParent,
      sourceBase,
    ];
    const child = spawn("wsl.exe", args, { windowsHide: true });

    let stderr = "";
    let settled = false;

    child.stdout.pipe(archiveWriteStream);
    child.stderr.on("data", (data) => {
      stderr = appendLimitedOutput(stderr, data);
    });

    archiveWriteStream.on("error", (error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`写入 WSL 备份文件失败: ${error.message}`));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      archiveWriteStream.destroy();
      reject(new Error(`WSL tar 执行失败: ${error.message}`));
    });

    child.on("close", (code) => {
      archiveWriteStream.end(() => {
        if (settled) return;
        settled = true;
        if (code === 0 || (code === 1 && isNonFatalTarWarning(stderr))) {
          resolve({ archivePath, log: stderr.trim() });
          return;
        }
        fsSync.rm(archivePath, { force: true }, () => {});
        reject(new Error(`WSL tar 压缩失败，退出码 ${code}。\n${stderr}`));
      });
    });
  });
}

function formatDateTime(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(
    2,
    "0",
  )} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(
    value.getSeconds(),
  ).padStart(2, "0")}`;
}

function formatDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
}

const BACKUP_LOCK_DIR_NAME = ".pdc-backup.lock";
// 等锁上限 15 分钟：正常备份远小于该值，超时说明确实有另一个任务在跑
const BACKUP_LOCK_WAIT_MS = 15 * 60 * 1000;
const BACKUP_LOCK_POLL_MS = 500;
// 持有者进程已不存在时仍需等一小段时间，避免误删刚创建但还没写入归属信息的锁
const BACKUP_LOCK_OWNER_GRACE_MS = 5000;
const BACKUP_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但当前用户无权发信号
    return error.code === "EPERM";
  }
}

async function isBackupLockStale(lockDir) {
  let stats;
  try {
    stats = await fs.stat(lockDir);
  } catch {
    return true;
  }

  const age = Date.now() - stats.mtimeMs;
  if (age > BACKUP_LOCK_STALE_MS) return true;

  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8"));
    if (age > BACKUP_LOCK_OWNER_GRACE_MS && !isProcessRunning(Number(owner.pid))) return true;
  } catch {
    // 归属信息还没写完时不判断，交给等待超时兜底
  }
  return false;
}

// 备份互斥锁：用 mkdir 的原子性实现跨进程互斥，
// 界面里的手动备份与计划任务拉起的 --backup 进程（或同名压缩包）不会同时写同一个目标目录
async function acquireBackupLock(destinationFolder) {
  const lockDir = path.join(destinationFolder, BACKUP_LOCK_DIR_NAME);
  const deadline = Date.now() + BACKUP_LOCK_WAIT_MS;

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        "utf-8",
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        await ensureDir(destinationFolder);
        continue;
      }
      if (error.code !== "EEXIST") {
        // 目标目录不可写（如只读共享盘）时退化为不加锁，不能因此让备份整体失败
        console.warn(`无法创建备份互斥锁 ${lockDir}: ${error.message}，本次不做跨进程互斥`);
        return async () => {};
      }
    }

    if (await isBackupLockStale(lockDir)) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`另一个备份任务正在运行（互斥锁: ${lockDir}），请等待其结束后重试`);
    }
    await delay(BACKUP_LOCK_POLL_MS);
  }
}

function createBackupService({ settingsFile, logsDir, secondarySettingsFile }) {
  // 解析可写的日志目录：优先用主进程传入的 logsDir（已固定在 userData 下），
  // 其次设置文件旁的 logs，都不行时回落到用户文档目录，保证备份日志不会因为目录只读而丢
  function resolveLogsDir() {
    if (logsDir) {
      return logsDir;
    }

    // 用同步 fs 探测设置文件旁的 logs 目录是否可写
    const localLogsDir = path.join(path.dirname(settingsFile), "logs");
    try {
      fsSync.mkdirSync(localLogsDir, { recursive: true });
      const testFile = path.join(localLogsDir, ".write-test");
      fsSync.writeFileSync(testFile, "");
      fsSync.unlinkSync(testFile);
      return localLogsDir;
    } catch {
      // 目录不存在或没有写权限时，改用用户文档目录
      return path.join(os.homedir(), "Documents", "personal-data-center", "logs");
    }
  }

  const safeLogsDir = resolveLogsDir();
  async function loadSettings() {
    // 检查配置文件是否存在
    const exists = await pathExists(settingsFile);
    if (!exists) {
      console.log(`配置文件不存在: ${settingsFile}`);
      return DEFAULT_SETTINGS;
    }

    try {
      const raw = await fs.readFile(settingsFile, "utf-8");
      const parsed = JSON.parse(raw);

      console.log(`成功加载配置文件: ${settingsFile}`);
      console.log(
        `源文件夹数量: ${Array.isArray(parsed.sourceFolders) ? parsed.sourceFolders.length : 0}`,
      );
      console.log(`备份目标: ${parsed.backupDestination || "未设置"}`);

      return {
        sourceFolders: Array.isArray(parsed.sourceFolders) ? parsed.sourceFolders : [],
        backupDestination:
          typeof parsed.backupDestination === "string" ? parsed.backupDestination : "",
      };
    } catch (error) {
      console.error(`配置文件读取失败: ${error.message}`);
      return DEFAULT_SETTINGS;
    }
  }

  async function saveSettings(settings) {
    const normalized = {
      sourceFolders: Array.isArray(settings.sourceFolders)
        ? [
            ...new Map(
              settings.sourceFolders
                .map((item) => {
                  if (typeof item === "string" && item.trim()) {
                    return [item.trim(), item.trim()];
                  }
                  if (item && typeof item.path === "string" && item.path.trim()) {
                    return [
                      item.path.trim(),
                      {
                        name:
                          typeof item.name === "string"
                            ? item.name.trim()
                            : getPathBaseName(item.path.trim()),
                        path: item.path.trim(),
                      },
                    ];
                  }
                  return null;
                })
                .filter(Boolean),
            ).values(),
          ]
        : [],
      backupDestination:
        typeof settings.backupDestination === "string" ? settings.backupDestination.trim() : "",
    };

    // settingsFile 是主进程/自动备份脚本实际读取的那份（打包后在 userData 下），它是权威存储：
    // 只有它写入成功才算保存成功；副本写入失败属于“部分失败”，要如实告知界面而不是提示已保存
    const payload = JSON.stringify(normalized, null, 2);
    const writeConfigFile = async (configPath) => {
      await ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, payload, "utf-8");
    };

    try {
      await writeConfigFile(settingsFile);
      console.log(`配置文件已保存: ${settingsFile}`);
    } catch (error) {
      throw new Error(`配置文件保存失败 (${settingsFile}): ${error.message}`, { cause: error });
    }

    if (secondarySettingsFile && secondarySettingsFile !== settingsFile) {
      try {
        await writeConfigFile(secondarySettingsFile);
        console.log(`配置文件副本已保存: ${secondarySettingsFile}`);
      } catch (error) {
        const partialError = new Error(
          `设置已写入主配置 (${settingsFile})，但同步副本写入失败 (${secondarySettingsFile}): ${error.message}`,
        );
        partialError.partial = true;
        partialError.savedPath = settingsFile;
        partialError.failedPath = secondarySettingsFile;
        throw partialError;
      }
    }

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

  async function appendBackupLog({ startedAt, selectedNames, failedNames, results }) {
    const dir = safeLogsDir;
    await ensureDir(dir);
    const logPath = path.join(dir, `backup-${formatDate(startedAt)}.log`);
    const lines = [
      "------------------------------",
      `备份时间: ${formatDateTime(startedAt)}`,
      `备份名称: ${selectedNames.length > 0 ? selectedNames.join(", ") : "无"}`,
      `备份结果: ${failedNames.length > 0 ? `失败(${failedNames.join(", ")})` : "全部成功"}`,
      `详细结果: ${JSON.stringify(
        results.map((item) => {
          if (item.success) {
            return `[${item.sourceName} 成功 ${item.archivePath ? item.archivePath.replace(/\\/g, "/") : ""}]`;
          } else {
            return `[${item.sourceName} 失败 ${item.error || "未知错误"}]`;
          }
        }),
      )}`,
      "",
    ];
    await fs.appendFile(logPath, lines.join("\n"), "utf-8");
  }

  async function runBackup({ selectedFolders, selectedSources, backupDestination } = {}) {
    const startedAt = new Date();
    const settings = await loadSettings();
    const dest =
      typeof backupDestination === "string" && backupDestination.trim()
        ? backupDestination.trim()
        : settings.backupDestination;
    if (!dest) throw new Error("未设置备份存放路径");
    await ensureDir(dest);

    // 手动备份与计划任务备份共用一个互斥锁：避免两路同时写同一个目标目录，
    // 造成 tar.gz 被截断、rar 被合并或同名归档互相覆盖
    const releaseBackupLock = await acquireBackupLock(dest);

    try {
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
        let fallbackPaths;
        if (Array.isArray(selectedFolders) && selectedFolders.length > 0) {
          // selectedFolders 可能是字符串数组或对象数组
          fallbackPaths = selectedFolders
            .map((p) => {
              if (typeof p === "string") {
                return p.trim();
              }
              if (p && typeof p.path === "string") {
                return p.path.trim();
              }
              return "";
            })
            .filter(Boolean);
        } else {
          fallbackPaths = listSourcePaths(settings.sourceFolders);
        }
        candidates = fallbackPaths.map((item) => ({ name: getPathBaseName(item), path: item }));
      }
      if (!candidates.length) throw new Error("没有可备份的源文件夹");

      const uniqueSources = [...new Map(candidates.map((item) => [item.path, item])).values()];

      // 归档名由“名称 + 时间戳”组成，名称重复会写出难以区分的文件，因此先校验后归档
      const namesByKey = new Map();
      for (const source of uniqueSources) {
        const sourceName = source.name || getPathBaseName(source.path);
        const key = sourceName.trim().toLowerCase();
        namesByKey.set(key, (namesByKey.get(key) || 0) + 1);
      }

      const results = [];
      for (const source of uniqueSources) {
        const sourceFolder = source.path;
        const sourceName = source.name || getPathBaseName(sourceFolder);
        const wslSource = resolveWslSource(sourceFolder);
        const resolvedSourceFolder = resolveFileSystemPath(sourceFolder);

        if ((namesByKey.get(sourceName.trim().toLowerCase()) || 0) > 1) {
          results.push({
            sourceFolder,
            resolvedSourceFolder,
            sourceName,
            success: false,
            error: `备份名称重复（${sourceName}），请为每个源路径设置不同的备份名称`,
          });
          continue;
        }

        const exists = wslSource
          ? wslPathExists(wslSource)
          : await pathExists(resolvedSourceFolder);
        if (!exists) {
          results.push({
            sourceFolder,
            resolvedSourceFolder,
            sourceName,
            success: false,
            error: `源路径不存在: ${resolvedSourceFolder}`,
          });
          continue;
        }

        try {
          const result = wslSource
            ? await runWslTarArchive({
                sourceFolder,
                destinationFolder: backupDir,
                name: sourceName,
                wslSource,
              })
            : await runRarArchive({
                sourceFolder: resolvedSourceFolder,
                destinationFolder: backupDir,
                name: sourceName,
              });

          // 进程成功退出不代表产物可用，再做一次存在性与大小校验
          if (!(await verifyArchiveFile(result.archivePath))) {
            await fs.rm(result.archivePath, { force: true }).catch(() => {});
            results.push({
              sourceFolder,
              resolvedSourceFolder,
              sourceName,
              success: false,
              error: `备份文件校验失败（文件不存在或为空）: ${result.archivePath}`,
            });
            continue;
          }

          const archiveStats = await fs.stat(result.archivePath);
          results.push({
            sourceFolder,
            resolvedSourceFolder,
            sourceName,
            success: true,
            archivePath: result.archivePath,
            archiveSize: archiveStats.size,
          });
        } catch (error) {
          results.push({
            sourceFolder,
            resolvedSourceFolder,
            sourceName,
            success: false,
            error: error.message,
          });
        }
      }

      const failedNames = results.filter((item) => !item.success).map((item) => item.sourceName);
      const selectedNames = uniqueSources.map((item) => item.name || getPathBaseName(item.path));
      try {
        await appendBackupLog({ startedAt, selectedNames, failedNames, results });
      } catch (error) {
        // 日志写不进去不能把已经完成的备份判为失败，只在 stderr 报告
        console.error(`备份日志写入失败 (${safeLogsDir}): ${error.message}`);
      }

      return {
        destination: backupDir,
        results,
        successCount: results.filter((item) => item.success).length,
        failedCount: results.filter((item) => !item.success).length,
      };
    } finally {
      await releaseBackupLock();
    }
  }

  async function readBackupLog() {
    const dir = safeLogsDir;
    const logPath = path.join(dir, `backup-${formatDate()}.log`);
    try {
      const content = await fs.readFile(logPath, "utf-8");
      return content;
    } catch {
      // 当天还没有日志文件属于正常情况，返回提示文案而不是抛错
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
