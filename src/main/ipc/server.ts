import { ipcMain } from 'electron';
import { getApiServerStatus, startApiServer, stopApiServer } from '../server';

export const registerApiServerHandlers = () => {
  ipcMain.handle('api-server:start', async () => {
    try {
      await startApiServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('api-server:status', () => {
    return getApiServerStatus();
  });

  ipcMain.on('api-server:stop', () => {
    stopApiServer();
  });
};
