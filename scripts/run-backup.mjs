import path from "node:path";
import process from "node:process";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// fileURLToPath 会正确解码，路径含空格或中文时不会出现 %20 之类的转义残留
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const resourcesDir = path.dirname(scriptDir);
const appRootDir = path.dirname(resourcesDir);
// 打包后脚本位于 <应用>/resources/scripts，开发环境则位于仓库的 scripts 目录
const isPackagedLayout = path.basename(resourcesDir) === "resources";

// 输出当前路径信息，用于调试
console.log("当前工作目录:", process.cwd());
console.log("脚本文件路径:", scriptPath);
console.log("可执行文件路径:", process.execPath);

// productName 是 PersonalDataCenter，历史版本用过中文名，保留为兜底
const APP_EXE_NAMES = [
  "PersonalDataCenter.exe",
  "个人数据中心.exe",
  "Personal Data Center.exe",
  "personal-data-center.exe",
];
const APP_EXE_NAME_SET = new Set(APP_EXE_NAMES.map((name) => name.toLowerCase()));

// 开发者应把 PDC_APP_EXE 指向真正的应用可执行文件（portable 版的解压目录不可预测时尤其有用）
const appExeOverride = process.env.PDC_APP_EXE;

// electron-builder 的 userData 目录名来自 Electron 的 app.getName()：
// productName 生效时为 PersonalDataCenter，当前 package.json 的 name 则是 personal-data-center，
// 更早的版本用过中文名。逐个探测，取第一个存在配置文件的目录
const USER_DATA_DIR_NAMES = ["PersonalDataCenter", "personal-data-center", "个人数据中心"];

function getUserDataRootDirs() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return USER_DATA_DIR_NAMES.map((name) => path.join(appData, name));
  }
  if (process.platform === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support");
    return USER_DATA_DIR_NAMES.map((name) => path.join(base, name));
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return USER_DATA_DIR_NAMES.map((name) => path.join(base, name));
}

function findUserDataConfigPath() {
  for (const userDataDir of getUserDataRootDirs()) {
    const configPath = path.join(userDataDir, "backup.config.json");
    if (fs.existsSync(configPath)) return configPath;
  }
  return "";
}

// 开发环境用 electron 自带的 Electron 可执行文件（能加载 Electron 接口），
// node 无法加载 Electron 接口，因此绝不用 node 执行 --backup
function getDevElectronPath() {
  const repoRoot = resourcesDir;
  const candidates = [
    path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe"),
    path.join(
      repoRoot,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    ),
    path.join(repoRoot, "node_modules", "electron", "dist", "electron"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

// 返回 { executable, args }：args 为启动器自身需要的参数（开发环境需把应用目录传给 Electron）
function getAppExecutable() {
  if (appExeOverride && fs.existsSync(appExeOverride)) {
    return { executable: appExeOverride, args: [] };
  }

  // 当前进程本身就是应用时直接复用
  if (APP_EXE_NAME_SET.has(path.basename(process.execPath).toLowerCase())) {
    return { executable: process.execPath, args: [] };
  }

  const searchRoots = [appRootDir];
  // 兼容 win-unpacked 之类“可执行文件与 resources 相邻”的布局
  if (isPackagedLayout) searchRoots.push(path.join(appRootDir, ".."));

  for (const root of searchRoots) {
    for (const exeName of APP_EXE_NAMES) {
      const candidate = path.join(root, exeName);
      if (fs.existsSync(candidate)) {
        console.log(`找到应用程序可执行文件: ${candidate}`);
        return { executable: candidate, args: [] };
      }
    }
  }

  if (!isPackagedLayout) {
    const devElectronPath = getDevElectronPath();
    if (devElectronPath) {
      console.log(`开发环境使用 Electron 可执行文件: ${devElectronPath}`);
      return { executable: devElectronPath, args: [resourcesDir] };
    }
  }

  throw new Error(
    [
      "未找到 PersonalDataCenter 应用程序可执行文件，无法执行备份。",
      `已查找目录: ${searchRoots.join("、")}`,
      "请直接运行安装目录下的 PersonalDataCenter.exe --backup --config <配置文件>，",
      "或设置环境变量 PDC_APP_EXE 指向 PersonalDataCenter.exe。",
      "（node 无法加载 Electron 接口，因此不会退化为 node --backup）",
    ].join("\n"),
  );
}

function parseArgs(argv = process.argv.slice(2)) {
  const configFlagIndex = argv.findIndex((item) => item === "--config" || item === "-c");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    const explicitConfigPath = path.resolve(process.cwd(), argv[configFlagIndex + 1]);
    if (!fs.existsSync(explicitConfigPath)) {
      throw new Error(`指定的配置文件不存在: ${explicitConfigPath}`);
    }
    return explicitConfigPath;
  }

  // 主进程在开发环境和打包环境都把设置写在 Electron 的 userData 目录下，
  // 这里优先跟随同一份文件，避免脚本与界面读到不同配置
  const userDataConfigPath = findUserDataConfigPath();
  if (userDataConfigPath) {
    console.log(`找到 userData 配置文件: ${userDataConfigPath}`);
    return userDataConfigPath;
  }

  const candidatePaths = [
    // 打包后是 resources/backup.config.json，开发环境是仓库根目录的 backup.config.json
    path.join(resourcesDir, "backup.config.json"),
    path.resolve(process.cwd(), "backup.config.json"),
  ];

  // 兼容直接从应用目录或 exe 目录调用脚本的场景
  const exeDir = path.dirname(process.execPath);
  candidatePaths.push(path.join(exeDir, "backup.config.json"));
  candidatePaths.push(path.join(exeDir, "resources", "backup.config.json"));

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  console.warn("未找到配置文件，使用默认路径:", candidatePaths[0]);
  return candidatePaths[0];
}

function main() {
  const { executable, args: launcherArgs } = getAppExecutable();
  const configPath = parseArgs();

  // 构建命令行参数，始终显式指定配置文件，避免主进程自行猜测导致读取到旧配置
  const args = [...launcherArgs, "--backup", "--config", configPath];

  console.log("开始备份...");
  console.log(`执行命令: ${executable} ${args.join(" ")}`);

  // 调用应用程序执行备份；每个参数单独传递，路径含空格也不用拼引号
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    encoding: "utf8",
  });

  if (result.error) {
    console.error("执行备份时出错:", result.error.message);
    process.exitCode = 1;
    return;
  }

  if (result.status !== 0) {
    console.error(`备份执行失败，退出码: ${result.status}`);
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log("备份完成！");
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
