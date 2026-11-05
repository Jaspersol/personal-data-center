<script setup>
import SideMenuLayout from "../components/side-menu-layout.vue";
</script>

<template>
  <SideMenuLayout default-active="/main-view/backup">
    <el-menu-item index="/main-view/backup">
      <template #title>
        <span class="menu-item">备份数据</span>
      </template>
    </el-menu-item>
  </SideMenuLayout>
</template>

<style scoped>
.menu-item {
  font-size: 16px;
  font-weight: bold;
  min-width: 120px;
  text-align: center;
}
</style>
