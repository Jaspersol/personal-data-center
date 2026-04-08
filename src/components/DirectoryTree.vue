<script setup>
defineProps({
  node: {
    type: Object,
    required: true,
  },
});
</script>

<template>
  <li class="tree-node">
    <span :class="['node-name', node.type]">
      {{ node.type === "directory" ? "📁" : node.type === "missing" ? "⚠️" : "📄" }}
      {{ node.name }}
    </span>
    <ul v-if="node.children && node.children.length">
      <DirectoryTree v-for="child in node.children" :key="child.path" :node="child" />
    </ul>
  </li>
</template>

<style scoped>
.tree-node ul {
  margin-left: 16px;
}
</style>
