import type { BrowserWindow } from 'electron';
import { PlayerController } from './controller';
import log from '../logger';

let playerController: PlayerController | null = null;
let cachedGetMainWindow: (() => BrowserWindow | null) | null = null;

/** 绑定事件转发到渲染进程 */
function bindEventForwarding(
  controller: PlayerController,
  getMainWindow: () => BrowserWindow | null,
): void {
  // 节流 time-update 的 IPC 转发；播放后端可能高频报告 time-pos，
  // 渲染进程限制为 ~5fps（200ms）即可满足进度条更新
  let lastTimeSent = 0;
  let pendingTimeValue = -1;
  let timeThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  const TIME_THROTTLE_MS = 200;

  const flushTime = () => {
    timeThrottleTimer = null;
    if (pendingTimeValue >= 0) {
      getMainWindow()?.webContents.send('player:time-update', pendingTimeValue);
      lastTimeSent = Date.now();
      pendingTimeValue = -1;
    }
  };

  controller.on('time-update', (time: number) => {
    const now = Date.now();
    if (now - lastTimeSent >= TIME_THROTTLE_MS) {
      // 距上次发送已超过阈值，立即发送
      getMainWindow()?.webContents.send('player:time-update', time);
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
    getMainWindow()?.webContents.send('player:duration-change', duration);
  });
  controller.on('state-change', (state: unknown) => {
    getMainWindow()?.webContents.send('player:state-change', state);
  });
  controller.on('playback-end', (reason: string) => {
    getMainWindow()?.webContents.send('player:playback-end', reason);
  });
  controller.on('player:file-loaded', () => {
    getMainWindow()?.webContents.send('player:file-loaded');
  });
  controller.on('error', (error: Error) => {
    getMainWindow()?.webContents.send('player:error', error.message);
  });
  controller.on('impulse-response-disabled', (payload: unknown) => {
    getMainWindow()?.webContents.send('player:impulse-response-disabled', payload);
  });
  controller.on(
    'audio-device-list-changed',
    (devices: Array<{ name: string; description: string }>) => {
      getMainWindow()?.webContents.send('player:audio-device-list-changed', devices);
    },
  );
}

export async function initPlayer(
  getMainWindow: () => BrowserWindow | null,
): Promise<PlayerController | null> {
  cachedGetMainWindow = getMainWindow;
  const controller = new PlayerController();

  if (!controller.available) {
    log.warn('[Main] player engine unavailable');
    return null;
  }

  log.info('[Main] player controller ready, registering event forwarding', {
    engine: controller.engineName,
  });
  bindEventForwarding(controller, getMainWindow);

  try {
    await controller.start();
    log.info('[Main] player engine started successfully', {
      engine: controller.engineName,
    });
    playerController = controller;
    return controller;
  } catch (err) {
    log.error('[Main] player engine failed to start:', err);
    return null;
  }
}

/** 销毁旧实例并重新初始化播放引擎，供 Loading 页面重试使用 */
export async function restartPlayer(): Promise<PlayerController | null> {
  log.info('[Main] Restarting player engine');
  destroyPlayer();
  if (!cachedGetMainWindow) {
    log.error('[Main] Cannot restart player: getMainWindow not initialized');
    return null;
  }
  return initPlayer(cachedGetMainWindow);
}

export function destroyPlayer(): void {
  playerController?.destroy();
  playerController = null;
}
