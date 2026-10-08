<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
import PluginSourceInfo from './PluginSourceInfo.vue';

defineProps<{ id: string; sourceName: string }>();
</script>

<template>
  <div class="plugin-card-origin">
    <Tooltip :content="id" overflow-only>
      <template #trigger>
        <div class="plugin-card-id">ID: {{ id }}</div>
      </template>
    </Tooltip>
    <PluginSourceInfo :name="sourceName" />
  </div>
</template>

<style scoped>
.plugin-card-origin {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.plugin-card-id {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-card-origin :deep(.plugin-source-info) {
  flex: 0 1 auto;
  max-width: 55%;
  margin-left: auto;
  justify-content: flex-end;
}
</style>
