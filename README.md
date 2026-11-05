<div align="center">

<img src="docs/logo.png" width="120" alt="Personal Data Center logo">

# Personal Data Center

### A folder backup client that produces plain, timestamped archives — no mirroring, no proprietary container

**Tick the folders you want, press one button: each one becomes a timestamped `.rar` (Windows path) or `.tar.gz` (WSL path) inside a folder named after the day.**

[![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF.svg)](https://vite.dev/)
[![Electron](https://img.shields.io/badge/Electron-41-47848F.svg)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/node-%5E20.19%20%7C%7C%20%3E%3D22.12-informational.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-not%20set-lightgrey.svg)](#license)

English | [中文](README_ZH.md)

**[Quick Start](#quick-start) · [Features](#features) · [Headless & Scheduled Backups](#headless--scheduled-backups) · [FAQ](#faq)**

</div>

## Why Personal Data Center?

Continuous sync tools replicate every mistake within seconds, and backup services usually store your folders in their own format. This client does the boring, reversible thing instead: it reads a folder once and writes one archive whose name carries the time it was made. The source is never modified, and what you get is a file you can open with WinRAR or `tar` on any machine, without this app.

- **Two windows, two jobs** — the main window ticks sources and runs a backup while showing the log; the settings window manages the source list and the destination
- **Windows paths and WSL paths in one list** — a Windows path goes through WinRAR's `rar`; a path inside WSL goes through `wsl.exe tar`, so Linux files are archived at Linux speed instead of crawling through the 9p mount
- **Never archives `node_modules`** — both archivers exclude it, so a JavaScript project doesn't turn into a 2 GB file
- **Failures are reported per source** — one broken folder doesn't stop the rest; the result list and the exit code tell you which one failed
- **Headless mode for the Task Scheduler** — `--backup` runs one backup and exits with code 1 if anything failed
- **A monthly guard script** — `scripts/auto-backup.bat` skips the run when this month already has a log, so a daily scheduled task still backs up once a month
- **One log file per day** — written next to the executable and shown in the main window

## Requirements

- **Node.js**: `^20.19.0 || >=22.12.0` (required by Vite 8)
- **WinRAR**: the `rar` command must be on `PATH` — needed for every Windows source folder
- **WSL**: only if you back up folders that live inside a Linux distribution

## Quick Start

```bash
npm install
npm run dev
```

`npm run dev` starts Vite on port 5173 and then launches Electron pointed at it.

To run Electron against a built bundle instead of the dev server:

```bash
npm run build:web
npm run start
```

## Usage

1. **Configure** — open the settings window (menu bar → 设置) and add your source folders, each with a display name and a path; pick one destination folder; click 保存. A new source gets the folder's last path segment as its name, and renaming it to something else makes that name stick even after you change the folder.
2. **Back up** — in the main window, tick the sources you want, then click 手动执行备份. Progress and results land in the log panel on the right, and 打开备份路径 opens the destination in Explorer.
3. **Read the log** — 备份日志 shows today's log file: time, which sources were selected, and per-source success or the failure reason.

Archives are written to `<destination>/<yyyy-MM-dd>/<name>_<yyyyMMdd_HHmmss>.rar` (or `.tar.gz` for WSL sources).

## Configuration

Settings live in two places and a save must succeed in both, otherwise the code throws instead of reporting success while `run-backup.mjs` reads a stale file:

- **IndexedDB** (`personal-data-center` → `appSettings`, one record with id `singleton`) — what the windows read and write
- **`backup.config.json`** — what the headless path and the backup scripts read

The file uses this shape:

```json
{
  "sourceFolders": [
    { "name": "source1", "path": "D:/example/source1" },
    { "name": "source2", "path": "\\\\wsl$\\Ubuntu\\home\\me\\proj" }
  ],
  "backupDestination": "D:/example/backup-target"
}
```

`sourceFolders` may also be plain strings; the name is then derived from the path. When packaged, the app keeps the writable copy in `%APPDATA%\个人数据中心\backup.config.json` and seeds it from `resources/backup.config.json` on first run — `Program Files` is not writable, so saving there would fail.

## Headless & Scheduled Backups

`npm run backup` runs `scripts/run-backup.mjs`, which locates the application executable and starts it with `--backup --config <path>`:

```bash
npm run backup
npm run backup -- --config ./your-config.json
```

For a monthly schedule, point the Task Scheduler at `scripts/auto-backup.bat`; it looks for `logs/backup-<yyyy-MM>-*.log` and only runs the backup when this month has none yet.

## Supported Sources

| Source path                      | Archiver                                       | Archive   |
| -------------------------------- | ---------------------------------------------- | --------- |
| `D:\work\project`                | `rar a -ep1 -x*\node_modules\*`                | `.rar`    |
| `\\wsl$\Ubuntu\home\me\proj`     | `wsl.exe -d Ubuntu tar -czf -`                 | `.tar.gz` |
| `/home/me/proj` (default distro) | resolved with `wslpath -w`, then `wsl.exe tar` | `.tar.gz` |
| `/mnt/d/work`                    | translated to `D:\work`, then `rar`            | `.rar`    |

WSL paths are recognised by their UNC form (`\\wsl$\…`, `\\wsl.localhost\…`) or by being absolute Linux paths. Because Windows can't `stat` a path inside a distribution, existence is checked with `wsl.exe test -e`; if a `tar` run ends with exit code 1 and every stderr line is a known non-fatal warning (`file changed as we read it`, `socket ignored`, …), the archive is still treated as good.

## Features

### Backup client

- **Manual run** — tick sources and click once; results show per source, including the archive path or the error
- **Full log** — time, selected names, and one line per source per run, appended to `<app dir>/logs/backup-yyyy-MM-dd.log`
- **Path shortcuts** — every source and the destination have an 打开路径 button that opens Explorer at that folder
- **Two engines** — WinRAR's `rar` for Windows paths, `wsl.exe tar` for paths inside WSL, chosen per source automatically

### Settings

- **Multiple sources** — each with a name and a path, deduplicated by path on save
- **One destination** — a single folder; archives are grouped into dated subfolders under it
- **Name that follows the folder only until you edit it** — picking a different folder updates the name only when it was still the auto-derived value, so a hand-typed name is never overwritten
- **Live sync between windows** — the main window reloads through a broadcast channel as soon as settings are saved

### Packaging

- **electron-builder** — `nsis` + `portable` on Windows, `dmg` + `zip` on macOS, `AppImage` + `deb` + `rpm` on Linux, output in `dist-electron/`
- **Scripts shipped** — `scripts/` and `backup.config.json` are copied into the package as extra resources, so the scheduled path works on an installed copy

## FAQ

<details>
<summary><strong>Why require WinRAR instead of using a Node archiver?</strong></summary>

WinRAR compresses large folders considerably faster than a pure-JS archiver and is already installed on most Windows machines in this use case. If `rar` is missing, the run fails with exit code 1 and an explicit message telling you to install it and put it on `PATH`.

</details>

<details>
<summary><strong>Where does the backup log go?</strong></summary>

Next to the executable, in `logs/`: a development run uses the repository's `logs/`, a packaged run uses the folder that holds the `.exe`. If that folder isn't writable, the service falls back to `Documents/personal-data-center/logs`.

</details>

<details>
<summary><strong>Why is `node_modules` excluded, and can I change that?</strong></summary>

It is excluded because it is reproducible from `package.json` and usually dominates the archive size. The exclusion is hard-coded in both the `rar` arguments and the `tar` arguments; removing it means editing `electron/backup-service.cjs`.

</details>

<details>
<summary><strong>The application exits with code 1 but I saw success messages — why?</strong></summary>

Headless mode sets exit code 1 whenever at least one source failed, even if others succeeded. The per-source lines in the log show which one, and the reason (missing path, archiver error, exit code).

</details>

<details>
<summary><strong>Does anything get deleted or moved?</strong></summary>

No. The client only reads source folders and only writes new files under the destination. An existing archive is never overwritten because the name includes a second-precision timestamp.

</details>

## Contributing

Issues and suggestions are welcome. Please run the checks before opening a pull request:

```bash
npm run format:check
npm run lint
npm run build:web
```

**Tech stack**: Vue 3 · Vite 8 · Element Plus · Electron 41 · electron-builder · IndexedDB · prettier + eslint (flat config)

## License

No license file is included in this repository yet — copyright © 2026 makabakax, all rights reserved. Open an issue if you need explicit permission to reuse it.
