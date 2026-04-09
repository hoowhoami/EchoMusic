import { globalShortcut, BrowserWindow, ipcMain } from 'electron';
import { hideMainWindow, showMainWindow } from '../window';

type ShortcutCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'toggleMainLyric'
  | 'toggleDesktopLyric'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMute'
  | 'toggleFavorite'
  | 'togglePlayMode'
  | 'toggleWindow';

type ShortcutMap = Record<ShortcutCommand, string>;

interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
}

let registeredShortcuts: ShortcutMap | null = null;

const forwardToRenderer = (command: ShortcutCommand, getMainWindow: () => BrowserWindow | null) => {
  const win = getMainWindow();
  if (!win) return;
  if (command === 'toggleMainLyric') {
    showMainWindow();
  }
  win.webContents.send('shortcut-trigger', command);
};

const registerShortcuts = (shortcutMap: ShortcutMap, getMainWindow: () => BrowserWindow | null) => {
  globalShortcut.unregisterAll();
  registeredShortcuts = shortcutMap;

  (Object.entries(shortcutMap) as Array<[ShortcutCommand, string]>).forEach(
    ([command, accelerator]) => {
      if (!accelerator) return;
      try {
        globalShortcut.register(accelerator, () => {
          if (command === 'toggleWindow') {
            const win = getMainWindow();
            if (!win) return;
            if (win.isVisible()) hideMainWindow();
            else showMainWindow();
            return;
          }
          forwardToRenderer(command, getMainWindow);
        });
      } catch {
        // ignore invalid accelerator
      }
    },
  );
};

export const registerShortcutHandlers = ({ getMainWindow }: IpcContext) => {
  ipcMain.on(
    'shortcuts:register',
    (_event, payload: { enabled: boolean; shortcutMap: ShortcutMap }) => {
      if (!payload?.enabled) {
        globalShortcut.unregisterAll();
        registeredShortcuts = null;
        return;
      }
      registerShortcuts(payload.shortcutMap, getMainWindow);
    },
  );

  ipcMain.on('shortcuts:refresh', () => {
    if (!registeredShortcuts) return;
    registerShortcuts(registeredShortcuts, getMainWindow);
  });
};
