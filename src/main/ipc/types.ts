import type { BrowserWindow } from 'electron';
import type { MpvRef } from './player';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  mpvRef: MpvRef;
}
