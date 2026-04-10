<script setup>
import router from "../router/index.js";

function handleSelectMenu(index) {
  router.push(index);
}
</script>

<template>
  <div class="page">
    <el-menu
        default-active="/main-view/backup"
        class="el-menu-vertical-demo"
        @select="handleSelectMenu"
    >
      <el-menu-item index="/main-view/backup">
        <template #title>
          <span class="menu-item">备份数据</span>
        </template>
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

.menu-item {
  font-size: 16px;
  font-weight: bold;
  min-width: 120px;
  text-align: center;
}
</style>