import type { BrowserWindow } from 'electron';
import { ipcRegistry } from '../ipc/registry';
import { getMainAppSettings, setMainAppSetting } from '../storage/settings';
import { normalizeZoomLevel, zoomShortcut } from '../../shared/window-zoom';

// One authority for shortcuts, settings, reload and startup. Auxiliary lyric and
// plugin windows have separate sizing contracts and do not inherit this setting.
export function installWindowZoom(win: BrowserWindow, onChange: (level: number) => void) {
  let level = normalizeZoomLevel(getMainAppSettings().windowZoomLevel);
  const publish = () => {
    win.webContents.setZoomLevel(level);
    onChange(level);
    win.webContents.send('window:zoom-changed', level);
  };
  const set = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('缩放级别无效');
    const next = normalizeZoomLevel(value);
    if (next !== level) {
      level = next;
      setMainAppSetting('windowZoomLevel', level);
    }
    publish();
    return level;
  };
  win.webContents.on('did-finish-load', publish);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = zoomShortcut(input, process.platform);
    if (!action) return;
    event.preventDefault();
    set(action === 'reset' ? 0 : level + (action === 'in' ? 1 : -1));
  });
  // Suppress Chromium's unpersisted Ctrl+wheel zoom; explicit commands own zoom.
  win.webContents.on('zoom-changed', (event) => event.preventDefault());
  void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  return { get: () => level, set };
}

export function registerWindowZoomHandlers(
  getWindow: () => BrowserWindow | null,
  getZoom: () => ReturnType<typeof installWindowZoom> | null,
) {
  ipcRegistry.registerHandler('window:zoom-get', (event) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      return null;
    return getZoom()?.get() ?? 0;
  });
  ipcRegistry.registerHandler('window:zoom-set', (event, value: unknown) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('仅主窗口可以调整缩放');
    return getZoom()?.set(value);
  });
}
