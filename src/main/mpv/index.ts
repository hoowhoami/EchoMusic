import type { BrowserWindow } from 'electron';
import { MpvController } from './controller';
import log from '../logger';

let mpvController: MpvController | null = null;
let cachedGetMainWindow: (() => BrowserWindow | null) | null = null;

/** 绑定事件转发到渲染进程 */
function bindEventForwarding(
  controller: MpvController,
  getMainWindow: () => BrowserWindow | null,
): void {
  // 节流 time-update 的 IPC 转发，mpv 默认 ~60fps 报告 time-pos，
  // 渲染进程不需要这么高频率，限制为 ~5fps（200ms）即可满足进度条更新
  let lastTimeSent = 0;
  let pendingTimeValue = -1;
  let timeThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  const TIME_THROTTLE_MS = 200;

  const flushTime = () => {
    timeThrottleTimer = null;
    if (pendingTimeValue >= 0) {
      getMainWindow()?.webContents.send('mpv:time-update', pendingTimeValue);
      lastTimeSent = Date.now();
      pendingTimeValue = -1;
    }
  };

  controller.on('time-update', (time: number) => {
    const now = Date.now();
    if (now - lastTimeSent >= TIME_THROTTLE_MS) {
      // 距上次发送已超过阈值，立即发送
      getMainWindow()?.webContents.send('mpv:time-update', time);
      lastTimeSent = now;
      pendingTimeValue = -1;
      if (timeThrottleTimer) {
        clearTimeout(timeThrottleTimer);
        timeThrottleTimer = null;
      }
    } else {
      // 缓存最新值，延迟发送
      pendingTimeValue = time;
      if (!timeThrottleTimer) {
        timeThrottleTimer = setTimeout(flushTime, TIME_THROTTLE_MS - (now - lastTimeSent));
      }
    }
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
}

export async function initMpvPlayer(
  getMainWindow: () => BrowserWindow | null,
): Promise<MpvController | null> {
  cachedGetMainWindow = getMainWindow;
  const controller = new MpvController();

  if (!controller.available) {
    log.warn('[Main] mpv binary not found, player engine unavailable');
    return null;
  }

  log.info('[Main] mpv controller ready, registering event forwarding');
  bindEventForwarding(controller, getMainWindow);

  try {
    await controller.start();
    log.info('[Main] mpv player engine started successfully');
    mpvController = controller;
    return controller;
  } catch (err) {
    log.error('[Main] mpv player engine failed to start:', err);
    return null;
  }
}

/** 销毁旧实例并重新初始化 mpv，供 Loading 页面重试使用 */
export async function restartMpvPlayer(): Promise<MpvController | null> {
  log.info('[Main] Restarting mpv player engine');
  destroyMpvPlayer();
  if (!cachedGetMainWindow) {
    log.error('[Main] Cannot restart mpv: getMainWindow not initialized');
    return null;
  }
  return initMpvPlayer(cachedGetMainWindow);
}

export function destroyMpvPlayer(): void {
  mpvController?.destroy();
  mpvController = null;
}
