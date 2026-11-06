const DB_NAME = "personal-data-center";
const DB_VERSION = 1;
const STORE = "appSettings";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

const SINGLETON_ID = "singleton";

function defaultRecord() {
  return {
    id: SINGLETON_ID,
    backupDestination: "",
    backupSources: [],
  };
}

/**
 * 读取 IndexedDB 中的设置记录（单例记录，id 固定为 "singleton"）。
 *
 * @returns {Promise<{id: string, backupDestination: string, backupSources: Array<object>}>}
 *   记录不存在时返回默认值；老版本只有 sourceFolders 字段时会自动迁移为 backupSources
 */
export async function loadSettingsFromIdb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(SINGLETON_ID);
    req.onsuccess = () => {
      const row = req.result;
      resolve(row ? normalizeRecord(row) : defaultRecord());
    };
    req.onerror = () => reject(req.error);
  });
}

function normalizeRecord(row) {
  const backupDestination = typeof row.backupDestination === "string" ? row.backupDestination : "";
  let backupSources = Array.isArray(row.backupSources) ? row.backupSources : [];
  if (backupSources.length === 0 && Array.isArray(row.sourceFolders)) {
    backupSources = migrateLegacyFolders(row.sourceFolders);
  }
  return {
    id: SINGLETON_ID,
    backupDestination,
    backupSources: backupSources.map(normalizeSource).filter((s) => s.path),
  };
}

function migrateLegacyFolders(folders) {
  return folders
    .map((item) => {
      if (typeof item === "string") {
        return {
          id: crypto.randomUUID(),
          name: item.split(/[/\\]/).filter(Boolean).pop() || item,
          path: item,
        };
      }
      if (item && typeof item.path === "string") {
        return {
          id: item.id || crypto.randomUUID(),
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.path,
          path: item.path,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeSource(item) {
  if (!item || typeof item.path !== "string" || !item.path.trim()) {
    return { id: item?.id || crypto.randomUUID(), name: "", path: "" };
  }
  const pathTrimmed = item.path.trim();
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    name:
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : pathTrimmed.split(/[/\\]/).filter(Boolean).pop() || pathTrimmed,
    path: pathTrimmed,
  };
}

function putRecord(db, payload) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(payload);
    req.onsuccess = () => resolve(payload);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 保存设置：先写入 IndexedDB，再双写到 backup.config.json（仅 Electron 环境）。
 *
 * 主进程只把主配置文件的成功写入视为成功；配置文件完全没写成功时回滚 IndexedDB，
 * 避免下次打开界面读到与自动备份脚本不一致的设置。主配置成功而副本失败属于部分成功，
 * 此时保留 IndexedDB 的新值，并把 partial 标记透传给界面提示。
 *
 * @param {{backupDestination?: string, backupSources?: Array<object>}} record
 * @returns {Promise<{id: string, backupDestination: string, backupSources: Array<object>}>}
 *   实际写入 IndexedDB 的规范化记录
 * @throws {Error} 配置文件写入失败时抛出；error.partial 为 true 表示主配置已写入
 */
export async function saveSettingsToIdb(record) {
  const db = await openDb();
  const payload = {
    id: SINGLETON_ID,
    backupDestination:
      typeof record.backupDestination === "string" ? record.backupDestination.trim() : "",
    backupSources: Array.isArray(record.backupSources)
      ? record.backupSources.map(normalizeSource).filter((s) => s.name && s.path)
      : [],
  };

  const previous = await loadSettingsFromIdb();
  const saved = await putRecord(db, payload);

  // 同时保存到 backup.config.json（仅 Electron 环境）
  if (typeof window !== "undefined" && window.backupApi) {
    const configData = {
      sourceFolders: payload.backupSources.map((s) => ({ name: s.name, path: s.path })),
      backupDestination: payload.backupDestination,
    };
    const result = await window.backupApi.saveConfig(configData);
    if (!result || result.success !== true) {
      const error = new Error(result?.error || "写入配置文件失败: 未知错误");
      error.partial = result?.partial === true;
      if (!error.partial) {
        // 配置文件完全没写成功时回滚 IndexedDB，保持两份存储一致
        try {
          await putRecord(db, previous);
        } catch {
          // 回滚失败时仍然抛出原始错误，由界面提示用户重新保存
        }
      }
      throw error;
    }
  }

  return saved;
}

const CHANNEL = "pdc-settings";

/**
 * 广播“设置已变更”事件，让其它窗口（如主页面）重新加载设置。
 *
 * @returns {void}
 */
export function notifySettingsChanged() {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage("changed");
    ch.close();
  } catch {
    // 浏览器不支持 BroadcastChannel 时降级为不通知，调用方无需感知
  }
}

/**
 * 订阅设置变更事件。
 *
 * @param {() => void} onChange 收到变更通知时执行的回调
 * @returns {() => void} 取消订阅函数；BroadcastChannel 不可用时返回空函数，调用处可直接调用
 */
export function subscribeSettingsChanges(onChange) {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = () => onChange();
    return () => {
      ch.close();
    };
  } catch {
    // BroadcastChannel 不可用时降级为不通知，返回空的取消订阅函数保持调用方代码一致
    return () => {};
  }
}
