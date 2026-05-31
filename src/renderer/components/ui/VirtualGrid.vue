<script setup lang="ts" generic="T extends Record<string, any>">
import { computed } from 'vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useVirtualGrid } from '@/composables/useVirtualGrid';

interface Props {
  items: T[];
  loading?: boolean;
  active?: boolean;
  virtualThreshold?: number;
  loadingText?: string;
  emptyText?: string;
  stateMinHeight?: number;
  itemMinWidth?: number;
  itemHeight?: number;
  itemAspectRatio?: number;
  itemChromeHeight?: number;
  gap?: number;
  overscan?: number;
  paddingTop?: number;
  paddingBottom?: number;
  keyField?: Extract<keyof T, string>;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  active: true,
  virtualThreshold: 48,
  loadingText: '加载中...',
  emptyText: '暂无内容',
  stateMinHeight: 240,
  itemMinWidth: 180,
  itemHeight: undefined,
  itemAspectRatio: 1,
  itemChromeHeight: 0,
  gap: 20,
  overscan: 2,
  paddingTop: 0,
  paddingBottom: 0,
  keyField: 'id' as Extract<keyof T, string>,
});

defineSlots<{
  default?: (props: { item: T; index: number; row: number; column: number }) => unknown;
  loading?: () => unknown;
  empty?: () => unknown;
}>();

const stateStyle = computed(() => ({
  minHeight: `${props.stateMinHeight}px`,
}));

const injectedScrollContainer = useScrollContainer();
const virtualGrid = useVirtualGrid<T>({
  items: computed(() => props.items),
  scrollContainer: injectedScrollContainer,
  loading: computed(() => props.loading),
  active: computed(() => props.active),
  virtualThreshold: computed(() => props.virtualThreshold),
  itemMinWidth: computed(() => props.itemMinWidth),
  itemHeight: computed(() => props.itemHeight),
  itemAspectRatio: computed(() => props.itemAspectRatio),
  itemChromeHeight: computed(() => props.itemChromeHeight),
  gap: computed(() => props.gap),
  overscan: computed(() => props.overscan),
  paddingTop: computed(() => props.paddingTop),
  paddingBottom: computed(() => props.paddingBottom),
  keyField: props.keyField,
});
const {
  containerRef,
  visibleItems,
  wrapperStyle,
  visibleBlockStyle,
  visibleGridStyle,
  resolvedItemHeight,
} = virtualGrid;

defineExpose({
  refresh: virtualGrid.refresh,
});
</script>

<template>
  <div ref="containerRef" class="virtual-grid">
    <div
      v-if="!props.loading && props.items.length > 0"
      :style="wrapperStyle"
      class="virtual-grid-wrapper"
    >
      <div :style="visibleBlockStyle" class="will-change-transform">
        <div :style="visibleGridStyle" class="virtual-grid-inner">
          <div
            v-for="entry in visibleItems"
            :key="entry.key"
            class="virtual-grid-item"
            :style="{ minHeight: `${resolvedItemHeight}px` }"
          >
            <slot :item="entry.item" :index="entry.index" :row="entry.row" :column="entry.column" />
          </div>
        </div>
      </div>
    </div>

    <slot v-else-if="props.loading" name="loading">
      <div :style="stateStyle" class="virtual-grid-state">
        <div class="virtual-grid-spinner" aria-hidden="true"></div>
        <div class="virtual-grid-state-text">{{ props.loadingText }}</div>
      </div>
    </slot>
    <slot v-else-if="props.items.length === 0" name="empty">
      <div :style="stateStyle" class="virtual-grid-state virtual-grid-state--empty">
        <div class="virtual-grid-state-text">{{ props.emptyText }}</div>
      </div>
    </slot>
  </div>
</template>

<style scoped>
.virtual-grid {
  width: 100%;
  contain: layout style;
}

.virtual-grid-wrapper {
  width: 100%;
}

.virtual-grid-inner {
  width: 100%;
}

.virtual-grid-item {
  min-width: 0;
  contain: layout style;
  background: transparent;
}

.virtual-grid-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

.virtual-grid-state--empty {
  color: color-mix(in srgb, var(--color-text-main) 45%, transparent);
}

.virtual-grid-state-text {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  font-size: 14px;
  font-weight: 500;
  color: color-mix(in srgb, var(--color-text-main) 45%, transparent);
}

.virtual-grid-spinner {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 4px solid var(--color-primary);
  border-top-color: transparent;
  animation: virtual-grid-spin 0.7s linear infinite;
}

@keyframes virtual-grid-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.will-change-transform {
  will-change: transform;
}
</style>
