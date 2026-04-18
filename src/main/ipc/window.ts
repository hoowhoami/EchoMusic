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

  // 窗口拖动：记录拖动开始时的尺寸，setBounds 时固定 width/height 防止 DPI 缩放问题
  const dragState = new Map<number, { width: number; height: number }>();

  ipcMain.on('window-drag:start', (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isMaximized() || browserWindow.isFullScreen()) return;
    const bounds = browserWindow.getBounds();
    dragState.set(browserWindow.id, { width: bounds.width, height: bounds.height });
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
    if (browserWindow) dragState.delete(browserWindow.id);
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
