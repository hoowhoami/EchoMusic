<script setup lang="ts">
import { TabsList, type TabsListProps, useForwardProps } from 'reka-ui';

const props = withDefaults(
  defineProps<TabsListProps & { class?: string; variant?: 'default' | 'equal' }>(),
  { variant: 'default' },
);
const forwardedProps = useForwardProps(props);
</script>

<template>
  <TabsList
    v-bind="forwardedProps"
    :class="[variant === 'equal' ? 'tabs-list-equal' : 'flex items-center gap-3 h-9', props.class]"
  >
    <slot />
  </TabsList>
</template>

<style scoped>
@reference "@/style.css";

.tabs-list-equal {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  flex: 0 0 auto;
  gap: 4px;
  min-width: 0;
  border-bottom: 1px solid var(--control-border);
}

.tabs-list-equal :deep(.tab-trigger) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  height: var(--underline-tab-height, 36px);
  padding: 0 2px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.tabs-list-equal :deep(.tab-trigger:hover),
.tabs-list-equal :deep(.tab-trigger[data-state='active']),
.tabs-list-equal :deep(.tab-trigger[data-highlighted='true']) {
  color: var(--color-primary-text);
}

.tabs-list-equal :deep(.tab-trigger[data-state='active']) {
  border-bottom-color: var(--color-primary);
}

.tabs-list-equal :deep(.active-line) {
  display: none;
}

.tabs-list-equal :deep(.tab-trigger:focus-visible) {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  border-radius: var(--radius-item);
}
</style>
