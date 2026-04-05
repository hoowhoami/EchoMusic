import { ipcMain } from 'electron';
import { startApiServer, stopApiServer } from '../server';

export const registerApiServerHandlers = () => {
  ipcMain.handle('api-server:start', async () => {
    try {
      await startApiServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.on('api-server:stop', () => {
    stopApiServer();
  });
};
