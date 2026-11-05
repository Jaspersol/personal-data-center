<script setup>
import SideMenuLayout from "../components/side-menu-layout.vue";
</script>

<template>
  <SideMenuLayout default-active="/settings/backup-setting">
    <el-menu-item index="/settings/backup-setting">
      <template #title>
        <span class="menu-item">备份数据</span>
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
