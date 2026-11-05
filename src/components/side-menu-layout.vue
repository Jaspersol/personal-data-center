<script setup>
import router from "../router/index.js";

defineProps({
  // 侧边菜单默认选中项，取当前视图的主路由
  defaultActive: {
    type: String,
    required: true,
  },
});

function handleSelectMenu(index) {
  router.push(index);
}
</script>

<template>
  <div class="page">
    <el-menu
      :default-active="defaultActive"
      class="el-menu-vertical-demo"
      @select="handleSelectMenu"
    >
      <slot></slot>
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
