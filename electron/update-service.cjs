"use strict";

// 应用内更新：主路径走 GitHub REST API，失败时自动切换到不消耗 API 配额的直链方案。
// 设计参照 lite-script-manager 的 src-tauri/src/update.rs（Tauri），这里是 Node/Electron 版。
//
// 安全约束（与参照实现一致）：
//   - install 只认最近一次 check 缓存的结果，界面无法传入任意下载地址或校验值；
//   - 所有请求/重定向目标必须是允许列表内的 GitHub HTTPS 域名；
//   - 安装包必须有发布的 SHA256 校验值，否则拒绝安装；
//   - 下载有体积上限、MZ 头校验与 SHA256 比对。

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const REPO = "Jaspersol/personal-data-center";
const USER_AGENT = "PersonalDataCenter";
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const PROGRESS_STEP_BYTES = 128 * 1024;
const CHECKSUMS_ASSET = "SHA256SUMS.txt";
const DOWNLOAD_HOSTS = [
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "githubusercontent.com",
];

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
const LATEST_ASSET_BASE = `https://github.com/${REPO}/releases/latest/download/`;

// ---------------------------------------------------------------------------
// 纯函数：便于单独验证，也便于主流程复用
// ---------------------------------------------------------------------------

function httpsHost(url) {
  const value = String(url || "").trim();
  if (!value.startsWith("https://")) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 校验 URL：必须 HTTPS 且主机在允许列表（含其子域）内。 */
function validateDownloadUrl(url) {
  const host = httpsHost(url);
  if (!host) throw new Error("更新地址必须是 HTTPS");
  const allowed = DOWNLOAD_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  if (!allowed) throw new Error("更新地址不在允许的 GitHub 域名内");
}

/** 打开 Release 页面只允许 github.com 本身。 */
function isGithubReleasePage(url) {
  return httpsHost(url) === "github.com";
}

function normaliseVersion(tag) {
  return String(tag || "")
    .trim()
    .replace(/^[vV]+/, "")
    .trim();
}

/** 解析 `1.2.3` / `v1.2` / `1.2.3-rc.1`；无法识别时返回 null。 */
function parseVersion(raw) {
  const cleaned = normaliseVersion(raw);
  if (!cleaned) return null;
  const splitAt = cleaned.search(/[-+]/);
  const core = splitAt === -1 ? cleaned : cleaned.slice(0, splitAt);
  const suffix = splitAt === -1 ? "" : cleaned.slice(splitAt);
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  while (nums.length < 3) nums.push(0);
  let pre = null;
  if (suffix.startsWith("-")) {
    pre = suffix.slice(1).split(".");
    if (pre.some((item) => item === "")) return null;
  }
  return { nums, pre };
}

/** 无法识别的版本永不触发更新，畸形 tag 不会让检查陷入循环。 */
function isNewer(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b.nums[i] !== a.nums[i]) return b.nums[i] > a.nums[i];
  }
  if (a.pre === null && b.pre === null) return false;
  if (a.pre === null) return false;
  if (b.pre === null) return true;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(y) > Number(x);
    if (xn) return false;
    if (yn) return true;
    return y > x;
  }
  return false;
}

/** 从 `…/releases/tag/<tag>` 中读出 tag（忽略查询串）。 */
function tagFromReleaseUrl(url) {
  const marker = "/releases/tag/";
  const pathPart = String(url || "").split(/[?#]/)[0];
  const index = pathPart.lastIndexOf(marker);
  if (index === -1) return null;
  let tag = pathPart.slice(index + marker.length).replace(/\/+$/, "");
  if (!tag) return null;
  try {
    tag = decodeURIComponent(tag);
  } catch {
    /* 保留原值 */
  }
  return tag || null;
}

/** 解析 SHA256SUMS.txt；与 pickInstaller 一致，优先名字含 setup 的 .exe 条目。 */
function installerFromChecksums(text) {
  const entries = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const split = line.search(/[ \t]/);
    if (split <= 0) continue;
    const hash = line.slice(0, split).trim().toLowerCase();
    const name = line.slice(split).trim().replace(/^\*/, "").trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!name || name.includes("/") || name.includes("\\")) continue;
    if (!name.toLowerCase().endsWith(".exe")) continue;
    entries.push({ name, sha256: hash });
  }
  return entries.find((entry) => entry.name.toLowerCase().includes("setup")) || entries[0] || null;
}

function textField(value, key) {
  const item = value && typeof value === "object" ? value[key] : undefined;
  if (typeof item !== "string") return null;
  const trimmed = item.trim();
  return trimmed || null;
}

/** 从 API 的 assets 中挑选 NSIS 安装包：优先名字含 setup 的 .exe。 */
function pickInstaller(body) {
  const assets = Array.isArray(body && body.assets) ? body.assets : [];
  const list = assets
    .map((item) => ({
      name: textField(item, "name"),
      size: Number(item && item.size) || 0,
      url: textField(item, "browser_download_url"),
      mirror: textField(item, "url"),
    }))
    .filter((asset) => asset.name && asset.url);
  const isExe = (asset) => {
    const name = asset.name.toLowerCase();
    return name.endsWith(".exe") && !name.endsWith(".sig") && !name.includes("uninstall");
  };
  return (
    list.find((asset) => isExe(asset) && asset.name.toLowerCase().includes("setup")) ||
    list.find(isExe) ||
    null
  );
}

function checksumAssetUrl(body, assetName) {
  const wanted = `${assetName}.sha256`.toLowerCase();
  const assets = Array.isArray(body && body.assets) ? body.assets : [];
  const item = assets.find((asset) => (textField(asset, "name") || "").toLowerCase() === wanted);
  return item ? textField(item, "browser_download_url") : null;
}

function parseDigest(text) {
  const token = String(text || "")
    .split(/[\s*]+/)
    .find((part) => /^[0-9a-fA-F]{64}$/.test(part));
  return token ? token.toLowerCase() : null;
}

/** 校验文件里按资产名精确取 SHA256，避免多行 manifest 拿到别的资产的哈希。 */
function digestForAsset(text, assetName) {
  const wanted = String(assetName || "").toLowerCase();
  if (!wanted) return null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.trim().split(/[ \t]+/);
    if (parts.length < 2) continue;
    const hash = parts[0].toLowerCase();
    const name = parts.slice(1).join(" ").replace(/^\*/, "").trim();
    if (/^[0-9a-f]{64}$/.test(hash) && name.toLowerCase() === wanted) return hash;
  }
  return null;
}

function parseRelease(current, body) {
  const tag = textField(body, "tag_name") || "";
  const latest = normaliseVersion(tag);
  const asset = pickInstaller(body);
  return {
    current_version: current,
    latest_version: latest || tag,
    has_update: isNewer(current, latest),
    release_name: textField(body, "name") || tag || null,
    notes: textField(body, "body"),
    published_at: textField(body, "published_at"),
    release_url: textField(body, "html_url"),
    asset_name: asset ? asset.name : null,
    asset_size: asset ? asset.size : null,
    download_url: asset ? asset.url : null,
    mirror_url: asset ? asset.mirror : null,
    sha256: null,
    checked_at: Date.now(),
  };
}

function safeFileName(name) {
  const base =
    String(name || "")
      .split(/[\\/]/)
      .pop() || "update";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned.toLowerCase().endsWith(".exe") ? cleaned : "PersonalDataCenter-setup.exe";
}

/** 直链兜底：releases/latest/download/<name> 走 github.com，不碰 REST API。 */
function partnerDownloadUrl(name) {
  if (!name || name.includes("/") || name.includes("\\")) return null;
  return `${LATEST_ASSET_BASE}${name}`;
}

function describeError(error) {
  let message = error && error.message ? error.message : String(error);
  let cause = error && error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    message += `（${cause.message || cause}）`;
    cause = cause.cause;
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelBody(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch {
    /* 连接会被复用或丢弃，忽略取消失败 */
  }
}

function defaultLog(level, message) {
  console.log(`[update:${level}] ${message}`);
}

// ---------------------------------------------------------------------------
// 网络：手动跟随重定向，逐跳校验域名
// ---------------------------------------------------------------------------

function headersFor(url, appVersion, extra) {
  const headers = {
    "User-Agent": `${USER_AGENT}/${appVersion} (+https://github.com/${REPO})`,
    Accept: "application/vnd.github+json",
  };
  // 通过 assets API 端点下载时必须声明 octet-stream，否则返回的是 JSON 元数据。
  if (url.startsWith("https://api.github.com/") && url.includes("/releases/assets/")) {
    headers.Accept = "application/octet-stream";
  }
  return { ...headers, ...(extra || {}) };
}

/** 逐跳校验主机，最多 10 跳，返回最终响应与最终 URL。 */
async function request(url, { appVersion, signal }) {
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    validateDownloadUrl(current);
    const response = await fetch(current, {
      headers: headersFor(current, appVersion),
      redirect: "manual",
      signal,
    });
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { response, finalUrl: current };
    let next;
    try {
      next = new URL(location, current).toString();
    } catch (error) {
      await cancelBody(response);
      throw new Error("更新重定向目标无效", { cause: error });
    }
    // 先释放当前响应，再校验下一跳主机：校验失败时也不会留下未关闭的连接。
    await cancelBody(response);
    validateDownloadUrl(next);
    current = next;
  }
  throw new Error("重定向次数过多");
}

function apiRequest(url, appVersion) {
  return request(url, { appVersion, signal: AbortSignal.timeout(30000) });
}

/** 依次尝试所有候选地址，每个地址网络错误重试一次。 */
async function openStream(candidates, appVersion) {
  const errors = [];
  for (const url of candidates) {
    try {
      validateDownloadUrl(url);
    } catch (error) {
      errors.push(`${url}（${error.message}）`);
      continue;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { response } = await request(url, {
          appVersion,
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
        if (response.ok) return response;
        errors.push(`HTTP ${response.status}`);
        await cancelBody(response);
        break;
      } catch (error) {
        errors.push(describeError(error));
        if (attempt === 0) await sleep(700);
      }
    }
  }
  throw new Error(`下载更新失败：${errors.join("；")}`);
}

/** 流式写入临时文件，同时算 SHA256、校验大小与 MZ 头。 */
async function downloadToFile(candidates, target, appVersion, onProgress) {
  const response = await openStream(candidates, appVersion);
  const rawTotal = Number(response.headers.get("content-length"));
  const total = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : null;
  if (total && total > MAX_INSTALLER_BYTES) {
    await cancelBody(response);
    throw new Error("更新包体积异常，已停止下载");
  }
  if (!response.body) {
    await cancelBody(response);
    throw new Error("下载的更新包为空");
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const handle = await fsp.open(target, "w");
  const hasher = crypto.createHash("sha256");
  let downloaded = 0;
  let position = 0;
  let reported = 0;
  const head = [];
  let reader = null;
  try {
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (head.length < 2) {
        for (const byte of buffer.subarray(0, 2 - head.length)) head.push(byte);
      }
      await handle.write(buffer, 0, buffer.length, position);
      position += buffer.length;
      hasher.update(buffer);
      downloaded += buffer.length;
      if (downloaded > MAX_INSTALLER_BYTES) {
        throw new Error("更新包体积异常，已停止下载");
      }
      if (downloaded - reported >= PROGRESS_STEP_BYTES || (total && downloaded === total)) {
        reported = downloaded;
        onProgress(downloaded, total);
      }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(target, { force: true }).catch(() => {});
    throw new Error(`下载中断: ${describeError(error)}`, { cause: error });
  } finally {
    if (reader) reader.releaseLock();
  }
  await handle.close();

  const removeAndFail = async (message) => {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw new Error(message);
  };
  if (downloaded === 0) return removeAndFail("下载的更新包为空");
  if (total && downloaded !== total) {
    return removeAndFail(`下载不完整：${downloaded}/${total} 字节`);
  }
  if (head[0] !== 0x4d || head[1] !== 0x5a) {
    return removeAndFail("下载的文件不是有效的 Windows 安装程序");
  }
  return { downloaded, digest: hasher.digest("hex") };
}

function requiredChecksum(info) {
  const value = String(info && info.sha256 ? info.sha256 : "")
    .trim()
    .toLowerCase();
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  throw new Error("该版本没有提供 .sha256 校验文件，已取消安装（无法验证安装包完整性）");
}

function defaultLaunchInstaller(target, log) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("自动安装仅支持 Windows，请在 GitHub Release 页面手动下载"));
  }
  return new Promise((resolve, reject) => {
    // electron-builder 的 one-click NSIS：/S 静默、--force-run 静默后仍重启应用、
    // --updated 走更新分支（保留数据/快捷方式，并温和关闭正在运行的实例）。
    const args = ["/S", "--force-run", "--updated"];
    const child = spawn(target, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    child.once("error", (error) => {
      log("ERROR", `启动安装程序失败: ${error.message}`);
      reject(new Error(`启动安装程序失败: ${error.message}`));
    });
    child.once("spawn", resolve);
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.userDataDir  Electron 的 userData，用于存放更新设置
 * @param {string} options.appVersion   app.getVersion()
 * @param {(channel: string, payload: object) => void} [options.emit] 推送进度到渲染进程
 * @param {(level: string, message: string) => void} [options.log]
 * @param {(target: string, log: Function) => Promise<void>} [options.launchInstaller]
 */
function createUpdateService({
  userDataDir,
  appVersion,
  emit = () => {},
  log = defaultLog,
  launchInstaller = defaultLaunchInstaller,
} = {}) {
  const settingsFile = path.join(userDataDir, "update-settings.json");
  let lastCheck = null;

  function readSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      return {
        auto_check_update: raw.auto_check_update !== false,
        last_update_check_ms: Number(raw.last_update_check_ms) || 0,
      };
    } catch {
      return { auto_check_update: true, last_update_check_ms: 0 };
    }
  }

  function writeSettings(next) {
    const merged = { ...readSettings(), ...next };
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(merged), "utf8");
  }

  function recordCheck() {
    writeSettings({ last_update_check_ms: Date.now() });
  }

  /** 读取一个校验文件，按资产名精确匹配；失败返回 null（不是致命错误）。 */
  async function fetchChecksumValue(url, assetName) {
    try {
      const { response } = await apiRequest(url, appVersion);
      if (!response.ok) {
        await cancelBody(response);
        return null;
      }
      return digestForAsset(await response.text(), assetName);
    } catch (error) {
      log("WARN", `读取校验文件失败: ${error.message}`);
      return null;
    }
  }

  /** 主路径：GitHub REST API /releases/latest。 */
  async function fetchLatestPrimary() {
    const { response } = await apiRequest(LATEST_RELEASE_API, appVersion);
    if (response.status === 404) {
      await cancelBody(response);
      throw new Error("GitHub 仓库还没有发布任何版本");
    }
    if (!response.ok) {
      if (response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining && remaining.trim() === "0") {
          await cancelBody(response);
          throw new Error("GitHub API 访问次数已用完，请稍后再试");
        }
      }
      await cancelBody(response);
      throw new Error(`检查更新失败：HTTP ${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`解析发布信息失败: ${error.message}`, { cause: error });
    }
    const info = parseRelease(appVersion, body);
    // 校验值来源按优先级：发布里的 <安装包>.sha256（API 主路径），
    // 再试 SHA256SUMS.txt 直链（不消耗 API 配额）。两者都取不到时保持 null，
    // install 会据此拒绝安装，绝不放行未验证的包。
    if (info.asset_name) {
      const checksumUrl = checksumAssetUrl(body, info.asset_name);
      if (checksumUrl) {
        info.sha256 = await fetchChecksumValue(checksumUrl, info.asset_name);
      }
      if (!info.sha256) {
        info.sha256 = await fetchChecksumValue(
          `${LATEST_ASSET_BASE}${CHECKSUMS_ASSET}`,
          info.asset_name,
        );
      }
      if (!info.sha256) {
        log("WARN", "该版本没有可用的校验文件，安装会被拒绝");
      }
    }
    return info;
  }

  /** 读取 `releases/latest` 的重定向目标，拿到 tag，完全不碰 API 配额。 */
  async function fallbackLatestTag() {
    const { response, finalUrl } = await apiRequest(RELEASE_PAGE, appVersion);
    const tag = tagFromReleaseUrl(finalUrl);
    await cancelBody(response);
    if (tag) return tag;
    if (response.status === 404) throw new Error("GitHub 仓库还没有发布任何版本");
    throw new Error("最新发布没有可识别的版本号");
  }

  /** 兜底：tag 来自重定向，安装包名与 SHA256 来自 SHA256SUMS.txt，下载地址为直链。 */
  async function fetchLatestFallback() {
    const tag = await fallbackLatestTag();
    const latest = normaliseVersion(tag);
    const hasUpdate = isNewer(appVersion, latest);
    const info = {
      current_version: appVersion,
      latest_version: latest || tag,
      has_update: hasUpdate,
      release_name: tag,
      notes: null,
      published_at: null,
      release_url: `https://github.com/${REPO}/releases/tag/${tag}`,
      asset_name: null,
      asset_size: null,
      download_url: null,
      mirror_url: null,
      sha256: null,
      checked_at: Date.now(),
    };
    if (!hasUpdate) return info;

    const { response } = await apiRequest(`${LATEST_ASSET_BASE}${CHECKSUMS_ASSET}`, appVersion);
    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`检查更新失败：HTTP ${response.status}`);
    }
    const text = await response.text();
    const found = installerFromChecksums(text);
    if (!found) throw new Error("该版本没有提供安装包");

    info.asset_name = found.name;
    info.sha256 = found.sha256;
    info.download_url = `${LATEST_ASSET_BASE}${found.name}`;
    info.mirror_url = `https://github.com/${REPO}/releases/download/${tag}/${found.name}`;
    return info;
  }

  /** 主路径优先，任何失败都自动切换直链兜底；两条路径都走这里（手动检查与启动自动检查）。 */
  async function fetchLatestWithFallback() {
    try {
      return await fetchLatestPrimary();
    } catch (primary) {
      log("WARN", `检查更新主路径失败，切换备用方案: ${primary.message}`);
      try {
        const info = await fetchLatestFallback();
        log("INFO", "已通过备用方案完成检查更新");
        return info;
      } catch (fallback) {
        log("WARN", `备用方案同样失败: ${fallback.message}`);
        throw new Error(`${fallback.message}（主路径：${primary.message}）`, { cause: fallback });
      }
    }
  }

  async function check() {
    const info = await fetchLatestWithFallback();
    recordCheck();
    lastCheck = info;
    return info;
  }

  /** 启动自动检查：遵守开关与 6 小时间隔，仅在新版本时返回结果。 */
  async function autoCheck() {
    const settings = readSettings();
    if (!settings.auto_check_update) return null;
    if (Date.now() - settings.last_update_check_ms < AUTO_CHECK_INTERVAL_MS) return null;
    try {
      const info = await fetchLatestWithFallback();
      recordCheck();
      lastCheck = info;
      return info.has_update ? info : null;
    } catch (error) {
      log("WARN", `自动检查更新失败: ${error.message}`);
      recordCheck();
      return null;
    }
  }

  /** 只用缓存的 check 结果安装；校验值缺失或不符一律拒绝。 */
  async function install() {
    const info = lastCheck;
    if (!info) throw new Error("请先检查更新");
    if (!info.has_update) throw new Error("当前已是最新版本");
    const expectedSha256 = requiredChecksum(info);
    if (!info.download_url || !info.asset_name) throw new Error("该版本没有提供安装包");

    const candidates = [info.download_url];
    if (info.mirror_url && info.mirror_url.trim()) candidates.push(info.mirror_url);
    const fallbackUrl = partnerDownloadUrl(info.asset_name);
    if (fallbackUrl && !candidates.includes(fallbackUrl)) candidates.push(fallbackUrl);
    for (const candidate of candidates) validateDownloadUrl(candidate);

    const target = path.join(
      os.tmpdir(),
      "PersonalDataCenter-update",
      safeFileName(info.asset_name),
    );
    await fsp.rm(target, { force: true });

    const { downloaded, digest } = await downloadToFile(
      candidates,
      target,
      appVersion,
      (done, total) => {
        emit("update:progress", { downloaded: done, total });
      },
    );
    if (digest !== expectedSha256) {
      await fsp.rm(target, { force: true }).catch(() => {});
      throw new Error("更新包校验失败：SHA256 不匹配");
    }
    // 残余风险：哈希与安装包来自同一个 Release，只能证明完整性，不能证明发布者身份。
    // Authenticode（WinVerifyTrust）此处刻意未校验。
    log("INFO", `更新包已通过 SHA256 校验 (${digest})`);
    emit("update:progress", { downloaded, total: downloaded });
    await launchInstaller(target, log);
    log("INFO", `安装更新 ${digest}，应用退出等待安装程序完成`);
  }

  return {
    check,
    autoCheck,
    install,
    lastResult: () => lastCheck,
    getAutoCheck: () => readSettings().auto_check_update,
    setAutoCheck: (enabled) => {
      const value = enabled === true;
      writeSettings({ auto_check_update: value });
      return value;
    },
  };
}

module.exports = {
  createUpdateService,
  httpsHost,
  validateDownloadUrl,
  isGithubReleasePage,
  normaliseVersion,
  isNewer,
  tagFromReleaseUrl,
  installerFromChecksums,
  pickInstaller,
  checksumAssetUrl,
  parseDigest,
  digestForAsset,
  parseRelease,
  safeFileName,
  partnerDownloadUrl,
};
