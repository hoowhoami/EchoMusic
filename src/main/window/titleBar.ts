import { titleBarHeight } from '../../shared/window-zoom';

interface TitleBarWindow {
  isDestroyed(): boolean;
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
}

export function createTitleBarController(
  win: TitleBarWindow,
  isDark: () => boolean,
  zoomLevel: () => number,
) {
  let lyricVisible = false;
  const sync = (level = zoomLevel()) => {
    if (win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: lyricVisible || isDark() ? '#ffffff' : '#202020',
      height: titleBarHeight(level),
    });
  };
  return {
    sync,
    setLyricVisible(visible: boolean) {
      lyricVisible = visible;
      sync();
    },
  };
}
