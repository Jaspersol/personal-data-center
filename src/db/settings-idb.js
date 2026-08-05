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
  return folders.map((item) => {
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
  }).filter(Boolean);
}

function normalizeSource(item) {
  if (!item || typeof item.path !== "string" || !item.path.trim()) {
    return { id: item?.id || crypto.randomUUID(), name: "", path: "" };
  }
  const pathTrimmed = item.path.trim();
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : pathTrimmed.split(/[/\\]/).filter(Boolean).pop() || pathTrimmed,
    path: pathTrimmed,
  };
}

export async function saveSettingsToIdb(record) {
  const db = await openDb();
  const payload = {
    id: SINGLETON_ID,
    backupDestination: typeof record.backupDestination === "string" ? record.backupDestination.trim() : "",
    backupSources: Array.isArray(record.backupSources)
        ? record.backupSources.map(normalizeSource).filter((s) => s.name && s.path)
        : [],
  };

  // 保存到 IndexedDB
  const saved = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(payload);
    req.onsuccess = () => resolve(payload);
    req.onerror = () => reject(req.error);
  });

  // 同时保存到 backup.config.json（仅在Electron环境中）
  if (typeof window !== "undefined" && window.backupApi) {
    const configData = {
      sourceFolders: payload.backupSources.map(s => ({ name: s.name, path: s.path })),
      backupDestination: payload.backupDestination
    };
    const result = await window.backupApi.saveConfig(configData);
    if (result && result.success === false) {
      // 写入配置文件失败必须告知用户，否则脚本备份会一直读到旧配置
      throw new Error(`写入配置文件失败: ${result.error || "未知错误"}`);
    }
  }

  return saved;
}

const CHANNEL = "pdc-settings";

export function notifySettingsChanged() {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage("changed");
    ch.close();
  } catch {
    /* ignore */
  }
}

export function subscribeSettingsChanges(onChange) {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = () => onChange();
    return () => {
      ch.close();
    };
  } catch {
    return () => {};
  }
}