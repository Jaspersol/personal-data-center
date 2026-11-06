<script setup>
import { computed, onMounted, onUnmounted, reactive } from "vue";
import { ElMessage } from "element-plus";
import {
  loadSettingsFromIdb,
  notifySettingsChanged,
  saveSettingsToIdb,
  subscribeSettingsChanges,
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
  const seenNames = new Set();
  for (const s of state.backupSources) {
    if (!String(s.name || "").trim()) return ElMessage.warning("请填写名称");
    if (!String(s.path || "").trim()) return ElMessage.warning("请选择文件夹路径");
    // 归档名由备份名称决定，重名会生成无法区分的压缩包，保存前先拦截
    const nameKey = String(s.name).trim().toLowerCase();
    if (seenNames.has(nameKey)) {
      return ElMessage.warning(`备份名称重复：${String(s.name).trim()}，请修改后再保存`);
    }
    seenNames.add(nameKey);
  }
  try {
    await saveSettingsToIdb({
      backupDestination: state.backupDestination,
      backupSources: state.backupSources,
    });
  } catch (error) {
    // 主配置已写入但副本失败时按“部分保存”提示，不能笼统报“保存失败”
    if (error.partial) {
      ElMessage.warning(error.message || "设置已保存，但同步副本未写入");
    } else {
      ElMessage.error(`保存失败：${error.message || error}`);
    }
    return;
  }
  notifySettingsChanged();
  ElMessage.success("设置已保存");
}

/**
 * 取路径最后一级目录名，作为新增备份项的默认名称
 * @param {string} pathValue 绝对路径
 * @returns {string} 目录名，取不到时返回「备份项」
 */
function folderBaseName(pathValue) {
  return (
    String(pathValue || "")
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() || "备份项"
  );
}

async function addBackupSource() {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  state.backupSources.push({
    id: crypto.randomUUID(),
    name: folderBaseName(folder),
    path: folder,
  });
}

async function pickPathForSource(entry) {
  if (!hasApi.value) return;
  const folder = await window.backupApi.selectFolder();
  if (!folder) return;
  // 名称仍是旧路径自动推导出的默认值时跟随新路径更新；用户手改过的名称保持不变
  const nameIsAuto = !entry.name || entry.name === folderBaseName(entry.path);
  entry.path = folder;
  if (nameIsAuto) entry.name = folderBaseName(folder);
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

let unsubscribeSettings = () => {};

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
    <!-- prettier-ignore -->
    <div class="load-position"><strong>备份存放路径:</strong>&nbsp;<div>{{ state.backupDestination || "未设置" }}</div></div>
    <el-button size="small" @click="openPath(state.backupDestination)">打开路径</el-button>
  </div>
  <div class="setting-container">
    <el-card class="settings-card">
      <ul class="folder-list">
        <li v-if="state.backupSources.length === 0" class="empty-hint">
          尚未添加被备份项，点击上方「添加被备份项」选择要备份的文件夹。
        </li>
        <li v-for="s in state.backupSources" :key="s.id">
          <div class="source-row">
            <el-input v-model="s.name" type="text" placeholder="备份名称（必填）" />
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

.folder-list li.empty-hint {
  border-style: dashed;
  color: #6b7280;
  font-size: 13px;
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
