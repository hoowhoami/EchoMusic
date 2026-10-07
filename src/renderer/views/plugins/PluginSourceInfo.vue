<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
import Tag from '@/components/ui/Tag.vue';

defineProps<{ name: string }>();
</script>

<template>
  <Tag size="sm" tone="muted" class="plugin-source-info">
    <Tooltip :content="name" overflow-only>
      <template #trigger>
        <span class="plugin-source-name">{{ name }}</span>
      </template>
    </Tooltip>
  </Tag>
</template>

<style scoped>
.plugin-source-info {
  flex: 0 1 auto;
  max-width: 100%;
  min-width: 0;
}
.plugin-source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
