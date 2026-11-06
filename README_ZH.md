<div align="center">

<img src="docs/logo.png" width="120" alt="Personal Data Center logo">

# 个人数据中心

### 一个只产出「带时间戳的普通压缩包」的目录备份客户端 —— 不做镜像同步，不用私有格式

**勾选要备份的目录，点一次按钮：每个目录都会变成按时点命名的 `.rar`（Windows 路径）或 `.tar.gz`（WSL 路径），放在以日期命名的子目录里。**

[![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF.svg)](https://vite.dev/)
[![Electron](https://img.shields.io/badge/Electron-41-47848F.svg)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/node-%5E20.19%20%7C%7C%20%3E%3D22.12-informational.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#许可)

[English](README.md) | 中文

**[快速开始](#快速开始) · [功能](#功能) · [无界面与定时备份](#无界面与定时备份) · [常见问题](#常见问题)**

</div>

## 为什么做这个？

实时同步工具会在几秒内把每一次误删、误改原样复制过去，而在线备份服务通常把目录存成它自己的格式。这个客户端只做最朴素、最可逆的事：读取一次目录，写出一个文件名里带时间点的压缩包。源目录从不被修改，拿到的是任何装了 WinRAR 或 `tar` 的机器都能直接打开的文件 —— 即使没有这个应用。

- **两个窗口，各管一件事** —— 主窗口勾选源并执行备份、同屏看日志；设置窗口管理源列表和存放路径
- **Windows 路径与 WSL 路径放在同一份列表里** —— Windows 路径走 WinRAR 的 `rar`；发行版内部的路径走 `wsl.exe tar`，因此 Linux 文件按 Linux 速度打包，而不是经过 9p 挂载慢慢爬
- **永不备份 `node_modules`** —— 两种压缩方式都排除它，一个前端项目不会突然变成 2 GB 的包
- **失败按源逐项报告** —— 一个目录出错不影响其余目录继续；结果列表和退出码会指出是哪个失败
- **给任务计划程序用的无界面模式** —— `--backup` 执行一次备份，只要有失败就以退出码 1 结束
- **每月的守门脚本** —— `scripts/auto-backup.bat` 只在本月存在成功标记（`logs/backup-success-<yyyy-MM>.log`）时跳过；标记由主程序在全部压缩包校验通过后写入，因此备份失败过的月份下次仍会重试
- **一天一个日志文件** —— 写在应用的 userData `logs/` 目录下，并在主窗口里直接显示

## 环境要求

- **Node.js**：`^20.19.0 || >=22.12.0`（Vite 8 的要求）
- **WinRAR**：`rar` 命令需在 `PATH` 中 —— 所有 Windows 源目录都要用它
- **WSL**：仅当要备份 Linux 发行版内部的目录时需要

## 快速开始

```bash
npm install
npm run dev
```

`npm run dev` 会先在 5173 端口启动 Vite，随后拉起指向它的 Electron。

改为读取已构建的前端、而不是开发服务器：

```bash
npm run build:web
npm run start
```

## 使用流程

1. **配置** —— 打开设置窗口（菜单栏 →「设置」），逐个添加源目录（名称 + 路径），选定唯一的存放路径，点击「保存」。新加的源默认用目录最后一级名称作名字；手动改成别的名字后，再换目录也不会被覆盖。
2. **备份** —— 在主窗口勾选要备份的源，点击「手动执行备份」。结果出现在右侧日志面板，「打开备份路径」可直接在资源管理器中打开存放目录。
3. **看日志** —— 「备份日志」显示当天的日志：时间、本次选中的名称、以及每个源的成功或失败原因。

压缩包落在 `<存放路径>/<yyyy-MM-dd>/<名称>_<yyyyMMdd_HHmmssSSS>.rar`（WSL 源为 `.tar.gz`）。时间戳带毫秒，并在重名时追加序号，两次备份不会互相覆盖；目标目录上的互斥锁让手动备份与计划任务备份串行执行。

## 配置存储

设置同时存在两处。配置文件是权威存储：只有它写入成功才算保存成功；完全写不进去时会回滚 IndexedDB，`resources` 里的副本写入失败则按「部分保存」提示，而不会谎报「已保存」：

- **IndexedDB**（`personal-data-center` → `appSettings`，单条记录，id 为 `singleton`）—— 两个窗口读写的就是它
- **`backup.config.json`** —— 无界面模式和各脚本读的是它

文件结构如下：

```json
{
  "sourceFolders": [
    { "name": "source1", "path": "D:/example/source1" },
    { "name": "source2", "path": "\\\\wsl$\\Ubuntu\\home\\me\\proj" }
  ],
  "backupDestination": "D:/example/backup-target"
}
```

`sourceFolders` 也可以直接是字符串数组，此时名称由路径推导。打包后应用把可写副本放在 Electron 的 userData 目录（旧版本是 `%APPDATA%\个人数据中心\backup.config.json`，当前是 `%APPDATA%\personal-data-center\backup.config.json`），首次运行从 `resources\backup.config.json` 播种 —— `Program Files` 不可写，直接保存在那里会失败。`run-backup.mjs` 在没有显式 `--config` 时会探测同样的 userData 目录名。

## 无界面与定时备份

`npm run backup` 调用 `scripts/run-backup.mjs`：它先定位应用可执行文件，再以 `--backup --config <路径>` 启动它。

```bash
npm run backup
npm run backup -- --config ./your-config.json
```

若要每月执行一次，把任务计划程序指向 `scripts/auto-backup.bat`；它只在本月存在成功标记（`backup-success-<yyyy-MM>.log`）时跳过。按天写的日志（失败时也会写）不再被当成成功依据。

## 支持的源路径

| 源路径                        | 压缩方式                                 | 产物      |
| ----------------------------- | ---------------------------------------- | --------- |
| `D:\work\project`             | `rar a -ep1 -x*\node_modules\*`          | `.rar`    |
| `\\wsl$\Ubuntu\home\me\proj`  | `wsl.exe -d Ubuntu tar -czf -`           | `.tar.gz` |
| `/home/me/proj`（默认发行版） | 先用 `wslpath -w` 解析，再 `wsl.exe tar` | `.tar.gz` |
| `/mnt/d/work`                 | 转换成 `D:\work`，再用 `rar`             | `.rar`    |

WSL 路径靠 UNC 形式（`\\wsl$\…`、`\\wsl.localhost\…`）或「Linux 绝对路径」这一特征识别。Windows 无法 `stat` 发行版内部的路径，所以存在性用 `wsl.exe test -e` 判断；若 `tar` 以退出码 1 结束，但 stderr 每一行都是已知非致命警告（`file changed as we read it`、`socket ignored` 等），归档仍视为有效。

## 功能

### 备份客户端

- **手动执行** —— 勾选后一键备份，逐个源显示压缩包路径或错误原因
- **完整日志** —— 每次运行的时间、选中的名称、逐源结果，追加写入 `<userData>/logs/backup-yyyy-MM-dd.log`
- **路径快捷入口** —— 每个源和存放路径都有「打开路径」按钮，直接在资源管理器里定位
- **两种引擎** —— Windows 路径用 WinRAR 的 `rar`，WSL 内路径用 `wsl.exe tar`，按源自动选择

### 设置

- **多源** —— 每条包含名称与路径，保存时按路径去重
- **单一存放路径** —— 包按日期分子目录归拢到它下面
- **名称只在没被改过时跟随目录** —— 重新选目录时，仅当名称仍是自动推导值时同步更新；手填的名称不会被覆盖
- **窗口间实时同步** —— 设置保存后主窗口通过广播通道立即重新加载

### 打包

- **electron-builder** —— Windows 出 `nsis` + `portable`，macOS 出 `dmg` + `zip`，Linux 出 `AppImage` + `deb` + `rpm`，产物在 `dist-electron/`
- **脚本随包分发** —— `scripts/` 与 `backup.config.json` 作为额外资源打进安装包，装机后定时备份仍可用

## 常见问题

<details>
<summary><strong>为什么依赖 WinRAR，而不是用 Node 的压缩库？</strong></summary>

在这种场景下，WinRAR 压缩大目录比纯 JS 实现快得多，而且目标机器上通常已经装了。找不到 `rar` 时本次运行以退出码 1 结束，并明确提示需要安装并加入 `PATH`。

</details>

<details>
<summary><strong>备份日志写到哪里？</strong></summary>

Electron 的 userData 目录（Windows 上是 `%APPDATA%\personal-data-center\logs`），开发运行、安装版与 portable 版都写在同一个稳定位置。开发运行回退到仓库的 `logs/`，打包运行回退到 `Documents\PersonalDataCenter\logs`；只有全部不可写时才退到 `%TEMP%`。

</details>

<details>
<summary><strong>为什么排除 `node_modules`？能改吗？</strong></summary>

它能由 `package.json` 重新装出来，却往往占掉压缩包的绝大部分体积。排除写死在 `rar` 与 `tar` 两处参数里；要改就得动 `electron/backup-service.cjs`。

</details>

<details>
<summary><strong>看到成功提示，但应用以退出码 1 结束，为什么？</strong></summary>

无界面模式下只要有任意一个源失败，退出码就是 1，即便其它源都成功。日志里逐源的那几行会指出是哪一个、以及原因（路径不存在、压缩器报错、退出码）。

</details>

<details>
<summary><strong>会删除或移动任何东西吗？</strong></summary>

不会。客户端只读取源目录，只在存放路径下写新文件。文件名含秒级时间戳，已存在的压缩包不会被覆盖。

</details>

## 参与开发

欢迎提 issue 和建议。提交 PR 前请先跑：

```bash
npm run format:check
npm run lint
npm run build:web
```

**技术栈**：Vue 3 · Vite 8 · Element Plus · Electron 41 · electron-builder · IndexedDB · prettier + eslint（flat config）

## 许可

本仓库尚未包含许可文件 —— 版权归 © 2026 makabakax 所有，保留所有权利。如需明确授权，请开 issue 说明。
