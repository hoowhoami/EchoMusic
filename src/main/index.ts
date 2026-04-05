import { app, globalShortcut } from 'electron';
import { initLogger } from './logger';
import { startApiServer, stopApiServer } from './server';
import { registerIpcHandlers } from './ipc';
import { createWindow, getMainWindow, restoreWindow } from './window';
import { createDockMenu, destroyTray, initTray } from './tray';

// --- 初始化日志 ---
initLogger();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.hoowhoami.echomusic');
}

// --- 保持应用单例运行 ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreWindow();
  });

  // 注册 IPC 处理器
  registerIpcHandlers({
    getMainWindow,
  });

  app.whenReady().then(async () => {
    try {
      // 启动 API 服务
      await startApiServer();
    } catch (err) {
      console.error('[Main] Failed to start API server:', err);
    }
    // 创建主窗口
    createWindow();
    initTray({
      getMainWindow,
      restoreWindow,
    });
    if (process.platform === 'darwin') {
      app.dock?.setMenu(createDockMenu());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    const mainWindow = getMainWindow();

    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    destroyTray();
    stopApiServer();
  });
}
