<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { iconCheckMark } from '@/icons';
</script>

<template>
  <span class="selection-badge selection-mark-surface" aria-hidden="true">
    <Icon :icon="iconCheckMark" :width="14" :height="14" />
  </span>
</template>

<style scoped>
.selection-badge {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-detail);
}
</style>
