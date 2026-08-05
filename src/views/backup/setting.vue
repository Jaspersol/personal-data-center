<script setup>
import {computed, onMounted, onUnmounted, reactive} from "vue";
import {ElMessage} from "element-plus";
import {
  loadSettingsFromIdb,
  notifySettingsChanged,
  saveSettingsToIdb,
  subscribeSettingsChanges
} from "../../db/settings-idb.js";

const state = reactive({
  backupSources: [],
  backupDestination: "",
  logContent: "",
});

const hasApi = computed(() => typeof window !== "undefined" && !!window.backupApi);

async function loadSettings() {
  const data = await loadSettingsFromIdb();
  state.backupDestination = data.backupDestination || "";
  state.backupSources = data.backupSources || [];
}

async function saveSettings() {
  for (const s of state.backupSources) {
    if (!String(s.name || "").trim()) return ElMessage.warning("请填写名称");
    if (!String(s.path || "").trim()) return ElMessage.warning("请选择文件夹路径");
  }
  try {
    await saveSettingsToIdb({
      backupDestination: state.backupDestination,
      backupSources: state.backupSources,
    });
  } catch (error) {
    ElMessage.error(`保存失败：${error.message || error}`);
    return;
  }
  notifySettingsChanged();
  ElMessage.success("设置已保存");
}

async function addBackupSource() {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  const name = folder.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop() || "备份项";
  state.backupSources.push({id: crypto.randomUUID(), name, path: folder});
}

async function pickPathForSource(entry) {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  entry.path = folder;
}

async function chooseDestination() {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  state.backupDestination = folder;
}

function removeBackupSource(id) {
  state.backupSources = state.backupSources.filter((s) => s.id !== id);
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
  if (!hasApi.value) ElMessage.warning("当前不是 Electron 环境，请启动客户端。");
});

onUnmounted(() => unsubscribeSettings());
</script>

<template>
  <div class="button-row">
    <el-button @click="addBackupSource">添加被备份项</el-button>
    <el-button @click="chooseDestination">选择备份存放路径</el-button>
    <el-button @click="saveSettings">保存设置</el-button>
  </div>
  <div class="button-row">
    <div class="load-position"><strong>备份存放路径:</strong>&nbsp;<div>{{ state.backupDestination || "未设置" }}</div></div>
    <el-button size="small" @click="openPath(state.backupDestination)">打开路径</el-button>
  </div>
  <div class="setting-container">
    <el-card class="settings-card">
      <ul class="folder-list">
        <li v-for="s in state.backupSources" :key="s.id">
          <div class="source-row">
            <el-input v-model="s.name" type="text" placeholder="备份名称（必填）"/>
            <code>{{ s.path || "未选择路径" }}</code>
            <div class="button-row">
              <el-button @click="pickPathForSource(s)">选择文件夹</el-button>
              <el-button @click="openPath(s.path)">打开路径</el-button>
              <el-button @click="removeBackupSource(s.id)">移除</el-button>
            </div>
          </div>
        </li>
      </ul>
    </el-card>
  </div>
</template>

<style scoped>
.setting-container {
  display: flex;
  height: calc(100vh - 150px);
  overflow: hidden;
}

.button-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.load-position {
  display: flex;
  white-space: nowrap;
}

.load-position div {
  max-width: calc(100vw - 400px);
  overflow: auto;
  white-space: nowrap;
}

.load-position div::-webkit-scrollbar {
  height: 0;
}

.settings-card {
  padding: 10px 0;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
}

.folder-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.folder-list li {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px;
}

.source-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.checkbox-list label {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>