import { closeMiniPlayerWindow, getMiniPlayerWindow, showMiniPlayerWindow } from '../miniPlayer';
import { getActiveWindowMode, setActiveWindowMode } from './mode';
import { showMainWindow } from './index';

export const restoreActiveWindowMode = async () => {
  if (getActiveWindowMode() === 'mini') {
    await showMiniPlayerWindow();
    return;
  }
  await showMainWindow();
};

/**
 * 显式打开主窗口，无论当前处于哪种窗口模式。
 *
 * 主窗口与 Mini 窗口互斥：`showMiniPlayerWindow` 会隐藏主窗口，
 * `toggleMiniPlayerWindow` 回主窗口时也会关闭 Mini。这里保持同一语义，
 * 否则从 Mini 切「打开主窗口」会两个窗口同时出现。
 */
export const showMainWindowMode = async () => {
  const win = getMiniPlayerWindow();
  const miniOpen = Boolean(win && !win.isDestroyed() && win.isVisible());
  setActiveWindowMode('main');
  await showMainWindow();
  if (miniOpen) closeMiniPlayerWindow();
};
