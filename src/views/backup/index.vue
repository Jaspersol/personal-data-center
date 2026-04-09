<script setup>
import {computed, onMounted, onUnmounted, reactive} from "vue";
import {ElMessage} from "element-plus";
import {
  loadSettingsFromIdb,
  subscribeSettingsChanges
} from "/src/db/settings-idb.js";

const state = reactive({
  backupSources: [],
  backupDestination: "",
  selectedForBackup: [],
  backupResult: null,
  loading: false,
  logContent: "",
});

const hasApi = computed(() => typeof window !== "undefined" && !!window.backupApi);

async function loadSettings() {
  const data = await loadSettingsFromIdb();
  state.backupDestination = data.backupDestination || "";
  state.backupSources = data.backupSources || [];
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
    ElMessage.error("读取日志失败");
  }
}

async function runBackup() {
  if (!hasApi.value) return;
  const selectedSources = getSelectedSources();
  if (!state.backupDestination.trim()) return ElMessage.warning("请先在设置中配置备份存放路径");
  if (selectedSources.length === 0) return ElMessage.warning("请至少勾选一个要备份的源路径");

  state.loading = true;
  try {
    const result = await window.backupApi.runBackup({
      selectedSources,
      backupDestination: state.backupDestination,
    });
    state.backupResult = result;
    ElMessage.success(`备份完成：成功 ${result.successCount}，失败 ${result.failedCount}`);
    await readLog();
  } catch (error) {
    ElMessage.error(error.message || "备份失败");
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

async function openPath(pathValue) {
  if (!hasApi.value || !pathValue) return;
  const errorMessage = await window.backupApi.openPath(pathValue);
  if (errorMessage) ElMessage.error(`打开路径失败: ${errorMessage}`);
}

let unsubscribeSettings = () => {
};

onMounted(async () => {
  unsubscribeSettings = subscribeSettingsChanges(loadSettings);
  await loadSettings();
  await readLog();
  if (!hasApi.value) ElMessage.warning("当前不是 Electron 环境，请启动客户端。");
});

onUnmounted(() => unsubscribeSettings());
</script>

<template>
  <div class="row">
    <el-button @click="loadSettings">刷新配置</el-button>
    <el-button :disabled="state.loading" @click="runBackup">手动执行备份</el-button>
    <el-button @click="openPath(state.backupDestination)">打开备份路径</el-button>
  </div>
  <div class="checkbox-list">
    <p>勾选本次执行备份的源路径:</p>
    <label v-for="s in state.backupSources" :key="s.id">
      <input type="checkbox" :checked="state.selectedForBackup.includes(s.path)"
             @change="toggleSelected(s.path)"/>
      <span class="chk-label">{{ s.name }}</span>
      <el-button class="inline-btn" @click="openPath(s.path)">打开路径</el-button>
    </label>
  </div>
  <h4>备份日志</h4>
  <div class="log-container">
    <pre class="log-content">{{ state.logContent }}</pre>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.folder-list li {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px;
}

.source-row input {
  padding: 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}

.source-row code {
  word-break: break-all;
  background: #f9fafb;
  padding: 6px;
  border-radius: 6px;
}

.checkbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.checkbox-list label {
  display: flex;
  gap: 8px;
  align-items: center;
}

.chk-label {
  min-width: 180px;
}

.inline-btn {
  padding: 4px 8px;
  font-size: 12px;
}

.result {
  margin-top: 12px;
}

.log-container {
  display: flex;
  width: 800px;
  height: 300px;
  overflow: auto;
}
</style>