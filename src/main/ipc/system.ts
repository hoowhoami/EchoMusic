import os from 'node:os';
import { ipcRegistry } from './registry';

export const registerSystemHandlers = () => {
  ipcRegistry.registerHandler('system:get-boot-info', () => {
    const uptimeSec = Math.floor(os.uptime());
    return { uptimeSec, bootTimeMs: Date.now() - uptimeSec * 1000 };
  });
};
