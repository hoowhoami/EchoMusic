import {
  resolveRendererWindowBackground,
  type WindowBackground,
} from '../../shared/windowBackground';
import type { WindowBackgroundTransparentMode } from '../../shared/windowBackgroundStrategy';

/** 当前窗口是否是动态壁纸（桌面层）。 */
const isDesktopWallpaperSurface = () =>
  window.location.hash.replace(/^#/, '').split(/[?#]/)[0] === '/wallpaper';

export function applyWindowBackground(
  value: WindowBackground,
  options: { transparentMode?: WindowBackgroundTransparentMode } = {},
) {
  // 动态壁纸是桌面层，不是应用窗口：套用主窗口的「窗口背景」透明度会让
  // 壁纸整体半透明，把系统壁纸透上来，这里直接跳过。
  if (isDesktopWallpaperSurface()) return;
  const background = resolveRendererWindowBackground(value, options.transparentMode);
  const root = document.documentElement;
  root.classList.toggle('app-background-enabled', background.enabled);
  root.classList.toggle('app-background-transparent', background.enabled);
  root.classList.toggle('app-background-frosted', background.frosted);
  root.style.setProperty('--app-background-opacity', String(1 - background.transparency / 100));
  if (background.color) root.style.setProperty('--app-background-color', background.color);
  else root.style.removeProperty('--app-background-color');
}
