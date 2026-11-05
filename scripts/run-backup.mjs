import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// 输出当前路径信息，用于调试
console.log("当前工作目录:", process.cwd());
console.log("脚本文件路径:", import.meta.url);
console.log("可执行文件路径:", process.execPath);
console.log("可执行文件目录:", path.dirname(process.execPath));

// 确定应用程序可执行文件路径
function getAppExecutablePath() {
  // 方法1: 检查是否在打包环境中
  if (process.execPath && process.execPath.endsWith(".exe")) {
    const exeName = path.basename(process.execPath);

    // 如果当前就是应用程序可执行文件，直接返回
    if (exeName.includes("个人数据中心") || exeName.includes("Personal Data Center")) {
      return process.execPath;
    }
  }

  // 方法2: 通过脚本路径查找
  let scriptPath = new URL(import.meta.url).pathname;
  if (process.platform === "win32" && scriptPath.startsWith("/")) {
    scriptPath = scriptPath.substring(1);
  }

  // 打包后脚本位于 resources/scripts 目录
  const scriptDir = path.dirname(scriptPath);
  const resourcesDir = path.join(scriptDir, "..");
  const appDir = path.join(resourcesDir, "..");

  // 尝试找到应用程序可执行文件
  const possibleExePaths = [
    path.join(appDir, "个人数据中心.exe"),
    path.join(appDir, "Personal Data Center.exe"),
    path.join(appDir, "personal-data-center.exe"),
    // 打包后的路径
    path.join(appDir, "win-unpacked", "个人数据中心.exe"),
    path.join(appDir, "..", "个人数据中心.exe"),
  ];

  for (const exePath of possibleExePaths) {
    if (fs.existsSync(exePath)) {
      console.log(`找到应用程序可执行文件: ${exePath}`);
      return exePath;
    }
  }

  // 方法3: 使用当前进程的可执行文件
  if (process.execPath && fs.existsSync(process.execPath)) {
    console.log(`使用当前进程可执行文件: ${process.execPath}`);
    return process.execPath;
  }

  // 最终回退方案
  const defaultExePath = path.join(appDir, "个人数据中心.exe");
  console.log(`未找到应用程序可执行文件，使用默认路径: ${defaultExePath}`);
  return defaultExePath;
}

const appExecutablePath = getAppExecutablePath();

function parseArgs() {
  const args = process.argv.slice(2);
  const configFlagIndex = args.findIndex((item) => item === "--config");
  if (configFlagIndex >= 0 && args[configFlagIndex + 1]) {
    return path.resolve(process.cwd(), args[configFlagIndex + 1]);
  }

  // 尝试不同位置的配置文件
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);

  // 打包环境（脚本位于 resources/scripts）：优先使用 userData 下的配置文件，与主进程保持一致（可写）
  const isPackagedLayout = path.basename(path.dirname(scriptDir)) === "resources";
  if (isPackagedLayout && process.env.APPDATA) {
    const userDataConfigPath = path.join(process.env.APPDATA, "个人数据中心", "backup.config.json");
    if (fs.existsSync(userDataConfigPath)) {
      console.log(`找到 userData 配置文件: ${userDataConfigPath}`);
      return userDataConfigPath;
    }
  }

  // 路径1: 脚本目录的上一级 (打包后路径)
  const configPath1 = path.join(scriptDir, "../backup.config.json");
  // 修复Windows路径问题
  const normalizedConfigPath1 = configPath1.replace(/^\\+/, "");
  if (fs.existsSync(normalizedConfigPath1)) {
    return normalizedConfigPath1;
  }

  // 路径2: 当前工作目录
  const configPath2 = path.resolve(process.cwd(), "backup.config.json");
  if (fs.existsSync(configPath2)) {
    return configPath2;
  }

  // 路径3: 可执行文件目录
  const appDir = path.dirname(process.execPath);
  const configPath3 = path.join(appDir, "backup.config.json");
  if (fs.existsSync(configPath3)) {
    return configPath3;
  }

  // 路径4: 应用程序目录的 resources 目录
  const resourcesConfigPath = path.join(appDir, "resources", "backup.config.json");
  if (fs.existsSync(resourcesConfigPath)) {
    return resourcesConfigPath;
  }

  // 路径5: 开发环境路径
  const devConfigPath = path.join(scriptDir, "../../backup.config.json");
  if (fs.existsSync(devConfigPath)) {
    return devConfigPath;
  }

  // 默认路径
  console.warn("未找到配置文件，使用默认路径:", configPath1);
  return configPath1;
}

function main() {
  const configPath = parseArgs();

  // 构建命令行参数，始终显式指定配置文件，避免主进程自行猜测导致读取到旧配置
  const args = ["--backup", "--config", configPath];

  console.log("开始备份...");
  console.log(`执行命令: ${appExecutablePath} ${args.join(" ")}`);

  // 调用应用程序执行备份
  const result = spawnSync(appExecutablePath, args, {
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
    process.exitCode = result.status;
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
