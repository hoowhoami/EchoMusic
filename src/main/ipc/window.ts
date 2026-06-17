import { BrowserWindow } from 'electron';
import { ipcRegistry } from './registry';
import { hideMainWindow, quitApplication, requestMainWindowClose } from '../window';
import { restoreActiveWindowMode } from '../windowModeController';
import { showMiniPlayerWindowOnTop } from '../miniPlayer';
import type {
  PluginHostWindowResult,
  PluginHostWindowTarget,
  PluginShowOnTopOptions,
} from '../../shared/plugins';
import type { IpcContext } from './types';

export const registerWindowHandlers = ({ getMainWindow }: IpcContext) => {
  ipcRegistry.registerListener(
    'window-control',
    (event, action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!browserWindow) return;
      if (action === 'minimize') browserWindow.minimize();
      else if (action === 'maximize') {
        if (browserWindow.isMaximized()) browserWindow.unmaximize();
        else browserWindow.maximize();
      } else if (action === 'fullscreen') {
        browserWindow.setFullScreen(!browserWindow.isFullScreen());
      } else if (action === 'close') {
        const mainWindow = getMainWindow();
        if (mainWindow && browserWindow.id === mainWindow.id) {
          requestMainWindowClose();
        } else {
          browserWindow.close();
        }
      }
    },
  );

  ipcRegistry.registerListener('window-drag:start', () => {});
  ipcRegistry.registerListener('window-drag:move', () => {});
  ipcRegistry.registerListener('window-drag:end', () => {});

  ipcRegistry.registerListener('window-toggle', () => {
    const browserWindow = getMainWindow();
    if (!browserWindow) return;
    if (browserWindow.isVisible()) {
      hideMainWindow();
    } else {
      void restoreActiveWindowMode();
    }
  });

  ipcRegistry.registerListener('quit-app', () => {
    quitApplication();
  });

  ipcRegistry.registerHandler(
    'plugins:host:show-on-top',
    (
      _event,
      target: PluginHostWindowTarget = 'main',
      options?: PluginShowOnTopOptions,
    ): PluginHostWindowResult => {
      const focus = options?.focus !== false;
      if (target === 'mini-player') {
        return showMiniPlayerWindowOnTop(focus)
          ? { ok: true, target }
          : { ok: false, error: 'mini 播放器未开启' };
      }
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不可用' };
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) {
        if (focus) win.show();
        else win.showInactive();
      }
      if (typeof win.moveTop === 'function') win.moveTop();
      if (focus) win.focus();
      return { ok: true, target: 'main' };
    },
  );
};
