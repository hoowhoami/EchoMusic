import { ref, watch, nextTick, type Ref } from 'vue';
import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';

/**
 * 歌词滚动逻辑
 * - 自动跟随当前播放行
 * - 用户滚轮滚动时暂停跟随
 * - 滚动结束后自动高亮对应时间行并恢复跟随
 */
export function useLyricScroll(lyricListRef: () => HTMLElement | null, collapsed?: Ref<boolean>) {
  const lyricStore = useLyricStore();
  const playerStore = usePlayerStore();

  const isUserScrolling = ref(false);
  const scrollHighlightIndex = ref(-1); // 滚轮停止后高亮的行索引
  let userScrollResumeTimer: number | null = null;
  let scrollEndTimer: number | null = null;

  const clearUserScrollTimer = () => {
    if (userScrollResumeTimer !== null) {
      window.clearTimeout(userScrollResumeTimer);
      userScrollResumeTimer = null;
    }
  };

  const clearScrollEndTimer = () => {
    if (scrollEndTimer !== null) {
      window.clearTimeout(scrollEndTimer);
      scrollEndTimer = null;
    }
  };

  const scrollToLine = (index: number, smooth: boolean, collapsed = false) => {
    const container = lyricListRef();
    if (!container || index < 0) return;

    const target = container.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
    if (!target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    if (collapsed) {
      // 收起模式：将当前行和下一行定位到容器底部
      const nextTarget = container.querySelector<HTMLElement>(`[data-lyric-index="${index + 1}"]`);
      const twoLineHeight = nextTarget
        ? nextTarget.getBoundingClientRect().bottom - targetRect.top
        : targetRect.height;
      const bottomMargin = 24;
      const offset =
        targetRect.top -
        containerRect.top +
        container.scrollTop -
        container.clientHeight +
        twoLineHeight +
        bottomMargin;
      container.scrollTo({ top: Math.max(0, offset), behavior: smooth ? 'smooth' : 'auto' });
      return;
    }

    const anchorRatio = 0.42;
    const offset =
      targetRect.top -
      containerRect.top +
      container.scrollTop -
      container.clientHeight * anchorRatio +
      targetRect.height / 2;
    container.scrollTo({ top: Math.max(0, offset), behavior: smooth ? 'smooth' : 'auto' });
  };

  // 根据当前滚动位置找到对应的歌词行
  const findLineAtScrollPosition = (): number => {
    const container = lyricListRef();
    if (!container) return -1;

    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height * 0.42;

    // 找到最接近中心的歌词行
    const lines = Array.from(container.querySelectorAll<HTMLElement>('[data-lyric-index]'));
    let closestIndex = -1;
    let closestDistance = Infinity;

    for (const line of lines) {
      const rect = line.getBoundingClientRect();
      const lineCenter = rect.top + rect.height / 2;
      const distance = Math.abs(lineCenter - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = parseInt(line.dataset.lyricIndex || '-1', 10);
      }
    }

    return closestIndex;
  };

  let scrollRafPending = false;

  const handleWheel = () => {
    if (lyricStore.lines.length === 0) return;
    isUserScrolling.value = true;

    // 清除之前的定时器
    clearUserScrollTimer();

    // 用 rAF 节流：每帧最多计算一次中心行
    if (!scrollRafPending) {
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        const index = findLineAtScrollPosition();
        if (index >= 0) {
          scrollHighlightIndex.value = index;
        }
      });
    }

    // 5 秒后恢复自动跟随
    userScrollResumeTimer = window.setTimeout(() => {
      userScrollResumeTimer = null;
      isUserScrolling.value = false;
      scrollHighlightIndex.value = -1;
      scrollToLine(lyricStore.currentIndex, true);
    }, 5000);
  };

  // 监听歌词行变化，自动滚动
  watch(
    () => lyricStore.currentIndex,
    async (index, previous) => {
      if (index === previous) return;
      // 如果用户正在滚动，不自动跟随
      if (isUserScrolling.value) return;
      await nextTick();
      scrollToLine(index, previous !== -1, collapsed?.value ?? false);
    },
  );

  // 切歌时重置
  watch(
    () => playerStore.currentTrackSnapshot?.id,
    () => {
      isUserScrolling.value = false;
      scrollHighlightIndex.value = -1;
      clearUserScrollTimer();
      clearScrollEndTimer();
      nextTick(() => scrollToLine(lyricStore.currentIndex, false));
    },
  );

  const dispose = () => {
    clearUserScrollTimer();
    clearScrollEndTimer();
  };

  return {
    isUserScrolling,
    scrollHighlightIndex,
    scrollToLine,
    handleWheel,
    dispose,
  };
}
