<script setup lang="ts">
import { ref, useSlots } from 'vue';
import Button from './Button.vue';
import { iconX } from '@/icons';

withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    closeLabel?: string;
    closeDisabled?: boolean;
  }>(),
  { title: '', description: '', closeLabel: '关闭', closeDisabled: false },
);

const emit = defineEmits<{ close: [] }>();
const slots = useSlots();
const headerRef = ref<HTMLElement | null>(null);
defineExpose({
  focusClose: () =>
    headerRef.value
      ?.querySelector<HTMLButtonElement>('.drawer-close')
      ?.focus({ preventScroll: true }),
});
</script>

<template>
  <header ref="headerRef" class="drawer-header">
    <div v-if="slots.leading" class="drawer-header-leading"><slot name="leading" /></div>
    <div class="drawer-header-copy">
      <div class="drawer-header-title-line">
        <slot name="title"
          ><h2 class="drawer-title">{{ title }}</h2></slot
        >
      </div>
      <div v-if="description || slots.description" class="drawer-header-description">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div class="drawer-header-controls">
      <slot name="actions" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="action-icon drawer-close"
        :aria-label="closeLabel"
        :disabled="closeDisabled"
        @click="emit('close')"
      >
        <Icon :icon="iconX" width="14" height="14" />
      </Button>
    </div>
  </header>
</template>

<style scoped>
.drawer-header {
  --button-height: var(--control-height-compact);
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: var(--drawer-header-padding, 16px 24px 14px);
}

.drawer-header-leading {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  align-self: center;
}

.drawer-header-copy {
  flex: 1;
  min-width: 0;
}

.drawer-header-title-line {
  display: flex;
  align-items: center;
  min-height: var(--control-height-compact);
  min-width: 0;
  overflow-wrap: anywhere;
}

.drawer-title {
  margin: 0;
  color: var(--color-text-main);
  font-size: 16px;
  font-weight: 600;
  line-height: var(--control-height-compact);
  overflow-wrap: anywhere;
}

.drawer-header-description {
  min-width: 0;
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.drawer-header-controls {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}
</style>
