import { onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 通过 JS 实现窗口拖动，替代不可靠的 CSS -webkit-app-region: drag
 *
 * 原理：渲染进程监听 mousedown/mouseup 通知主进程拖动开始/结束，
 * 主进程通过 screen.getCursorScreenPoint() 轮询鼠标位置并移动窗口。
 * 坐标完全在主进程获取，避免渲染进程 DPI 坐标转换导致的缩放问题。
 */
export function useWindowDrag(elementRef: Ref<HTMLElement | null>) {
  let isDragging = false;

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"], .no-drag')) return;

    isDragging = true;

    // 通知主进程开始拖动（主进程自行轮询鼠标位置）
    window.electron.ipcRenderer.send('window-drag:start');

    window.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    window.electron.ipcRenderer.send('window-drag:end');
    window.removeEventListener('mouseup', handleMouseUp);
  };

  onMounted(() => {
    elementRef.value?.addEventListener('mousedown', handleMouseDown);
  });

  onUnmounted(() => {
    elementRef.value?.removeEventListener('mousedown', handleMouseDown);
    window.removeEventListener('mouseup', handleMouseUp);
  });
}
