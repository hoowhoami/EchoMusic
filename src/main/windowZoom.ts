import type { BrowserWindow } from 'electron';

/**
 * 在高 DPI 设备上强制窗口 zoomFactor 为 1.0，防止意外缩放导致界面模糊或控件错位。
 *
 * **问题背景**：
 * - Windows 高 DPI（150%/200% 缩放）下，系统会在窗口状态变化（全屏、最大化、刷新）后异步重置 zoomFactor
 * - 如果只在事件回调中立即设置，系统的重置可能发生在之后，导致设置失效
 * - 表现为"刷新一次糊，再刷新又好"的循环现象（时序竞争）
 *
 * **解决方案**：
 * - 立即设置 + 延迟 80ms 后再次强制设置，确保覆盖系统的异步重置
 * - 在所有可能触发重置的事件上都应用此策略
 *
 * @param win 需要锁定缩放的窗口
 * @param events 需要监听的事件列表，默认为 ['did-finish-load']
 * @example
 * const win = new BrowserWindow({ ... });
 * enforceWindowZoomFactor(win);  // 默认只在 did-finish-load 时强制
 * enforceWindowZoomFactor(win, ['did-finish-load', 'maximize', 'enter-full-screen']);  // 多个事件
 */
export function enforceWindowZoomFactor(
  win: BrowserWindow,
  events: Array<
    'did-finish-load' | 'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen'
  > = ['did-finish-load'],
): void {
  const enforce = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.setZoomFactor(1.0);
    win.webContents.setVisualZoomLevelLimits(1, 1);
  };

  // 立即执行 + 延迟兜底，确保覆盖系统的异步重置
  const enforceWithDelay = () => {
    enforce();
    setTimeout(enforce, 80);
  };

  // 注册各个事件的监听器
  if (events.includes('did-finish-load')) {
    win.webContents.on('did-finish-load', enforceWithDelay);
  }
  if (events.includes('maximize')) {
    win.on('maximize', enforceWithDelay);
  }
  if (events.includes('unmaximize')) {
    win.on('unmaximize', enforceWithDelay);
  }
  if (events.includes('enter-full-screen')) {
    win.on('enter-full-screen', enforceWithDelay);
  }
  if (events.includes('leave-full-screen')) {
    win.on('leave-full-screen', enforceWithDelay);
  }
}
