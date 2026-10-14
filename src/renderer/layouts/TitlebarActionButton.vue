<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import type { ResolvedTitlebarAction } from '@/plugins/titlebar';
defineProps<{ action: ResolvedTitlebarAction; badge?: boolean }>();
</script>

<template>
  <Button
    variant="unstyled"
    size="icon"
    class="action-icon titlebar-icon-action titlebar-action no-drag"
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
  flex: 0 0 var(--button-height);
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
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
