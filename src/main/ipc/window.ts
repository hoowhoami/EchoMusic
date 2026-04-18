import { BrowserWindow, ipcMain } from 'electron';
import { hideMainWindow, quitApplication, requestMainWindowClose, showMainWindow } from '../window';
import type { IpcContext } from './types';

export const registerWindowHandlers = ({ getMainWindow }: IpcContext) => {
  ipcMain.on('window-control', (event, action: 'minimize' | 'maximize' | 'close') => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    if (!browserWindow) return;
    if (action === 'minimize') browserWindow.minimize();
    else if (action === 'maximize') {
      if (browserWindow.isMaximized()) browserWindow.unmaximize();
      else browserWindow.maximize();
    } else if (action === 'close') {
      const mainWindow = getMainWindow();
      if (mainWindow && browserWindow.id === mainWindow.id) {
        requestMainWindowClose();
      } else {
        browserWindow.close();
      }
    }
  });

  ipcMain.on('window-drag:move', (event, pos: { x: number; y: number }) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isMaximized() || browserWindow.isFullScreen()) return;
    browserWindow.setPosition(Math.round(pos.x), Math.round(pos.y), false);
  });

  ipcMain.on('window-toggle', () => {
    const browserWindow = getMainWindow();
    if (!browserWindow) return;
    if (browserWindow.isVisible()) {
      hideMainWindow();
    } else {
      showMainWindow();
    }
  });

  ipcMain.on('quit-app', () => {
    quitApplication();
  });
};
