import { ipcMain, type WebContents } from 'electron';
import {
  filterAudioSpectrumFrameForSubscriber,
  mergeAudioSpectrumOptions,
  normalizeAudioSpectrumWaveform,
} from '../shared/audioSpectrum';
import type {
  AudioSpectrumFrame,
  AudioSpectrumOptions,
  AudioSpectrumSetPausedPayload,
  AudioSpectrumStatus,
  AudioSpectrumSubscribePayload,
  AudioSpectrumSubscribeResult,
  AudioSpectrumUnsubscribePayload,
} from '../shared/audioSpectrum';
import log from './logger';
import type { PlayerController } from './player/controller';

type AudioSpectrumSubscription = {
  id: string;
  pluginId: string;
  webContents: WebContents;
  options?: AudioSpectrumOptions;
  /**
   * 订阅者主动暂停（页面不可见/窗口隐藏）。暂停的订阅不参与参数合并，也不接收帧，
   * 但保留在表中以便恢复，避免把 fps/binCount 的并集永久性地抬高。
   */
  paused: boolean;
};

const subscriptions = new Map<string, AudioSpectrumSubscription>();
let destroyedWebContents = new WeakSet<WebContents>();
let registered = false;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingIntervalMs = 0;
let lastFrameTimestamp = 0;
let getControllerRef: (() => PlayerController | null) | null = null;
let emptySnapshotCount = 0;
let silentFrameCount = 0;
let broadcastSignalLogged = false;
let pollingInFlight = false;

const getSubscriptionKey = (webContents: WebContents, subscriptionId: string) =>
  `${webContents.id}:${String(subscriptionId || '').trim()}`;

const status = (running: boolean, reason?: string): AudioSpectrumStatus => ({
  available: true,
  running,
  provider: 'player',
  reason,
  subscriberCount: subscriptions.size,
});

/** 仅统计仍在接收数据的订阅者数量，供状态与诊断使用。 */
const countActiveSubscriptions = () => {
  let count = 0;
  for (const subscription of subscriptions.values()) {
    if (!subscription.paused) count += 1;
  }
  return count;
};

const getMergedOptions = (): AudioSpectrumOptions =>
  mergeAudioSpectrumOptions(
    Array.from(subscriptions.values(), (subscription) =>
      subscription.paused ? undefined : subscription.options,
    ),
  );

const removeDeadSubscriptions = () => {
  let changed = false;
  for (const [key, subscription] of subscriptions) {
    if (!subscription.webContents.isDestroyed()) continue;
    subscriptions.delete(key);
    changed = true;
  }
  return changed;
};

const broadcastFrame = (frame: AudioSpectrumFrame) => {
  if (
    !broadcastSignalLogged &&
    (frame.rms > 0 || frame.peak > 0 || frame.bins.some((value) => value > 0))
  ) {
    broadcastSignalLogged = true;
    log.info('[AudioSpectrum] broadcasting player spectrum frames', {
      subscribers: subscriptions.size,
      bins: frame.bins.length,
      peak: frame.peak,
      rms: frame.rms,
      state: frame.state,
    });
  }

  for (const [key, subscription] of subscriptions) {
    if (subscription.webContents.isDestroyed()) {
      subscriptions.delete(key);
      continue;
    }
    // 订阅者已暂停：不再序列化也不再跨进程发送，避免把帧投递到看不见的窗口。
    if (subscription.paused) continue;
    try {
      subscription.webContents.send(
        'audio-spectrum:frame',
        subscription.id,
        filterAudioSpectrumFrameForSubscriber(
          frame,
          subscription.options?.includeWaveform === true,
        ),
      );
    } catch (error) {
      log.debug('[AudioSpectrum] Failed to send frame:', error);
      subscriptions.delete(key);
    }
  }
};

const toNormalizedBin = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(1, Math.max(0, number));
};

const toAudioSpectrumFrame = (
  snapshot: unknown,
  controller: PlayerController,
  options: AudioSpectrumOptions,
): AudioSpectrumFrame | null => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as {
    bins?: number[];
    waveform?: number[];
    peak?: number;
    rms?: number;
    timestamp?: number;
  };
  if (!Array.isArray(value.bins)) return null;
  const state = controller.currentState;
  return {
    source: 'player',
    state: state.playing ? 'playing' : state.paused ? 'paused' : 'idle',
    timestamp: Number(value.timestamp) || Date.now() / 1000,
    timePos: Number.isFinite(state.timePos) ? state.timePos : null,
    sampleRate: 48000,
    fftSize: Number(options.fftSize) || 2048,
    minFrequency: Number(options.minFrequency) || 20,
    maxFrequency: Number(options.maxFrequency) || 20000,
    bins: value.bins.map(toNormalizedBin),
    waveform: normalizeAudioSpectrumWaveform(value.waveform, options.includeWaveform === true),
    rms: Number(value.rms) || 0,
    peak: Number(value.peak) || 0,
  };
};

const pollFrame = async () => {
  if (subscriptions.size === 0) {
    stopPolling();
    return;
  }
  // 订阅可能在上一轮广播后全部被暂停：不再取快照，直接停表。
  if (countActiveSubscriptions() === 0) {
    stopPolling();
    return;
  }
  if (pollingInFlight) return;
  const controller = getControllerRef?.();
  if (!controller) return;
  pollingInFlight = true;
  try {
    const options = getMergedOptions();
    const snapshot = await controller.getSpectrumSnapshot();
    const frame = toAudioSpectrumFrame(snapshot, controller, options);
    if (!frame) {
      emptySnapshotCount += 1;
      if (emptySnapshotCount === 30) {
        log.warn('[AudioSpectrum] player spectrum snapshot is empty');
      }
      return;
    }
    emptySnapshotCount = 0;
    if (frame.rms <= 0 && frame.peak <= 0 && frame.bins.every((value) => value <= 0)) {
      silentFrameCount += 1;
      if (silentFrameCount === 30) {
        log.warn('[AudioSpectrum] player spectrum frames are silent', {
          state: frame.state,
          timePos: frame.timePos,
        });
      }
    } else {
      silentFrameCount = 0;
    }
    if (frame.timestamp === lastFrameTimestamp) return;
    lastFrameTimestamp = frame.timestamp;
    broadcastFrame(frame);
    if (removeDeadSubscriptions() && subscriptions.size === 0) stopPolling();
  } catch (error) {
    log.warn('[AudioSpectrum] get player spectrum snapshot failed:', error);
  } finally {
    pollingInFlight = false;
  }
};

const stopPolling = () => {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = null;
  pollingIntervalMs = 0;
  lastFrameTimestamp = 0;
  broadcastSignalLogged = false;
};

const syncForSubscriptions = (): AudioSpectrumStatus => {
  if (subscriptions.size === 0) {
    stopPolling();
    return status(false);
  }
  // 所有订阅者都已暂停：完全停止轮询与 FFT 配置，不为看不见的界面付出任何代价。
  if (countActiveSubscriptions() === 0) {
    stopPolling();
    return status(false, '订阅者均已暂停');
  }

  const controller = getControllerRef?.();
  if (!controller) return status(false, '播放引擎未初始化');

  const options = getMergedOptions();
  controller.configureSpectrum({
    bands: options.binCount,
    fps: options.fps,
    minFrequency: options.minFrequency,
    maxFrequency: options.maxFrequency,
    smoothing: options.smoothing,
    includeWaveform: options.includeWaveform,
  });

  const intervalMs = Math.max(16, Math.round(1000 / Math.max(1, Math.min(60, options.fps ?? 30))));
  if (!pollingTimer || pollingIntervalMs !== intervalMs) {
    stopPolling();
    pollingIntervalMs = intervalMs;
    pollingTimer = setInterval(() => void pollFrame(), intervalMs);
    void pollFrame();
  }
  return status(true);
};

const getStatus = (): AudioSpectrumStatus => {
  const controller = getControllerRef?.();
  if (!controller) return status(false, '播放引擎未初始化');
  return {
    ...controller.getSpectrumStatus(),
    provider: 'player',
    subscriberCount: countActiveSubscriptions(),
  };
};

const getSnapshot = async (): Promise<AudioSpectrumFrame | null> => {
  const controller = getControllerRef?.();
  if (!controller) return null;
  return toAudioSpectrumFrame(
    await controller.getSpectrumSnapshot(),
    controller,
    getMergedOptions(),
  );
};

const removeWebContentsSubscriptions = (webContents: WebContents) => {
  let changed = false;
  for (const [key, subscription] of subscriptions) {
    if (subscription.webContents.id !== webContents.id) continue;
    subscriptions.delete(key);
    changed = true;
  }
  return changed;
};

export const registerAudioSpectrumIpc = (
  getController: () => PlayerController | null = () => null,
) => {
  getControllerRef = getController;
  if (registered) return;
  registered = true;

  ipcMain.handle('audio-spectrum:get-status', () => getStatus());
  ipcMain.handle('audio-spectrum:get-snapshot', () => getSnapshot());
  ipcMain.handle(
    'audio-spectrum:subscribe',
    (event, payload: AudioSpectrumSubscribePayload): AudioSpectrumSubscribeResult => {
      const subscriptionId = String(payload?.subscriptionId || '').trim();
      if (!subscriptionId) return { ok: false, error: '频谱订阅 id 不能为空' };

      const webContents = event.sender;
      const key = getSubscriptionKey(webContents, subscriptionId);
      subscriptions.set(key, {
        id: subscriptionId,
        pluginId: String(payload?.pluginId || '').trim(),
        webContents,
        options: payload?.options,
        paused: false,
      });
      log.info('[AudioSpectrum] subscription added', {
        pluginId: String(payload?.pluginId || '').trim() || undefined,
        subscriberCount: subscriptions.size,
        webContentsId: webContents.id,
        options: payload?.options,
      });

      if (!destroyedWebContents.has(webContents)) {
        destroyedWebContents.add(webContents);
        webContents.once('destroyed', () => {
          stopPolling();
          if (removeWebContentsSubscriptions(webContents)) syncForSubscriptions();
          if (subscriptions.size === 0) stopPolling();
        });
      }

      return { ok: true, status: syncForSubscriptions() };
    },
  );

  ipcMain.handle(
    'audio-spectrum:unsubscribe',
    (event, payload: AudioSpectrumUnsubscribePayload): AudioSpectrumStatus => {
      const subscriptionId = String(payload?.subscriptionId || '').trim();
      if (subscriptionId) {
        subscriptions.delete(getSubscriptionKey(event.sender, subscriptionId));
      }
      log.info('[AudioSpectrum] subscription removed', {
        subscriberCount: subscriptions.size,
        webContentsId: event.sender.id,
      });
      return syncForSubscriptions();
    },
  );

  ipcMain.handle(
    'audio-spectrum:set-paused',
    (event, payload: AudioSpectrumSetPausedPayload): AudioSpectrumStatus => {
      const subscriptionId = String(payload?.subscriptionId || '').trim();
      const subscription = subscriptionId
        ? subscriptions.get(getSubscriptionKey(event.sender, subscriptionId))
        : undefined;
      if (!subscription) return syncForSubscriptions();

      const paused = payload?.paused === true;
      if (subscription.paused !== paused) {
        subscription.paused = paused;
        log.info('[AudioSpectrum] subscription paused state changed', {
          pluginId: subscription.pluginId || undefined,
          paused,
          activeSubscribers: countActiveSubscriptions(),
          webContentsId: event.sender.id,
        });
      }
      // 合并参数与轮询频率都依赖活跃订阅集合，必须重新同步。
      return syncForSubscriptions();
    },
  );
};

export const unregisterAudioSpectrumIpc = () => {
  if (!registered) return;
  registered = false;
  stopPolling();
  subscriptions.clear();
  ipcMain.removeHandler('audio-spectrum:get-status');
  ipcMain.removeHandler('audio-spectrum:get-snapshot');
  ipcMain.removeHandler('audio-spectrum:subscribe');
  ipcMain.removeHandler('audio-spectrum:unsubscribe');
  ipcMain.removeHandler('audio-spectrum:set-paused');
  destroyedWebContents = new WeakSet();
  getControllerRef = null;
};
