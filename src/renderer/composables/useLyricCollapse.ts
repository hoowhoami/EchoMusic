import { ref, watch, nextTick, type ComputedRef } from 'vue';

// 写真模式歌词自动收起逻辑

interface CollapseOptions {
  hasPortraitGallery: ComputedRef<boolean>;
  settingStore: {
    lyricAutoCollapseEnabled: boolean;
    lyricAutoCollapseDelay: number;
  };
  scrollToCurrentLine: (smooth: boolean) => void;
}

export function useLyricCollapse(options: CollapseOptions) {
  const { hasPortraitGallery, settingStore, scrollToCurrentLine } = options;

  const isLyricCollapsed = ref(false);
  const wasCollapsed = ref(false);
  let collapseTimer: number | null = null;
  let wasCollapsedTimer: number | null = null;

  const clearCollapseTimer = () => {
    if (collapseTimer !== null) {
      window.clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  };

  const scheduleCollapse = () => {
    clearCollapseTimer();
    if (!hasPortraitGallery.value || !settingStore.lyricAutoCollapseEnabled) return;
    const delay = Math.max(settingStore.lyricAutoCollapseDelay || 5, 5) * 1000;
    collapseTimer = window.setTimeout(() => {
      collapseTimer = null;
      if (hasPortraitGallery.value) {
        isLyricCollapsed.value = true;
        // 等底部控制栏隐藏动画完成后再滚动
        window.setTimeout(() => {
          scrollToCurrentLine(false);
        }, 520);
      }
    }, delay);
  };

  const handleUserActivity = () => {
    if (isLyricCollapsed.value) {
      isLyricCollapsed.value = false;
      wasCollapsed.value = true;
      if (wasCollapsedTimer) window.clearTimeout(wasCollapsedTimer);
      wasCollapsedTimer = window.setTimeout(() => {
        wasCollapsed.value = false;
        wasCollapsedTimer = null;
      }, 700);
      nextTick(() => scrollToCurrentLine(true));
    }
    scheduleCollapse();
  };

  watch(
    hasPortraitGallery,
    (active) => {
      if (active) {
        scheduleCollapse();
      } else {
        clearCollapseTimer();
        isLyricCollapsed.value = false;
      }
    },
    { immediate: true },
  );

  watch(
    () => settingStore.lyricAutoCollapseDelay,
    () => {
      if (hasPortraitGallery.value && !isLyricCollapsed.value) {
        scheduleCollapse();
      }
    },
  );

  watch(
    () => settingStore.lyricAutoCollapseEnabled,
    (enabled) => {
      if (enabled) {
        scheduleCollapse();
      } else {
        clearCollapseTimer();
        if (isLyricCollapsed.value) {
          isLyricCollapsed.value = false;
          wasCollapsed.value = true;
          if (wasCollapsedTimer) window.clearTimeout(wasCollapsedTimer);
          wasCollapsedTimer = window.setTimeout(() => {
            wasCollapsed.value = false;
            wasCollapsedTimer = null;
          }, 700);
          nextTick(() => scrollToCurrentLine(true));
        }
      }
    },
  );

  const dispose = () => {
    clearCollapseTimer();
    if (wasCollapsedTimer) window.clearTimeout(wasCollapsedTimer);
  };

  return {
    isLyricCollapsed,
    wasCollapsed,
    scheduleCollapse,
    handleUserActivity,
    dispose,
  };
}
