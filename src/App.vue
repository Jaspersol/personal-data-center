<script setup>
import {computed, onMounted, onUnmounted, reactive} from "vue";
import {
  loadSettingsFromIdb,
  notifySettingsChanged,
  saveSettingsToIdb,
  subscribeSettingsChanges
} from "./db/settings-idb.js";

function detectPageMode() {
  if (typeof window === "undefined") return "main";
  return window.location.hash.includes("/settings") ? "settings" : "main";
}

const state = reactive({
  activePage: detectPageMode(),
  settingsMenu: "backup",
  mainMenu: "backup",
  backupSources: [],
  backupDestination: "",
  selectedForBackup: [],
  backupResult: null,
  loading: false,
  message: "",
  logContent: "",
});

const hasApi = computed(() => typeof window !== "undefined" && !!window.backupApi);

function setMessage(text) {
  state.message = text;
}

async function loadSettings() {
  const data = await loadSettingsFromIdb();
  state.backupDestination = data.backupDestination || "";
  state.backupSources = data.backupSources || [];
  state.selectedForBackup = state.backupSources.map((s) => s.path);
}

async function saveSettings() {
  for (const s of state.backupSources) {
    if (!String(s.name || "").trim()) return setMessage("请为每个被备份路径填写名称");
    if (!String(s.path || "").trim()) return setMessage("请为每个被备份项选择文件夹路径");
  }
  await saveSettingsToIdb({
    backupDestination: state.backupDestination,
    backupSources: state.backupSources,
  });
  notifySettingsChanged();
  setMessage("设置已保存（IndexedDB）");
}

async function addBackupSource() {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  const name = folder.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop() || "备份项";
  state.backupSources.push({id: crypto.randomUUID(), name, path: folder});
  state.selectedForBackup = state.backupSources.map((s) => s.path);
}
function getSelectedSources() {
  const selectedSet = new Set(state.selectedForBackup);
  return state.backupSources
      .filter((item) => selectedSet.has(item.path))
      .map((item) => ({name: item.name, path: item.path}));
}

async function readLog() {
  if (!hasApi.value) return;
  try {
    state.logContent = await window.backupApi.readLog();
  } catch (error) {
    setMessage("读取日志失败");
  }
}

async function runBackup() {
  if (!hasApi.value) return;
  const selectedSources = getSelectedSources();
  if (!state.backupDestination.trim()) return setMessage("请先在设置中配置备份存放路径");
  if (selectedSources.length === 0) return setMessage("请至少勾选一个要备份的源路径");

  state.loading = true;
  setMessage("");
  try {
    const result = await window.backupApi.runBackup({
      selectedSources,
      backupDestination: state.backupDestination,
    });
    state.backupResult = result;
    setMessage(`备份完成：成功 ${result.successCount}，失败 ${result.failedCount}`);
    await readLog();
  } catch (error) {
    setMessage(error.message || "备份失败");
  } finally {
    state.loading = false;
  }
}

function toggleSelected(path) {
  if (state.selectedForBackup.includes(path)) {
    state.selectedForBackup = state.selectedForBackup.filter((item) => item !== path);
  } else {
    state.selectedForBackup = [...state.selectedForBackup, path];
  }
}

async function openSettingsWindow() {
  if (!hasApi.value) return;
  await window.backupApi.openSettings();
}

async function openPath(pathValue) {
  if (!hasApi.value || !pathValue) return;
  const errorMessage = await window.backupApi.openPath(pathValue);
  if (errorMessage) setMessage(`打开路径失败: ${errorMessage}`);
}

let unsubscribeSettings = () => {
};

onMounted(async () => {
  unsubscribeSettings = subscribeSettingsChanges(loadSettings);
  await loadSettings();
  await readLog();
  if (!hasApi.value) setMessage("当前不是 Electron 环境，请使用 npm run dev 启动客户端。");
});

onUnmounted(() => unsubscribeSettings());
</script>

<template>
  <router-view></router-view>
</template>

<style scoped>
</style>