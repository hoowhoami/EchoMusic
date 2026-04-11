import type { BrowserWindow } from 'electron';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
}
