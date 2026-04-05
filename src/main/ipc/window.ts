import { app, BrowserWindow, ipcMain } from 'electron';

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
    } else if (action === 'close') browserWindow.close();
  });

  ipcMain.on('window-toggle', () => {
    const browserWindow = getMainWindow();
    if (!browserWindow) return;
    if (browserWindow.isVisible()) {
      browserWindow.hide();
    } else {
      browserWindow.show();
      browserWindow.focus();
    }
  });

  ipcMain.on('quit-app', () => {
    app.quit();
  });
};
