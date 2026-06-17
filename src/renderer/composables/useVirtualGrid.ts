import { computed, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { useVirtualList } from './useVirtualList';

interface UseVirtualGridOptions<T extends Record<string, any>> {
  items: MaybeRefOrGetter<readonly T[]>;
  scrollContainer: Ref<HTMLElement | null>;
  loading?: MaybeRefOrGetter<boolean>;
  active?: MaybeRefOrGetter<boolean>;
  virtualThreshold?: MaybeRefOrGetter<number>;
  itemMinWidth?: MaybeRefOrGetter<number>;
  itemHeight?: MaybeRefOrGetter<number | undefined>;
  itemAspectRatio?: MaybeRefOrGetter<number>;
  itemChromeHeight?: MaybeRefOrGetter<number>;
  gap?: MaybeRefOrGetter<number>;
  overscan?: MaybeRefOrGetter<number>;
  paddingTop?: MaybeRefOrGetter<number>;
  paddingBottom?: MaybeRefOrGetter<number>;
  keyField?: MaybeRefOrGetter<Extract<keyof T, string>>;
}

interface VisibleGridItem<T> {
  item: T;
  index: number;
  row: number;
  column: number;
  key: string | number;
}

export function useVirtualGrid<T extends Record<string, any>>(options: UseVirtualGridOptions<T>) {
  const containerWidth = ref(0);
  const items = computed(() => toValue(options.items) ?? []);
  const gap = computed(() => Math.max(0, Number(toValue(options.gap) ?? 20)));
  const itemMinWidth = computed(() => Math.max(1, Number(toValue(options.itemMinWidth) ?? 180)));
  const virtualThreshold = computed(() =>
    Math.max(0, Number(toValue(options.virtualThreshold) ?? 0)),
  );
  const keyField = computed(() => toValue(options.keyField) ?? ('id' as Extract<keyof T, string>));
  const active = computed(() => toValue(options.active) ?? true);
  const loading = computed(() => toValue(options.loading) ?? false);

  const columnCount = computed(() => {
    const width = containerWidth.value;
    if (width <= 0) return 1;
    return Math.max(1, Math.floor((width + gap.value) / (itemMinWidth.value + gap.value)));
  });

  const resolvedItemWidth = computed(() => {
    const columns = columnCount.value;
    const width = containerWidth.value;
    if (width <= 0) return itemMinWidth.value;
    return Math.max(0, (width - gap.value * (columns - 1)) / columns);
  });

  const resolvedItemHeight = computed(() => {
    const explicitHeight = toValue(options.itemHeight);
    if (typeof explicitHeight === 'number' && explicitHeight > 0) return explicitHeight;
    const aspectRatio = Math.max(0.0001, Number(toValue(options.itemAspectRatio) ?? 1));
    const chromeHeight = Math.max(0, Number(toValue(options.itemChromeHeight) ?? 0));
    return resolvedItemWidth.value / aspectRatio + chromeHeight;
  });

  const rowCount = computed(() => {
    if (items.value.length === 0) return 0;
    return Math.ceil(items.value.length / columnCount.value);
  });
  const shouldVirtualize = computed(() => items.value.length > virtualThreshold.value);

  const virtualList = useVirtualList({
    itemCount: rowCount,
    itemSize: resolvedItemHeight,
    itemGap: gap,
    paddingStart: computed(() => Math.max(0, Number(toValue(options.paddingTop) ?? 0))),
    paddingEnd: computed(() => Math.max(0, Number(toValue(options.paddingBottom) ?? 0))),
    overscan: computed(() => Math.max(0, Number(toValue(options.overscan) ?? 2))),
    active,
    loading,
    scrollContainer: options.scrollContainer,
    cacheOffsets: true,
  });

  const resolveItemKey = (item: T, index: number): string | number => {
    const value = item[keyField.value];
    if (typeof value === 'string' || typeof value === 'number') return value;
    return index;
  };

  const visibleItems = computed<VisibleGridItem<T>[]>(() => {
    if (!active.value) return [];
    if (loading.value || items.value.length === 0) return [];

    if (!shouldVirtualize.value) {
      return items.value.map((item, index) => ({
        item,
        index,
        row: Math.floor(index / columnCount.value),
        column: index % columnCount.value,
        key: resolveItemKey(item, index),
      }));
    }

    const startIndex = virtualList.visibleStart.value * columnCount.value;
    const endIndex = Math.min(items.value.length, virtualList.visibleEnd.value * columnCount.value);
    if (startIndex >= endIndex) return [];

    return items.value.slice(startIndex, endIndex).map((item, offset) => {
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

  const wrapperStyle = computed(() => ({
    height: shouldVirtualize.value ? `${virtualList.totalSize.value}px` : 'auto',
    position: 'relative' as const,
  }));

  const visibleBlockStyle = computed(() => ({
    position: shouldVirtualize.value ? ('absolute' as const) : ('static' as const),
    left: '0',
    right: '0',
    top: shouldVirtualize.value ? `${Math.round(virtualList.offset.value)}px` : '0',
  }));

  const visibleGridStyle = computed(() => ({
    display: 'grid',
    gridTemplateColumns: `repeat(${columnCount.value}, minmax(0, 1fr))`,
    gap: `${gap.value}px`,
  }));

  const syncContainerWidth = (nextWidth: number) => {
    const normalizedWidth = Math.max(0, Math.round(nextWidth));
    if (normalizedWidth === containerWidth.value) return;
    containerWidth.value = normalizedWidth;
    virtualList.refresh(true);
  };

  useResizeObserver(virtualList.containerRef, (entries) => {
    const entry = entries[0];
    const nextWidth = entry?.contentRect.width ?? virtualList.containerRef.value?.clientWidth ?? 0;
    syncContainerWidth(nextWidth);
  });

  watch(
    items,
    async () => {
      if (containerWidth.value <= 0 && virtualList.containerRef.value) {
        syncContainerWidth(virtualList.containerRef.value.clientWidth);
      }
      virtualList.refresh(true);
    },
    { flush: 'post' },
  );

  const refresh = () => {
    if (virtualList.containerRef.value) {
      syncContainerWidth(virtualList.containerRef.value.clientWidth);
    }
    virtualList.refresh(true);
  };

  return {
    containerRef: virtualList.containerRef,
    columnCount,
    resolvedItemHeight,
    shouldVirtualize,
    visibleItems,
    wrapperStyle,
    visibleBlockStyle,
    visibleGridStyle,
    refresh,
  };
}
