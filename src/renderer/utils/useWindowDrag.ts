import { onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 通过 JS 实现窗口拖动，替代不可靠的 CSS -webkit-app-region: drag
 *
 * 原理：监听 titlebar 上的 mousedown，通过 mousemove 计算偏移量，
 * 通过 IPC 调用 main 进程的 setBounds 移动窗口。
 * 拖动期间锁定窗口尺寸，规避 Windows 高 DPI 下 setBounds 导致窗口变大的问题。
 */
export function useWindowDrag(elementRef: Ref<HTMLElement | null>) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startWinX = 0;
  let startWinY = 0;

  const handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"], .no-drag')) return;

    isDragging = true;
    startX = e.screenX;
    startY = e.screenY;
    startWinX = window.screenX;
    startWinY = window.screenY;

    // 通知 main 进程锁定窗口尺寸（规避 Windows 高 DPI 缩放 bug）
    window.electron.ipcRenderer.send('window-drag:start');

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const deltaX = e.screenX - startX;
    const deltaY = e.screenY - startY;
    window.electron.ipcRenderer.send('window-drag:move', {
      x: startWinX + deltaX,
      y: startWinY + deltaY,
    });
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    // 通知 main 进程解锁窗口尺寸
    window.electron.ipcRenderer.send('window-drag:end');
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  };

  onMounted(() => {
    elementRef.value?.addEventListener('mousedown', handleMouseDown);
  });

  onUnmounted(() => {
    elementRef.value?.removeEventListener('mousedown', handleMouseDown);
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  });
}
