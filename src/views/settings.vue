<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import SideMenuLayout from "../components/side-menu-layout.vue";

const route = useRoute();
// 菜单高亮跟随当前路由：从「关于与更新」菜单直接打开窗口时也要落在正确项上。
const activeMenu = computed(() => route.path);
</script>

<template>
  <SideMenuLayout :default-active="activeMenu">
    <el-menu-item index="/settings/backup-setting">
      <template #title>
        <span class="menu-item">备份数据</span>
      </template>
    </el-menu-item>
    <el-menu-item index="/settings/update">
      <template #title>
        <span class="menu-item">关于与更新</span>
      </template>
    </el-menu-item>
  </SideMenuLayout>
</template>

<style scoped>
.menu-item {
  min-width: 80px;
  text-align: center;
}
</style>
