import type { BrowserWindow } from 'electron';
import type { PlayerRef } from './player';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  playerRef: PlayerRef;
}
