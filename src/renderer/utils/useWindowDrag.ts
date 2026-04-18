import { onMounted, onUnmounted, type Ref } from 'vue';

/**
 * 通过 JS 实现窗口拖动，替代不可靠的 CSS -webkit-app-region: drag
 *
 * 原理：监听 titlebar 上的 mousedown，通过 mousemove 计算偏移量，
 * 通过 IPC 调用 main 进程的 setBounds 移动窗口。
 */
export function useWindowDrag(elementRef: Ref<HTMLElement | null>) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startWinX = 0;
  let startWinY = 0;

  const handleMouseDown = (e: MouseEvent) => {
    // 只响应左键
    if (e.button !== 0) return;
    // 如果点击的是按钮或可交互元素，不拖动
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"], .no-drag')) return;

    isDragging = true;
    startX = e.screenX;
    startY = e.screenY;

    // 获取当前窗口位置
    const bounds = { x: window.screenX, y: window.screenY };
    startWinX = bounds.x;
    startWinY = bounds.y;

    // 在 window 上监听，这样鼠标移出 titlebar 也能继续拖动
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
    isDragging = false;
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
