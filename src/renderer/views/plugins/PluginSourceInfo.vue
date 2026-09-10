<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';

defineProps<{ name: string }>();
</script>

<template>
  <span class="plugin-source-info">
    <Tooltip :content="name" overflow-only>
      <template #trigger>
        <span class="plugin-source-name">{{ name }}</span>
      </template>
    </Tooltip>
  </span>
</template>

<style scoped>
.plugin-source-info {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 7px;
  border-radius: 5px;
  border: 1px solid var(--border-subtle);
  background: var(--control-muted-bg);
  min-width: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
  font-weight: 500;
}
.plugin-source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
