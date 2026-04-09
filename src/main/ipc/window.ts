import { BrowserWindow, ipcMain } from 'electron';
import { hideMainWindow, quitApplication, requestMainWindowClose, showMainWindow } from '../window';

interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
}

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
