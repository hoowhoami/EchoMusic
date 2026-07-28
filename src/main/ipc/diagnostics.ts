import { getAppMemoryMetrics } from '../diagnostics/memory';
import { ipcRegistry } from './registry';

export const registerDiagnosticsHandlers = () => {
  ipcRegistry.registerHandler('diagnostics:get-app-memory', () => getAppMemoryMetrics());
};
