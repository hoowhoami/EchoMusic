import log from '../logger';
import { getMainWindow } from '../window';
import { PlayerController } from './controller';

let playerController: PlayerController | null = null;
let cachedGetMainWindow: (() => Electron.BrowserWindow | null) | null = null;

export async function initPlayer(getWindow: () => Electron.BrowserWindow | null) {
  cachedGetMainWindow = getWindow;
  const controller = new PlayerController();
  if (!controller.available) {
    log.warn('[Main] player engine addon not found');
    return null;
  }
  registerEventForwarding(controller);
  if (!controller.start()) return null;
  playerController = controller;
  log.info('[Main] player engine started successfully');
  return controller;
}

export async function restartPlayer() {
  destroyPlayer();
  return initPlayer(cachedGetMainWindow ?? getMainWindow);
}

export function destroyPlayer(): void {
  playerController?.destroy();
  playerController = null;
}

function registerEventForwarding(controller: PlayerController): void {
  controller.on('time-update', (time) =>
    getMainWindow()?.webContents.send('player:time-update', time),
  );
  controller.on('seeked', (time) => getMainWindow()?.webContents.send('player:seeked', time));
  controller.on('duration-change', (duration) =>
    getMainWindow()?.webContents.send('player:duration-change', duration),
  );
  controller.on('file-loaded', (payload) =>
    getMainWindow()?.webContents.send('player:file-loaded', payload),
  );
  controller.on('state-change', (state) =>
    getMainWindow()?.webContents.send('player:state-change', state),
  );
  controller.on('playback-end', (reason) =>
    getMainWindow()?.webContents.send('player:playback-end', reason),
  );
  controller.on('stalled', (position) =>
    getMainWindow()?.webContents.send('player:stall', position),
  );
  controller.on('error', (error: Error) =>
    getMainWindow()?.webContents.send('player:error', error.message),
  );
  controller.on('impulse-response-disabled', (payload) =>
    getMainWindow()?.webContents.send('player:impulse-response-disabled', payload),
  );
  controller.on('audio-device-list-changed', (devices) =>
    getMainWindow()?.webContents.send('player:audio-device-list-changed', devices),
  );
}

export type { PlayerController } from './controller';
