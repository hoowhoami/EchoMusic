<script setup lang="ts">
import { vTooltip } from '@/components/ui/tooltip';
defineProps<{ name: string }>();
</script>

<template>
  <div class="plugin-source-info">
    <span class="plugin-source-label" v-text="'来源: '" />
    <span
      v-tooltip="{ content: name, overflowOnly: true }"
      class="plugin-source-name"
      v-text="name === '未记录来源' ? '未记录' : name === '未知来源' ? '未知' : name.trim()"
    />
  </div>
</template>

<style scoped>
.plugin-source-info {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.plugin-source-label {
  flex-shrink: 0;
  white-space: pre;
}
.plugin-source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
