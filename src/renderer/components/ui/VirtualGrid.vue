<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useScrollContainer } from '@/composables/usePageScroll';

interface Props {
  items: T[];
  loading?: boolean;
  active?: boolean;
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

interface VisibleGridItem {
  item: T;
  index: number;
  row: number;
  column: number;
  key: string | number;
}

defineSlots<{
  default?: (props: { item: T; index: number; row: number; column: number }) => unknown;
  loading?: () => unknown;
  empty?: () => unknown;
}>();

const containerRef = ref<HTMLElement | null>(null);
const scrollContainerRef = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
const visibleStartRow = ref(0);
const visibleEndRow = ref(0);
let measureFrame = 0;
let resizeFrame = 0;
let resizeObserver: ResizeObserver | null = null;

const columnCount = computed(() => {
  const width = containerWidth.value;
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + props.gap) / (props.itemMinWidth + props.gap)));
});

const resolvedItemWidth = computed(() => {
  const columns = columnCount.value;
  const width = containerWidth.value;
  if (width <= 0) return props.itemMinWidth;
  return Math.max(0, (width - props.gap * (columns - 1)) / columns);
});

const resolvedItemHeight = computed(() => {
  if (typeof props.itemHeight === 'number' && props.itemHeight > 0) {
    return props.itemHeight;
  }
  const aspectRatio = props.itemAspectRatio > 0 ? props.itemAspectRatio : 1;
  return resolvedItemWidth.value / aspectRatio + props.itemChromeHeight;
});

const rowStride = computed(() => resolvedItemHeight.value + props.gap);

const rowCount = computed(() => {
  if (props.items.length === 0) return 0;
  return Math.ceil(props.items.length / columnCount.value);
});

const totalHeight = computed(() => {
  if (rowCount.value === 0) return 0;
  return (
    props.paddingTop +
    props.paddingBottom +
    rowCount.value * resolvedItemHeight.value +
    Math.max(0, rowCount.value - 1) * props.gap
  );
});

const wrapperStyle = computed(() => ({
  height: `${totalHeight.value}px`,
  position: 'relative' as const,
}));

const visibleBlockStyle = computed(() => ({
  position: 'absolute' as const,
  left: '0',
  right: '0',
  top: `${props.paddingTop + visibleStartRow.value * rowStride.value}px`,
}));

const visibleGridStyle = computed(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${columnCount.value}, minmax(0, 1fr))`,
  gap: `${props.gap}px`,
}));

const stateStyle = computed(() => ({
  minHeight: `${props.stateMinHeight}px`,
}));

const resolveItemKey = (item: T, index: number): string | number => {
  if (props.keyField) {
    const value = item[props.keyField];
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  return index;
};

const visibleItems = computed<VisibleGridItem[]>(() => {
  if (!props.active || props.loading || props.items.length === 0) return [];

  const startRow = visibleStartRow.value;
  const endRow = visibleEndRow.value;
  const cols = columnCount.value;
  const startIndex = startRow * cols;
  const endIndex = Math.min(props.items.length, endRow * cols);

  if (startIndex >= endIndex) return [];

  return props.items.slice(startIndex, endIndex).map((item, offset) => {
    const index = startIndex + offset;
    return {
      item,
      index,
      row: Math.floor(index / cols),
      column: index % cols,
      key: resolveItemKey(item, index),
    };
  });
});

const injectedScrollContainer = useScrollContainer();

const getScrollContainer = (): HTMLElement | null => injectedScrollContainer.value;

// 性能优化：缓存容器尺寸与偏移，避免滚动时频繁触发 Layout Sync
const cachedOffsets = {
  listContentTop: -1,
  viewportHeight: -1,
  isDirty: true,
};

const updateVisibleRange = () => {
  const totalRows = rowCount.value;
  if (!props.active || props.loading || totalRows === 0) {
    if (visibleStartRow.value !== 0) visibleStartRow.value = 0;
    if (visibleEndRow.value !== 0) visibleEndRow.value = 0;
    return;
  }

  const scrollContainer = getScrollContainer();
  const containerEl = containerRef.value;

  if (!scrollContainer || !containerEl) {
    const fallbackEnd = Math.min(totalRows, props.overscan * 4);
    if (visibleStartRow.value !== 0) visibleStartRow.value = 0;
    if (visibleEndRow.value !== fallbackEnd) visibleEndRow.value = fallbackEnd;
    return;
  }

  // 仅在必要时测量尺寸（Layout Sync）
  if (cachedOffsets.isDirty || cachedOffsets.listContentTop < 0) {
    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    // 列表相对于滚动容器内容的绝对偏移
    cachedOffsets.listContentTop =
      containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
    cachedOffsets.viewportHeight = scrollContainer.clientHeight;
    cachedOffsets.isDirty = false;
  }

  const listTop = cachedOffsets.listContentTop;
  const listBottom = listTop + totalHeight.value;
  const viewportTop = scrollContainer.scrollTop;
  const viewportBottom = viewportTop + cachedOffsets.viewportHeight;

  if (viewportBottom <= listTop || viewportTop >= listBottom) {
    if (visibleStartRow.value !== 0) visibleStartRow.value = 0;
    if (visibleEndRow.value !== 0) visibleEndRow.value = 0;
    return;
  }

  const contentTop = listTop + props.paddingTop;
  const relativeTop = Math.max(0, viewportTop - contentTop);
  const relativeBottom = Math.max(
    0,
    Math.min(listBottom - contentTop, viewportBottom - contentTop),
  );
  const nextStart = Math.max(0, Math.floor(relativeTop / rowStride.value) - props.overscan);
  const nextEnd = Math.min(totalRows, Math.ceil(relativeBottom / rowStride.value) + props.overscan);
  const resolvedEnd = Math.max(nextStart, nextEnd);

  if (visibleStartRow.value !== nextStart) visibleStartRow.value = nextStart;
  if (visibleEndRow.value !== resolvedEnd) visibleEndRow.value = resolvedEnd;
};

const scheduleMeasure = (forceDirty = false) => {
  if (forceDirty) cachedOffsets.isDirty = true;
  if (measureFrame) cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    updateVisibleRange();
  });
};

const handleScroll = () => {
  scheduleMeasure();
};

const syncContainerWidth = (nextWidth: number) => {
  const normalizedWidth = Math.max(0, Math.round(nextWidth));
  if (normalizedWidth === containerWidth.value) return;
  containerWidth.value = normalizedWidth;
  scheduleMeasure(true);
};

const bindScrollContainer = () => {
  const nextContainer = getScrollContainer();
  if (scrollContainerRef.value === nextContainer) return;
  if (scrollContainerRef.value) {
    scrollContainerRef.value.removeEventListener('scroll', handleScroll);
  }
  scrollContainerRef.value = nextContainer;
  scrollContainerRef.value?.addEventListener('scroll', handleScroll, { passive: true });
  cachedOffsets.isDirty = true;
};

const connectResizeObserver = () => {
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (typeof ResizeObserver === 'undefined' || !containerRef.value) return;

  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    const nextWidth = entry?.contentRect.width ?? containerRef.value?.clientWidth ?? 0;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      syncContainerWidth(nextWidth);
    });
  });

  resizeObserver.observe(containerRef.value);
};

watch(
  () => props.items,
  async () => {
    await nextTick();
    scheduleMeasure(true);
  },
  { flush: 'post' },
);

watch(
  () => [props.active, props.loading],
  async ([active]) => {
    if (!active) {
      visibleStartRow.value = 0;
      visibleEndRow.value = 0;
      return;
    }
    await nextTick();
    bindScrollContainer();
    scheduleMeasure(true);
  },
  { flush: 'post' },
);

watch(columnCount, () => {
  scheduleMeasure(true);
});

// 响应注入的滚动容器变化
watch(injectedScrollContainer, () => {
  bindScrollContainer();
  scheduleMeasure(true);
});

// 修复：保存函数引用以确保 add/remove 使用同一引用
const handleResize = () => scheduleMeasure(true);

onMounted(async () => {
  await nextTick();
  bindScrollContainer();
  syncContainerWidth(containerRef.value?.clientWidth ?? 0);
  connectResizeObserver();
  window.addEventListener('resize', handleResize, { passive: true });
  scheduleMeasure(true);
});

onBeforeUnmount(() => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', handleResize);
  scrollContainerRef.value?.removeEventListener('scroll', handleScroll);
});

defineExpose({
  refresh: scheduleMeasure,
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
