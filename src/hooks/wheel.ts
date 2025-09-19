import { onMounted, onUnmounted, ref } from 'vue';

export function useWheelScroll(options?: {
  direction?: 'down' | 'up' | 'both';
  onScroll?: (deltaY: number) => void;
  excludeSelector?: string; // 排除的选择器，在这些元素内滚动时不触发
  containerRef?: () => HTMLElement | null; // 限制监听的容器引用，只在这个元素内滚动时才触发
}) {
  const { direction = 'down', onScroll, excludeSelector, containerRef } = options || {};

  const isScrolling = ref(false);
  const scrollDirection = ref<'up' | 'down' | null>(null);
  const lastDelta = ref(0);
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;

  const handleWheel = (e: WheelEvent) => {
    // 如果指定了容器引用，检查是否在容器内滚动
    if (containerRef && e.target) {
      const container = containerRef();
      const target = e.target as HTMLElement;
      if (!container || !container.contains(target)) {
        return; // 不在指定容器内滚动，不处理
      }
    }

    // 检查是否在排除的元素内滚动
    if (excludeSelector && e.target) {
      const target = e.target as HTMLElement;
      if (target.closest(excludeSelector)) {
        return; // 在排除元素内滚动，不处理
      }
    }

    const shouldTrigger =
      direction === 'both' ||
      (direction === 'down' && e.deltaY > 0) ||
      (direction === 'up' && e.deltaY < 0);

    if (shouldTrigger && onScroll) {
      // 只在需要处理时才阻止默认行为
      e.preventDefault();

      // 更新状态
      isScrolling.value = true;
      scrollDirection.value = e.deltaY > 0 ? 'down' : 'up';
      lastDelta.value = e.deltaY;

      // 清除之前的定时器
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }

      // 设置滚动结束定时器
      scrollTimer = setTimeout(() => {
        isScrolling.value = false;
        scrollDirection.value = null;
      }, 150);

      // 使用 requestAnimationFrame 优化性能
      requestAnimationFrame(() => {
        onScroll(e.deltaY);
      });
    }
  };

  onMounted(() => {
    document.addEventListener('wheel', handleWheel, { passive: false });
  });

  onUnmounted(() => {
    document.removeEventListener('wheel', handleWheel);
    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }
  });

  return {
    isScrolling,
    scrollDirection,
    lastDelta,
  };
}