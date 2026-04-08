# Personal Data Center

`Vue3 + Vite + Electron` 备份客户端，包含：

- 设置页（侧边菜单）：
  - 菜单项：`备份数据`
  - 支持配置多个被备份源路径
  - 支持配置一个备份存放路径
- 主页面（侧边菜单）：
  - 菜单项：`备份数据`
  - 可选择要备份的源路径
  - 同屏查看源目录树和备份目录树
  - 可手动执行备份
- 备份方式：
  - 调用 `rar` 命令执行压缩（需本机安装 WinRAR/rar 并加入 `PATH`）
- 脚本入口：
  - 可通过脚本独立执行备份

## 启动

```bash
npm install
npm run dev
```

## 仅启动 Electron（读取 dist）

```bash
npm run build:web
npm run start
```

## 脚本执行备份

1. 在项目根目录创建 `backup.config.json`：

```json
{
  "sourceFolders": [
    "D:/example/source1",
    "D:/example/source2"
  ],
  "backupDestination": "D:/example/backup-target"
}
```

2. 运行脚本：

```bash
npm run backup
```

也可以指定配置文件路径：

```bash
npm run backup -- --config ./your-config.json
```
