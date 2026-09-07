import { normalizeWindowBackground, type WindowBackground } from '../../shared/window-background';

export function applyWindowBackground(value: WindowBackground) {
  const background = normalizeWindowBackground(value);
  const root = document.documentElement;
  root.classList.toggle(
    'app-background-transparent',
    background.frosted || background.transparency > 0 || Boolean(background.color),
  );
  root.classList.toggle('app-background-frosted', background.frosted);
  root.style.setProperty('--app-background-opacity', String(1 - background.transparency / 100));
  if (background.color) root.style.setProperty('--app-background-color', background.color);
  else root.style.removeProperty('--app-background-color');
}
