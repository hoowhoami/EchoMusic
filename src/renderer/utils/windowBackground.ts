import { resolveWindowBackground, type WindowBackground } from '../../shared/window-background';

export function applyWindowBackground(value: WindowBackground) {
  const background = resolveWindowBackground(value, value.enabled);
  const root = document.documentElement;
  root.classList.toggle('app-background-enabled', background.enabled);
  root.classList.toggle('app-background-transparent', background.enabled);
  root.classList.toggle('app-background-frosted', background.frosted);
  root.style.setProperty('--app-background-opacity', String(1 - background.transparency / 100));
  if (background.color) root.style.setProperty('--app-background-color', background.color);
  else root.style.removeProperty('--app-background-color');
}
