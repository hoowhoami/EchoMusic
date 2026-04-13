import { globalShortcut, BrowserWindow, ipcMain } from 'electron';
import { hideMainWindow, showMainWindow } from '../window';
import type {
  ShortcutCommand,
  ShortcutMap,
  ShortcutRegistrationFailure,
  ShortcutRegistrationResult,
} from '../../shared/shortcuts';
import type { IpcContext } from './types';

let requestedShortcuts: ShortcutMap | null = null;

const forwardToRenderer = (command: ShortcutCommand, getMainWindow: () => BrowserWindow | null) => {
  const win = getMainWindow();
  if (!win) return;
  if (command === 'toggleMainLyric') {
    showMainWindow();
  }
  win.webContents.send('shortcut-trigger', command);
};

const registerShortcuts = (
  shortcutMap: ShortcutMap,
  getMainWindow: () => BrowserWindow | null,
): ShortcutRegistrationResult => {
  globalShortcut.unregisterAll();
  const registered = {} as ShortcutMap;
  const failures: ShortcutRegistrationFailure[] = [];
  requestedShortcuts = shortcutMap;

  (Object.entries(shortcutMap) as Array<[ShortcutCommand, string]>).forEach(
    ([command, accelerator]) => {
      if (!accelerator) return;
      try {
        const didRegister = globalShortcut.register(accelerator, () => {
          if (command === 'toggleWindow') {
            const win = getMainWindow();
            if (!win) return;
            if (win.isVisible()) hideMainWindow();
            else showMainWindow();
            return;
          }
          forwardToRenderer(command, getMainWindow);
        });
        if (didRegister && globalShortcut.isRegistered(accelerator)) {
          registered[command] = accelerator;
        } else {
          failures.push({
            command,
            accelerator,
            reason: 'conflict',
          });
        }
      } catch {
        failures.push({
          command,
          accelerator,
          reason: 'invalid',
        });
      }
    },
  );
  return { registered, failures };
};

export const registerShortcutHandlers = ({ getMainWindow }: IpcContext) => {
  ipcMain.handle(
    'shortcuts:register',
    (_event, payload: { enabled: boolean; shortcutMap: ShortcutMap }) => {
      if (!payload?.enabled) {
        globalShortcut.unregisterAll();
        requestedShortcuts = null;
        return { registered: {} as ShortcutMap, failures: [] };
      }
      return registerShortcuts(payload.shortcutMap, getMainWindow);
    },
  );

  ipcMain.handle('shortcuts:refresh', () => {
    if (!requestedShortcuts) {
      return { registered: {} as ShortcutMap, failures: [] };
    }
    return registerShortcuts(requestedShortcuts, getMainWindow);
  });
};
