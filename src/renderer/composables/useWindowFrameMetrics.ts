import { computed, onMounted, onUnmounted, ref } from 'vue';

type WindowFrameMetrics = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  isMaximized: boolean;
  isFullScreen: boolean;
  scaleFactor: number;
};

const DEFAULT_METRICS: WindowFrameMetrics = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  isMaximized: false,
  isFullScreen: false,
  scaleFactor: 1,
};

export const useWindowFrameMetrics = () => {
  const metrics = ref<WindowFrameMetrics>(DEFAULT_METRICS);
  const isWindows = window.electron.platform === 'win32';
  let cleanup: (() => void) | null = null;

  const refresh = async () => {
    if (!isWindows || !window.electron.windowFrame) return;
    try {
      metrics.value = await window.electron.windowFrame.getMetrics();
    } catch {
      metrics.value = DEFAULT_METRICS;
    }
  };

  onMounted(() => {
    if (!isWindows || !window.electron.windowFrame) return;
    void refresh();
    cleanup = window.electron.windowFrame.onMetrics((nextMetrics) => {
      metrics.value = nextMetrics;
    });
  });

  onUnmounted(() => {
    cleanup?.();
    cleanup = null;
  });

  const controlRightInset = computed(() => {
    if (!isWindows) return 0;
    return Math.max(0, Math.ceil(metrics.value.right));
  });

  return {
    metrics,
    controlRightInset,
    refresh,
  };
};
