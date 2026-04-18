import { ipcMain } from 'electron';
import { isApiServerReady, initApiServer, registerApiIpcHandler } from '../server';

export const registerApiServerHandlers = () => {
  // 注册核心 API 请求 handler
  registerApiIpcHandler();

  // 保留状态查询接口（简化版，Loading 页面使用）
  ipcMain.handle('api-server:status', () => {
    return {
      state: isApiServerReady() ? 'ready' : 'idle',
      updatedAt: Date.now(),
    };
  });

  // 保留启动接口（兼容 Loading 页面的重试逻辑）
  ipcMain.handle('api-server:start', async () => {
    try {
      await initApiServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
};
