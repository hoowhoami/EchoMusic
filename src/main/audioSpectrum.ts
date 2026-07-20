import { ipcMain, type WebContents } from 'electron';
import type {
  AudioSpectrumFrame,
  AudioSpectrumOptions,
  AudioSpectrumStatus,
  AudioSpectrumSubscribePayload,
  AudioSpectrumSubscribeResult,
  AudioSpectrumUnsubscribePayload,
} from '../shared/audio-spectrum';
import log from './logger';
import type { PlayerController } from './player/controller';

type AudioSpectrumSubscription = {
  id: string;
  pluginId: string;
  webContents: WebContents;
  options?: AudioSpectrumOptions;
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

const clampNumber = (value: unknown, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
};

const getMergedOptions = (): AudioSpectrumOptions => {
  let fps: number | undefined;
  let binCount: number | undefined;
  let minFrequency: number | undefined;
  let maxFrequency: number | undefined;
  let smoothing: number | undefined;

  for (const subscription of subscriptions.values()) {
    const options = subscription.options || {};
    const nextFps = clampNumber(options.fps, 1, 60);
    const nextBinCount = clampNumber(options.binCount, 8, 512);
    const nextMinFrequency = clampNumber(options.minFrequency, 1, 20000);
    const nextMaxFrequency = clampNumber(options.maxFrequency, 2, 24000);
    const nextSmoothing = clampNumber(options.smoothing, 0, 0.95);

    if (nextFps !== undefined) fps = Math.max(fps ?? nextFps, nextFps);
    if (nextBinCount !== undefined) binCount = Math.max(binCount ?? nextBinCount, nextBinCount);
    if (nextMinFrequency !== undefined) {
      minFrequency = Math.min(minFrequency ?? nextMinFrequency, nextMinFrequency);
    }
    if (nextMaxFrequency !== undefined) {
      maxFrequency = Math.max(maxFrequency ?? nextMaxFrequency, nextMaxFrequency);
    }
    if (nextSmoothing !== undefined) {
      smoothing = Math.min(smoothing ?? nextSmoothing, nextSmoothing);
    }
  }

  const resolvedMinFrequency = minFrequency ?? 20;
  return {
    fps: fps ?? 30,
    binCount: binCount ?? 128,
    fftSize: 2048,
    smoothing: smoothing ?? 0.65,
    minFrequency: resolvedMinFrequency,
    maxFrequency: Math.max(maxFrequency ?? 20000, resolvedMinFrequency + 1),
    scale: 'log',
    includeWaveform: false,
  };
};

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
    try {
      subscription.webContents.send('audio-spectrum:frame', subscription.id, frame);
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
  const value = snapshot as { bins?: number[]; peak?: number; rms?: number; timestamp?: number };
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
    rms: Number(value.rms) || 0,
    peak: Number(value.peak) || 0,
  };
};

const pollFrame = async () => {
  if (subscriptions.size === 0) {
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

  const controller = getControllerRef?.();
  if (!controller) return status(false, '播放引擎未初始化');

  const options = getMergedOptions();
  controller.configureSpectrum({
    bands: options.binCount,
    fps: options.fps,
    minFrequency: options.minFrequency,
    maxFrequency: options.maxFrequency,
    smoothing: options.smoothing,
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
    subscriberCount: subscriptions.size,
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
  destroyedWebContents = new WeakSet();
  getControllerRef = null;
};
