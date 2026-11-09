<script setup>
import { computed, onMounted, onUnmounted, reactive } from "vue";
import { ElMessage } from "element-plus";

const hasApi = computed(() => typeof window !== "undefined" && !!window.updateApi);

const state = reactive({
  currentVersion: "",
  autoCheck: true,
  checking: false,
  installing: false,
  checkError: "",
  installError: "",
  updateInfo: null,
  progress: null,
});

const percent = computed(() => {
  if (!state.progress) return null;
  const { downloaded, total } = state.progress;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
});

function messageOf(error) {
  return (error && error.message) || String(error);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function formatBytes(value) {
  const size = Number(value) || 0;
  return size > 0 ? `${(size / 1024 / 1024).toFixed(1)} MB` : "";
}

async function checkUpdate() {
  if (!hasApi.value) return;
  state.checking = true;
  state.checkError = "";
  state.installError = "";
  try {
    const info = await window.updateApi.check();
    state.updateInfo = info;
    if (!info.has_update) ElMessage.success("当前已是最新版本");
  } catch (error) {
    state.updateInfo = null;
    state.checkError = messageOf(error);
  } finally {
    state.checking = false;
  }
}

async function installUpdate() {
  if (!hasApi.value || !state.updateInfo?.download_url || !state.updateInfo?.sha256) return;
  state.installing = true;
  state.installError = "";
  state.progress = { downloaded: 0, total: state.updateInfo.asset_size };
  try {
    await window.updateApi.install();
  } catch (error) {
    state.installing = false;
    state.progress = null;
    state.installError = messageOf(error);
    ElMessage.error(state.installError);
  }
}

async function openReleasePage() {
  if (!hasApi.value || !state.updateInfo?.release_url) return;
  try {
    await window.updateApi.openReleasePage(state.updateInfo.release_url);
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function changeAutoCheck(value) {
  if (!hasApi.value) return;
  try {
    const saved = await window.updateApi.setAutoCheck(value);
    state.autoCheck = saved;
  } catch (error) {
    state.autoCheck = !value;
    ElMessage.error(messageOf(error));
  }
}

let offProgress = () => {};
let offCheckResult = () => {};

onMounted(async () => {
  if (!hasApi.value) {
    ElMessage.warning("当前不是 Electron 环境，请启动客户端。");
    return;
  }
  offProgress = window.updateApi.onProgress((payload) => {
    state.progress = payload;
  });
  // 启动自动检查的结果也走这里，窗口后开时 lastResult() 兜底。
  offCheckResult = window.updateApi.onCheckResult((info) => {
    state.updateInfo = info;
    state.checkError = "";
    state.installError = "";
  });
  try {
    state.currentVersion = await window.updateApi.getVersion();
  } catch {
    /* 版本未知时显示占位 */
  }
  try {
    state.autoCheck = await window.updateApi.getAutoCheck();
  } catch {
    /* 保持默认开启 */
  }
  try {
    const info = await window.updateApi.lastResult();
    if (info && !state.updateInfo) state.updateInfo = info;
  } catch {
    /* 没有缓存结果时等待用户手动检查 */
  }
});

onUnmounted(() => {
  offProgress();
  offCheckResult();
});
</script>

<template>
  <el-card class="update-card" shadow="never">
    <template #header>
      <div class="card-header">
        <span class="card-title">关于与更新</span>
        <el-button
          size="small"
          :loading="state.checking"
          :disabled="state.installing"
          @click="checkUpdate"
        >
          {{ state.checking ? "检查中…" : "检查更新" }}
        </el-button>
      </div>
    </template>

    <div class="about-row">
      <div class="app-name">
        PersonalDataCenter
        <el-tag size="small" type="info">v{{ state.currentVersion || "—" }}</el-tag>
      </div>
      <div class="muted">更新来自 GitHub Releases（Jaspersol/personal-data-center）</div>
    </div>

    <div class="auto-row">
      <span>启动时自动检查更新（最多每 6 小时一次）</span>
      <el-switch v-model="state.autoCheck" :disabled="!hasApi" @change="changeAutoCheck" />
    </div>
    <p class="muted hint">
      仅提示，不自动下载。检查优先使用 GitHub API；API 受限或不可达时自动切换为直链方案。
    </p>

    <el-alert
      v-if="state.checkError"
      class="block"
      type="error"
      :closable="false"
      :title="state.checkError"
    />

    <div v-if="state.installing" class="update-box">
      <div class="update-line">
        <span class="dot"></span>
        {{
          percent === null
            ? "正在下载更新包…"
            : percent >= 100
              ? "下载完成，正在安装…"
              : `正在下载更新包 ${percent}%`
        }}
      </div>
      <el-progress :percentage="percent ?? 8" :show-text="false" />
      <p class="muted hint">安装程序启动后应用会自动退出，并在安装完成后重新打开。</p>
    </div>

    <div v-else-if="state.updateInfo && state.updateInfo.has_update" class="update-box">
      <div class="update-line">
        <span class="dot"></span>
        发现新版本 v{{ state.updateInfo.latest_version }}
        <span v-if="formatDate(state.updateInfo.published_at)" class="muted">
          · {{ formatDate(state.updateInfo.published_at) }}
        </span>
      </div>
      <pre v-if="state.updateInfo.notes" class="release-notes">{{ state.updateInfo.notes }}</pre>
      <div class="actions">
        <el-button
          type="primary"
          size="small"
          :disabled="!state.updateInfo.download_url || !state.updateInfo.sha256"
          @click="installUpdate"
        >
          下载并安装
        </el-button>
        <el-button v-if="state.updateInfo.release_url" size="small" @click="openReleasePage">
          在 GitHub 查看
        </el-button>
        <span v-if="state.updateInfo.asset_size" class="muted">
          {{ formatBytes(state.updateInfo.asset_size) }}
        </span>
      </div>
      <el-alert
        v-if="!state.updateInfo.sha256"
        class="block"
        type="warning"
        :closable="false"
        title="该版本未提供 SHA256 校验文件，无法自动安装；请在 GitHub Release 页面手动下载。"
      />
      <el-alert
        v-if="state.installError"
        class="block"
        type="error"
        :closable="false"
        :title="state.installError"
      >
        下载失败时可直接从 GitHub Release 页面手动下载安装包。
      </el-alert>
    </div>

    <div v-else-if="state.updateInfo" class="update-box">
      当前已是最新版本 v{{ state.updateInfo.current_version }}
    </div>
  </el-card>
</template>

<style scoped>
.update-card {
  max-width: 760px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
}

.about-row {
  margin-bottom: 18px;
}

.app-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.auto-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.muted {
  color: #6b7280;
  font-size: 12px;
}

.hint {
  margin: 6px 0 16px;
  line-height: 1.6;
}

.block {
  margin-bottom: 16px;
}

.update-box {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 14px;
}

.update-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 12px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #67c23a;
}

.release-notes {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f9fafb;
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  margin: 0 0 14px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
