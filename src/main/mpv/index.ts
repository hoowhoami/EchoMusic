import type { BrowserWindow } from 'electron';
import { MpvController } from './controller';

let mpvController: MpvController | null = null;

export async function initMpvPlayer(
  getMainWindow: () => BrowserWindow | null,
): Promise<MpvController | null> {
  const controller = new MpvController();

  if (!controller.available) {
    console.warn('[Main] mpv binary not found');
    return null;
  }

  // 转发事件到渲染进程
  controller.on('time-update', (time: number) => {
    getMainWindow()?.webContents.send('mpv:time-update', time);
  });
  controller.on('duration-change', (duration: number) => {
    getMainWindow()?.webContents.send('mpv:duration-change', duration);
  });
  controller.on('state-change', (state: unknown) => {
    getMainWindow()?.webContents.send('mpv:state-change', state);
  });
  controller.on('playback-end', (reason: string) => {
    getMainWindow()?.webContents.send('mpv:playback-end', reason);
  });
  controller.on('error', (error: Error) => {
    getMainWindow()?.webContents.send('mpv:error', error.message);
  });

  try {
    await controller.start();
    console.log('[Main] mpv player engine started');
    mpvController = controller;
    return controller;
  } catch (err) {
    console.error('[Main] mpv failed to start:', err);
    return null;
  }
}

export function destroyMpvPlayer(): void {
  mpvController?.destroy();
  mpvController = null;
}
