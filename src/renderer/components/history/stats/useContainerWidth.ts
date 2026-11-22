import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * 测量元素的渲染宽度（ResizeObserver）。
 *
 * 听歌统计的响应式断点全部按「统计内容自身宽度」驱动，
 * 对齐 EchoMusicNext 以页面/导出视口宽度判断的行为，
 * 侧栏收窄、窗口缩放时区块布局与源版一致。
 */
export const useContainerWidth = (target: Ref<HTMLElement | null>) => {
  const width = ref(0);
  let observer: ResizeObserver | null = null;

  watch(
    target,
    (el) => {
      observer?.disconnect();
      if (!el) return;
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) width.value = entry.contentRect.width;
      });
      observer.observe(el);
    },
    { immediate: true, flush: 'post' },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return width;
};
