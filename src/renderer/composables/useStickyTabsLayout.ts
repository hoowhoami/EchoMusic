import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { useScrollContainer } from './usePageScroll';

interface SliverHeaderMetrics {
  currentHeight?: number;
}

interface StickyTabsLayoutOptions {
  collapsedHeight?: number;
}

const DEFAULT_COLLAPSED_HEIGHT = 56;

export const useStickyTabsLayout = <T extends SliverHeaderMetrics>(
  sliverHeaderRef: Ref<T | null>,
  options: StickyTabsLayoutOptions = {},
) => {
  const collapsedHeight = options.collapsedHeight ?? DEFAULT_COLLAPSED_HEIGHT;
  const scrollContainerRef = useScrollContainer();
  const scrollViewportHeight = ref(0);
  let resizeObserver: ResizeObserver | null = null;

  const tabsTop = computed(() => sliverHeaderRef.value?.currentHeight ?? collapsedHeight);

  const tabsMinHeight = computed(() => {
    if (scrollViewportHeight.value <= 0) return undefined;
    return `${Math.max(collapsedHeight, scrollViewportHeight.value - collapsedHeight)}px`;
  });

  const updateScrollViewportHeight = () => {
    scrollViewportHeight.value = scrollContainerRef.value?.clientHeight ?? 0;
  };

  const bindResizeObserver = (el: HTMLElement | null) => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    updateScrollViewportHeight();
    if (!el || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(updateScrollViewportHeight);
    resizeObserver.observe(el);
  };

  watch(scrollContainerRef, (el) => {
    bindResizeObserver(el);
  });

  onMounted(() => {
    bindResizeObserver(scrollContainerRef.value);
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  return {
    tabsTop,
    tabsMinHeight,
  };
};
