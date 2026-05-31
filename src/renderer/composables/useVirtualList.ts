import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import { useResizeObserver } from '@vueuse/core';

export interface UseVirtualListOptions {
  itemCount: MaybeRefOrGetter<number>;
  itemSize: MaybeRefOrGetter<number>;
  scrollContainer: Ref<HTMLElement | null>;
  active?: MaybeRefOrGetter<boolean>;
  loading?: MaybeRefOrGetter<boolean>;
  overscan?: MaybeRefOrGetter<number>;
  itemGap?: MaybeRefOrGetter<number>;
  paddingStart?: MaybeRefOrGetter<number>;
  paddingEnd?: MaybeRefOrGetter<number>;
  cacheOffsets?: boolean;
}

export function useVirtualList(options: UseVirtualListOptions) {
  const containerRef = ref<HTMLElement | null>(null);
  const visibleStart = ref(0);
  const visibleEnd = ref(0);

  const itemCount = computed(() => Math.max(0, Number(toValue(options.itemCount) || 0)));
  const itemSize = computed(() => Math.max(0, Number(toValue(options.itemSize) || 0)));
  const overscan = computed(() => Math.max(0, Number(toValue(options.overscan) || 0)));
  const itemGap = computed(() => Math.max(0, Number(toValue(options.itemGap) || 0)));
  const paddingStart = computed(() => Math.max(0, Number(toValue(options.paddingStart) || 0)));
  const paddingEnd = computed(() => Math.max(0, Number(toValue(options.paddingEnd) || 0)));
  const active = computed(() => toValue(options.active) ?? true);
  const loading = computed(() => toValue(options.loading) ?? false);
  const cacheOffsets = computed(() => options.cacheOffsets ?? true);

  const stride = computed(() => itemSize.value + itemGap.value);
  const contentSize = computed(() => {
    if (itemCount.value === 0) return 0;
    return itemCount.value * itemSize.value + Math.max(0, itemCount.value - 1) * itemGap.value;
  });
  const totalSize = computed(() => paddingStart.value + contentSize.value + paddingEnd.value);
  const offset = computed(() => paddingStart.value + visibleStart.value * stride.value);

  let measureFrame = 0;
  let boundContainer: HTMLElement | null = null;

  const cachedOffsets = {
    listContentTop: -1,
    viewportHeight: -1,
    isDirty: true,
  };

  const resetRange = () => {
    if (visibleStart.value !== 0) visibleStart.value = 0;
    if (visibleEnd.value !== 0) visibleEnd.value = 0;
  };

  const syncCachedOffsets = () => {
    const scrollContainer = options.scrollContainer.value;
    const containerEl = containerRef.value;
    if (!scrollContainer || !containerEl) return null;

    if (!cacheOffsets.value || cachedOffsets.isDirty || cachedOffsets.listContentTop < 0) {
      const scrollContainerRect = scrollContainer.getBoundingClientRect();
      const containerRect = containerEl.getBoundingClientRect();
      cachedOffsets.listContentTop =
        containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
      cachedOffsets.viewportHeight = scrollContainer.clientHeight;
      cachedOffsets.isDirty = false;
    }

    return {
      listContentTop: cachedOffsets.listContentTop,
      viewportHeight: cachedOffsets.viewportHeight,
    };
  };

  const updateVisibleRange = () => {
    const totalCount = itemCount.value;
    const currentItemSize = itemSize.value;
    if (!active.value || loading.value || totalCount === 0 || currentItemSize <= 0) {
      resetRange();
      return;
    }

    const scrollContainer = options.scrollContainer.value;
    const containerEl = containerRef.value;

    if (!scrollContainer || !containerEl) {
      const fallbackEnd = Math.min(totalCount, overscan.value * 4);
      if (visibleStart.value !== 0) visibleStart.value = 0;
      if (visibleEnd.value !== fallbackEnd) visibleEnd.value = fallbackEnd;
      return;
    }

    const offsets = syncCachedOffsets();
    if (!offsets) {
      resetRange();
      return;
    }

    const listTop = offsets.listContentTop;
    const listBottom = listTop + totalSize.value;
    const viewportTop = scrollContainer.scrollTop;
    const viewportBottom = viewportTop + offsets.viewportHeight;

    if (viewportBottom <= listTop || viewportTop >= listBottom) {
      resetRange();
      return;
    }

    const contentTop = listTop + paddingStart.value;
    const relativeTop = Math.max(0, viewportTop - contentTop);
    const relativeBottom = Math.max(0, Math.min(contentSize.value, viewportBottom - contentTop));
    const nextStart = Math.max(0, Math.floor(relativeTop / stride.value) - overscan.value);
    const nextEnd = Math.min(totalCount, Math.ceil(relativeBottom / stride.value) + overscan.value);
    const resolvedEnd = Math.max(nextStart, nextEnd);

    if (visibleStart.value !== nextStart) visibleStart.value = nextStart;
    if (visibleEnd.value !== resolvedEnd) visibleEnd.value = resolvedEnd;
  };

  const refresh = (forceDirty = false) => {
    if (forceDirty || !cacheOffsets.value) cachedOffsets.isDirty = true;
    if (measureFrame) cancelAnimationFrame(measureFrame);
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      updateVisibleRange();
    });
  };

  const handleScroll = () => {
    refresh(false);
  };

  const bindScrollContainer = () => {
    const nextContainer = options.scrollContainer.value;
    if (boundContainer === nextContainer) return;
    if (boundContainer) {
      boundContainer.removeEventListener('scroll', handleScroll);
    }
    boundContainer = nextContainer;
    boundContainer?.addEventListener('scroll', handleScroll, { passive: true });
    cachedOffsets.isDirty = true;
  };

  const scrollToIndex = (index: number, behavior: ScrollBehavior = 'auto') => {
    const scrollContainer = options.scrollContainer.value;
    if (!scrollContainer || !containerRef.value || index < 0) return;

    const offsets = syncCachedOffsets();
    if (!offsets) return;

    const targetTop = offsets.listContentTop + paddingStart.value + index * stride.value;
    scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior });
    refresh(false);
  };

  watch(
    () => [itemCount.value, itemSize.value, itemGap.value, paddingStart.value, paddingEnd.value],
    async () => {
      await nextTick();
      refresh(true);
    },
    { flush: 'post' },
  );

  watch(
    () => [active.value, loading.value],
    async ([nextActive]) => {
      if (!nextActive) {
        resetRange();
        return;
      }
      await nextTick();
      bindScrollContainer();
      refresh(true);
    },
    { flush: 'post' },
  );

  watch(options.scrollContainer, () => {
    bindScrollContainer();
    refresh(true);
  });

  watch(
    containerRef,
    async () => {
      await nextTick();
      cachedOffsets.isDirty = true;
      bindScrollContainer();
      refresh(true);
    },
    { flush: 'post' },
  );

  onBeforeUnmount(() => {
    if (measureFrame) cancelAnimationFrame(measureFrame);
    boundContainer?.removeEventListener('scroll', handleScroll);
  });

  useResizeObserver(containerRef, () => {
    cachedOffsets.isDirty = true;
    refresh(true);
  });

  useResizeObserver(options.scrollContainer, () => {
    cachedOffsets.isDirty = true;
    refresh(true);
  });

  return {
    containerRef,
    visibleStart,
    visibleEnd,
    stride,
    offset,
    totalSize,
    refresh,
    scrollToIndex,
  };
}
