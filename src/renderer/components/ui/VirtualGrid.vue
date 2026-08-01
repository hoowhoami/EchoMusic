<script setup lang="ts" generic="T extends Record<string, any>">
import { computed } from 'vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useVirtualGrid } from '@/composables/useVirtualGrid';
import Skeleton from './Skeleton.vue';

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
  loadingItemCount?: number;
  loadingVariant?: 'card' | 'compact';
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
  loadingItemCount: 8,
  loadingVariant: 'card',
});

defineSlots<{
  default?: (props: { item: T; index: number; row: number; column: number }) => unknown;
  loading?: () => unknown;
  empty?: () => unknown;
}>();

const stateStyle = computed(() => ({
  minHeight: `${props.stateMinHeight}px`,
}));

const loadingGridStyle = computed(() => ({
  minHeight: `${props.stateMinHeight}px`,
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${props.itemMinWidth}px, 1fr))`,
  gap: `${props.gap}px`,
  paddingBottom: `${props.paddingBottom}px`,
}));

const loadingCoverStyle = computed(() => ({
  aspectRatio: `${props.itemAspectRatio}`,
}));

const loadingItems = computed(() =>
  Array.from({ length: Math.max(1, props.loadingItemCount) }, (_, index) => index),
);

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
      <div :style="loadingGridStyle" class="virtual-grid-loading" aria-busy="true">
        <template v-if="props.loadingVariant === 'compact'">
          <div v-for="item in loadingItems" :key="item" class="virtual-grid-skeleton-compact">
            <Skeleton width="40px" height="40px" :radius="8" />
            <div class="virtual-grid-skeleton-compact-text">
              <Skeleton variant="text" width="68%" height="13px" />
              <Skeleton variant="text" width="42%" height="11px" />
            </div>
          </div>
        </template>
        <template v-else>
          <div v-for="item in loadingItems" :key="item" class="virtual-grid-skeleton-card">
            <div class="virtual-grid-skeleton-cover" :style="loadingCoverStyle">
              <Skeleton width="100%" height="100%" :radius="14" />
            </div>
            <div v-if="props.itemChromeHeight > 0" class="virtual-grid-skeleton-info">
              <Skeleton variant="text" width="82%" height="13px" />
              <Skeleton variant="text" width="54%" height="11px" />
            </div>
          </div>
        </template>
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

.will-change-transform {
  will-change: transform;
}

.virtual-grid-loading {
  width: 100%;
  contain: layout style;
}

.virtual-grid-skeleton-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 20px;
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-card);
}

.virtual-grid-skeleton-cover {
  width: 100%;
  overflow: hidden;
  border-radius: 14px;
}

.virtual-grid-skeleton-info {
  display: flex;
  min-height: 36px;
  flex-direction: column;
  gap: 7px;
  justify-content: center;
  margin-top: 8px;
  padding: 0 2px;
}

.virtual-grid-skeleton-compact {
  display: flex;
  min-width: 0;
  min-height: 62px;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}

.virtual-grid-skeleton-compact-text {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}
</style>
