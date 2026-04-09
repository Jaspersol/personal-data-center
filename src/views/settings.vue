<script setup>
import router from "../router/index.js";

function handleSelectMenu(index) {
  router.push(index);
}
</script>

<template>
  <div class="page">
    <el-menu
        default-active="/settings/backup-setting"
        class="el-menu-vertical-demo"
        @select="handleSelectMenu"
    >
      <el-menu-item index="/settings/backup-setting">
        <template #title>
          <el-icon>
            <location/>
          </el-icon>
          <span>备份数据</span>
        </template>
      </el-menu-item>
      <el-menu-item index="">
        <el-icon>
          <icon-menu/>
        </el-icon>
        <span>Navigator Two</span>
      </el-menu-item>
    </el-menu>
    <div class="view">
      <router-view></router-view>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: row;
  width: 100vw;
  height: 100vh;
}

.view {
  margin: 20px;
  flex: 1;
  overflow: hidden;
}
</style>