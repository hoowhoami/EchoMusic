<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

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
  scrollTargetSelector?: string;
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
  scrollTargetSelector: '.view-port',
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

  const startIndex = visibleStartRow.value * columnCount.value;
  const endIndex = Math.min(props.items.length, visibleEndRow.value * columnCount.value);

  return props.items.slice(startIndex, endIndex).map((item, offset) => {
    const index = startIndex + offset;
    return {
      item,
      index,
      row: Math.floor(index / columnCount.value),
      column: index % columnCount.value,
      key: resolveItemKey(item, index),
    };
  });
});

const getScrollContainer = (): HTMLElement | null =>
  props.scrollTargetSelector
    ? (document.querySelector(props.scrollTargetSelector) as HTMLElement | null)
    : null;

const updateVisibleRange = () => {
  const totalRows = rowCount.value;
  if (!props.active || props.loading || totalRows === 0) {
    visibleStartRow.value = 0;
    visibleEndRow.value = 0;
    return;
  }

  const scrollContainer = scrollContainerRef.value ?? getScrollContainer();
  const containerEl = containerRef.value;

  if (!scrollContainer || !containerEl) {
    visibleStartRow.value = 0;
    visibleEndRow.value = Math.min(totalRows, props.overscan * 4);
    return;
  }

  const scrollContainerRect = scrollContainer.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  const listTop = containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
  const listBottom = listTop + totalHeight.value;
  const viewportTop = scrollContainer.scrollTop;
  const viewportBottom = viewportTop + scrollContainer.clientHeight;

  if (viewportBottom <= listTop || viewportTop >= listBottom) {
    visibleStartRow.value = 0;
    visibleEndRow.value = 0;
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

  visibleStartRow.value = nextStart;
  visibleEndRow.value = Math.max(nextStart, nextEnd);
};

const scheduleMeasure = () => {
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
  scheduleMeasure();
};

const bindScrollContainer = () => {
  const nextContainer = getScrollContainer();
  if (scrollContainerRef.value === nextContainer) return;
  if (scrollContainerRef.value) {
    scrollContainerRef.value.removeEventListener('scroll', handleScroll);
  }
  scrollContainerRef.value = nextContainer;
  scrollContainerRef.value?.addEventListener('scroll', handleScroll, { passive: true });
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
    scheduleMeasure();
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
    scheduleMeasure();
  },
  { flush: 'post' },
);

watch(columnCount, () => {
  scheduleMeasure();
});

onMounted(async () => {
  await nextTick();
  bindScrollContainer();
  syncContainerWidth(containerRef.value?.clientWidth ?? 0);
  connectResizeObserver();
  window.addEventListener('resize', scheduleMeasure, { passive: true });
  scheduleMeasure();
});

onBeforeUnmount(() => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', scheduleMeasure);
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
      <div :style="visibleBlockStyle">
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
}

.virtual-grid-wrapper {
  width: 100%;
}

.virtual-grid-inner {
  width: 100%;
}

.virtual-grid-item {
  min-width: 0;
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
</style>
