import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createBackupService } = require("../electron/backup-service.cjs");

function parseArgs() {
  const args = process.argv.slice(2);
  const configFlagIndex = args.findIndex((item) => item === "--config");
  if (configFlagIndex >= 0 && args[configFlagIndex + 1]) {
    return path.resolve(process.cwd(), args[configFlagIndex + 1]);
  }
  return path.resolve(process.cwd(), "backup.config.json");
}

async function main() {
  const configPath = parseArgs();
  const backupService = createBackupService({ 
    settingsFile: configPath,
    logsDir: path.join(path.dirname(configPath), "logs")
  });
  
  const settings = await backupService.loadSettings();

  if (!settings.sourceFolders?.length || !settings.backupDestination) {
    throw new Error(`配置文件无效，请检查 ${configPath}`);
  }

  console.log(`开始备份...`);
  const result = await backupService.runBackup({ selectedFolders: settings.sourceFolders });
  console.log(`备份结果:`, JSON.stringify(result, null, 2));
  
  if (result.failedCount > 0) {
    process.exitCode = 1;
  }

  console.log(`备份完成，日志已写入: ${path.join(path.dirname(configPath), "logs")}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});