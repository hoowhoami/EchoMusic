import type { BrowserWindow } from 'electron';

/**
 * 主进程侧的缩放兜底：仅用于「窗口状态切换会异步重置 zoomFactor」的场景。
 *
 * **职责边界**：
 * - 初始加载 / 刷新 / SPA 路由切换 / 重启的缩放锁定，统一由 preload（渲染进程侧 webFrame）负责，
 *   对标 VS Code 的 applyZoom 工程实践，确定性强、无跨进程时序竞争。
 * - 本函数只兜底那些「不会重载文档、preload 不会重新执行」却会被系统异步重置 zoom 的事件：
 *   Windows 高 DPI（150%/200%）下的最大化 / 还原 / 进入 / 退出全屏。
 *
 * **为什么不再监听 did-finish-load**：
 * - 之前在 did-finish-load 上做「立即 + 80ms 延迟」的 setZoomFactor，会对已绘制完成的首屏触发
 *   重栅格化，在分数 DPI 下反而导致「重启后一开机就糊」。该职责已移交 preload。
 *
 * @param win 需要锁定缩放的窗口
 * @param events 需要监听的事件列表，默认覆盖所有会异步重置 zoom 的窗口状态切换事件
 */
export function enforceWindowZoomFactor(
  win: BrowserWindow,
  events: Array<'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen'> = [
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ],
): void {
  const enforce = () => {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    // 已是 1.0 时不重复设置，避免无谓的重栅格化导致发虚
    if (wc.getZoomFactor() !== 1.0) wc.setZoomFactor(1.0);
    wc.setVisualZoomLevelLimits(1, 1);
  };

  // 立即执行 + 延迟兜底：部分高 DPI 设备的系统重置发生在事件回调之后
  const enforceWithDelay = () => {
    enforce();
    setTimeout(enforce, 80);
  };

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
