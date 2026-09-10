<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import type { ResolvedTitlebarAction } from '@/plugins/titlebar';
defineProps<{ action: ResolvedTitlebarAction; badge?: boolean }>();
</script>

<template>
  <Button
    variant="unstyled"
    size="none"
    class="titlebar-action no-drag"
    :tooltip="action.tooltip"
    tooltip-side="bottom"
    :aria-label="action.title"
    :aria-busy="action.isBusy"
    :disabled="action.isDisabled"
    @click="action.onClick()"
  >
    <PluginIcon :icon="action.icon" :width="18" :height="18" />
    <span v-if="badge" class="action-badge" />
  </Button>
</template>

<style scoped>
.titlebar-action {
  position: relative;
  display: flex;
  flex: 0 0 34px;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--color-text-secondary);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.titlebar-action:hover {
  background: var(--control-hover-bg);
  color: var(--color-text-main);
}
.action-badge {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-primary);
}
</style>
