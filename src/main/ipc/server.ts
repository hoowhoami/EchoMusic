import { ipcRegistry } from './registry';
import { handleApiRequest, isApiServerReady, initApiServer } from '../server';

export const registerApiServerHandlers = () => {
  ipcRegistry.registerHandler('api:request', async (_event, request) => {
    return handleApiRequest(request);
  });

  ipcRegistry.registerHandler('api-server:status', () => {
    return {
      state: isApiServerReady() ? 'ready' : 'idle',
      updatedAt: Date.now(),
    };
  });

  ipcRegistry.registerHandler('api-server:start', async () => {
    try {
      await initApiServer();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
};
