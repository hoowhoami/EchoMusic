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

  // 窗口拖动：开始时锁定尺寸（规避 Windows 高 DPI 缩放 bug）
  const dragState = new Map<number, { width: number; height: number }>();

  ipcMain.on('window-drag:start', (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isMaximized() || browserWindow.isFullScreen()) return;
    const bounds = browserWindow.getBounds();
    dragState.set(browserWindow.id, { width: bounds.width, height: bounds.height });
    browserWindow.setMaximumSize(bounds.width, bounds.height);
  });

  ipcMain.on('window-drag:move', (event, pos: { x: number; y: number }) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isMaximized() || browserWindow.isFullScreen()) return;
    const locked = dragState.get(browserWindow.id);
    const bounds = browserWindow.getBounds();
    browserWindow.setBounds({
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: locked?.width ?? bounds.width,
      height: locked?.height ?? bounds.height,
    });
  });

  ipcMain.on('window-drag:end', (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow) return;
    dragState.delete(browserWindow.id);
    if (!browserWindow.isDestroyed()) {
      browserWindow.setMaximumSize(0, 0);
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
