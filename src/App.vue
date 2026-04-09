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
  const removed = state.backupSources.find((s) => s.id === id);
  state.backupSources = state.backupSources.filter((s) => s.id !== id);
  state.selectedForBackup = state.selectedForBackup.filter((p) => p !== removed?.path);
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
  <div class="page">
    <header v-if="state.activePage === 'main'" class="menubar-strip" role="menubar">
      <button type="button" class="menubar-item" @click="openSettingsWindow">设置</button>
    </header>
    <main class="content" :class="{ 'with-menubar': state.activePage === 'main' }">
      <template v-if="state.activePage === 'settings'">
        <aside class="inner-nav">
          <button :class="{ active: state.settingsMenu === 'backup' }" @click="state.settingsMenu = 'backup'">备份数据
          </button>
        </aside>
        <section class="panel" v-if="state.settingsMenu === 'backup'">
          <h3>设置 / 备份数据</h3>
          <div class="row">
            <button type="button" @click="addBackupSource">添加被备份项</button>
            <button type="button" @click="chooseDestination">选择备份存放路径</button>
            <button type="button" @click="saveSettings">保存设置</button>
          </div>
          <div class="row">
            <p><strong>备份存放路径:</strong> {{ state.backupDestination || "未设置" }}</p>
            <button type="button" @click="openPath(state.backupDestination)">打开该路径</button>
          </div>
          <ul class="folder-list">
            <li v-for="s in state.backupSources" :key="s.id">
              <div class="source-row">
                <input v-model="s.name" type="text" placeholder="备份名称（必填）"/>
                <code>{{ s.path || "未选择路径" }}</code>
                <div class="row">
                  <button type="button" @click="pickPathForSource(s)">选择文件夹</button>
                  <button type="button" @click="openPath(s.path)">打开路径</button>
                  <button type="button" @click="removeBackupSource(s.id)">移除</button>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </template>

      <template v-else>
        <aside class="inner-nav">
          <button :class="{ active: state.mainMenu === 'backup' }" @click="state.mainMenu = 'backup'">备份数据</button>
        </aside>
        <section class="panel" v-if="state.mainMenu === 'backup'">
          <h3>主页面 / 备份数据</h3>
          <div class="row">
            <button type="button" @click="loadSettings">刷新配置</button>
            <button type="button" :disabled="state.loading" @click="runBackup">手动执行备份</button>
            <button type="button" @click="openPath(state.backupDestination)">打开备份路径</button>
          </div>
          <div class="checkbox-list">
            <p>勾选本次执行备份的源路径:</p>
            <label v-for="s in state.backupSources" :key="s.id">
              <input type="checkbox" :checked="state.selectedForBackup.includes(s.path)"
                     @change="toggleSelected(s.path)"/>
              <span class="chk-label">{{ s.name }}</span>
              <button type="button" class="inline-btn" @click="openPath(s.path)">打开路径</button>
            </label>
          </div>
          <div class="result" v-if="state.backupResult">
            <h4>备份结果</h4>
            <ul>
              <li v-for="item in state.backupResult.results" :key="`${item.sourceName}-${item.sourceFolder}`">
                {{ item.sourceName }} -> {{ item.success ? "成功" : "失败" }}
                <span v-if="item.error"> ({{ item.error }})</span>
              </li>
            </ul>
          </div>
          <h4>备份日志</h4>
          <div class="log-container">
            <pre class="log-content">{{ state.logContent }}</pre>
          </div>
        </section>
      </template>
    </main>
    <p class="message">{{ state.message }}</p>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  color: #1f2937;
}

.menubar-strip {
  height: 28px;
  display: flex;
  background: #f3f3f3;
  border-bottom: 1px solid #d0d0d0;
}

.menubar-item {
  border: none;
  background: transparent;
  padding: 0 14px;
  font-size: 13px;
  cursor: pointer;
}

.content {
  display: flex;
  flex: 1;
  min-height: 100vh;
}

.content.with-menubar {
  min-height: calc(100vh - 28px);
}

.inner-nav {
  width: 180px;
  border-right: 1px solid #e5e7eb;
  padding: 16px;
  background: #f8fafc;
}

.panel {
  flex: 1;
  padding: 18px;
}

button {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
}

button.active {
  background: #2563eb;
  color: #fff;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
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

.message {
  position: fixed;
  bottom: 8px;
  right: 12px;
  color: #0f766e;
}

.log-container {
  display: flex;
  width: 800px;
  height: 300px;
  overflow: auto;
}
</style>