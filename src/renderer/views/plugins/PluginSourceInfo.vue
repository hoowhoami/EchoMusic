<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';

defineProps<{ name: string }>();
</script>

<template>
  <div class="plugin-source-info">
    <span class="plugin-source-label">来源:</span>
    <Tooltip :content="name" overflow-only>
      <template #trigger>
        <span
          class="plugin-source-name"
          v-text="name === '未记录来源' ? '未记录' : name === '未知来源' ? '未知' : name.trim()"
        />
      </template>
    </Tooltip>
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
}
.plugin-source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
