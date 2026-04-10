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
  <div class="button-row">
    <el-button @click="loadSettings">刷新配置</el-button>
    <el-button :disabled="state.loading" @click="runBackup">手动执行备份</el-button>
    <el-button @click="openPath(state.backupDestination)">打开备份路径</el-button>
  </div>
  <div class="main-container">
    <div class="checkbox-container">
      <h4>选择执行备份:</h4>
      <el-card class="checkbox-card">
        <label v-for="s in state.backupSources" :key="s.id">
          <input type="checkbox" :checked="state.selectedForBackup.includes(s.path)"
                 @change="toggleSelected(s.path)"/>
          <span class="chk-label">{{ s.name }}</span>
          <el-button class="inline-btn" @click="openPath(s.path)">打开路径</el-button>
        </label>
      </el-card>
    </div>
    <div class="log-container">
      <h4>备份日志</h4>
      <el-card class="log-card">
        <pre class="log-content">{{ state.logContent }}</pre>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.button-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.main-container {
  display: flex;
  flex-direction: row;
}

.checkbox-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-card {
  height: 80vh;
  overflow: auto;
}

.checkbox-card label {
  padding: 8px 0;
  display: flex;
  gap: 8px;
  align-items: center;
}

.inline-btn {
  padding: 4px 8px;
  font-size: 12px;
}

.log-container {
  margin-left: 20px;
  display: flex;
  flex-direction: column;
}

.log-card {
  padding: 10px 0;
  width: 610px;
  height: 80vh;
  overflow: auto;
}
</style>