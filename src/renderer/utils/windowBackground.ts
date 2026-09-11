import {
  resolveRendererWindowBackground,
  type WindowBackground,
} from '../../shared/window-background';
import type { WindowBackgroundTransparentMode } from '../../shared/window-background-strategy';

export function applyWindowBackground(
  value: WindowBackground,
  options: { transparentMode?: WindowBackgroundTransparentMode } = {},
) {
  const background = resolveRendererWindowBackground(value, options.transparentMode);
  const root = document.documentElement;
  root.classList.toggle('app-background-enabled', background.enabled);
  root.classList.toggle('app-background-transparent', background.enabled);
  root.classList.toggle('app-background-frosted', background.frosted);
  root.style.setProperty('--app-background-opacity', String(1 - background.transparency / 100));
  if (background.color) root.style.setProperty('--app-background-color', background.color);
  else root.style.removeProperty('--app-background-color');
}
