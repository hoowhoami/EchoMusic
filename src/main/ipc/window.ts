import { BrowserWindow } from 'electron';
import { ipcRegistry } from './registry';
import { hideMainWindow, quitApplication, requestMainWindowClose } from '../window';
import { restoreActiveWindowMode } from '../windowModeController';
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
};
