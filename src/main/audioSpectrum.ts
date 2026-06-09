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
const destroyedWebContents = new WeakSet<WebContents>();
let registered = false;
let getPlayerController: (() => PlayerController | null) | null = null;
let currentOptionsKey = '';
let activeProvider: AudioSpectrumStatus['provider'] | '' = '';
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingIntervalMs = 0;
let lastFrameTimestamp = 0;

const UNAVAILABLE_REASON = '系统音频频谱捕获不可用';
const PLAYER_CORE_UNAVAILABLE_REASON = '播放器内置频谱不可用';

const getSubscriptionKey = (webContents: WebContents, subscriptionId: string) =>
  `${webContents.id}:${String(subscriptionId || '').trim()}`;

const getUnavailableStatus = (reason = UNAVAILABLE_REASON): AudioSpectrumStatus => ({
  available: false,
  running: false,
  provider: 'unavailable',
  reason,
  subscriberCount: subscriptions.size,
});

const withSubscriberCount = (status: AudioSpectrumStatus): AudioSpectrumStatus => ({
  ...status,
  subscriberCount: subscriptions.size,
});

const clampNumber = (value: unknown, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
};

const getPlayerCore = () => {
  const controller = getPlayerController?.() ?? null;
  if (!controller?.hasPlayerCoreSpectrum) return null;
  return controller;
};

const getMergedOptions = (): AudioSpectrumOptions => {
  let fps: number | undefined;
  let binCount: number | undefined;
  let fftSize: number | undefined;
  let smoothing: number | undefined;
  let minFrequency: number | undefined;
  let maxFrequency: number | undefined;
  let scale: AudioSpectrumOptions['scale'] = 'log';
  let includeWaveform = false;

  for (const subscription of subscriptions.values()) {
    const options = subscription.options || {};
    const nextFps = clampNumber(options.fps, 1, 60);
    const nextBinCount = clampNumber(options.binCount, 8, 512);
    const nextFftSize = clampNumber(options.fftSize, 512, 8192);
    const nextSmoothing = clampNumber(options.smoothing, 0, 0.95);
    const nextMinFrequency = clampNumber(options.minFrequency, 1, 20000);
    const nextMaxFrequency = clampNumber(options.maxFrequency, 2, 24000);

    if (nextFps !== undefined) fps = Math.max(fps ?? nextFps, nextFps);
    if (nextBinCount !== undefined) {
      binCount = Math.max(binCount ?? nextBinCount, nextBinCount);
    }
    if (nextFftSize !== undefined) fftSize = Math.max(fftSize ?? nextFftSize, nextFftSize);
    if (nextSmoothing !== undefined) {
      smoothing = Math.min(smoothing ?? nextSmoothing, nextSmoothing);
    }
    if (nextMinFrequency !== undefined) {
      minFrequency = Math.min(minFrequency ?? nextMinFrequency, nextMinFrequency);
    }
    if (nextMaxFrequency !== undefined) {
      maxFrequency = Math.max(maxFrequency ?? nextMaxFrequency, nextMaxFrequency);
    }
    if (options.scale) scale = options.scale;
    includeWaveform = includeWaveform || Boolean(options.includeWaveform);
  }

  const resolvedMinFrequency = minFrequency ?? 20;
  const resolvedMaxFrequency = Math.max(maxFrequency ?? 20000, resolvedMinFrequency + 1);

  return {
    fps: fps ?? 30,
    binCount: binCount ?? 128,
    fftSize: fftSize ?? 2048,
    smoothing: smoothing ?? 0.65,
    minFrequency: resolvedMinFrequency,
    maxFrequency: resolvedMaxFrequency,
    scale,
    includeWaveform,
  };
};

const stopPolling = () => {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = null;
  pollingIntervalMs = 0;
  lastFrameTimestamp = 0;
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
  for (const [key, subscription] of subscriptions) {
    if (subscription.webContents.isDestroyed()) {
      subscriptions.delete(key);
      continue;
    }

    try {
      subscription.webContents.send('audio-spectrum:frame', subscription.id, frame);
    } catch (err) {
      log.debug('[AudioSpectrum] Failed to send frame:', err);
      subscriptions.delete(key);
    }
  }
};

const pollFrame = () => {
  if (subscriptions.size === 0) {
    stopCapture();
    return;
  }

  if (!activeProvider) {
    syncCaptureForSubscriptions();
    return;
  }

  const provider = activeProvider === 'player-core' ? getPlayerCore() : null;
  if (!provider) {
    stopPolling();
    syncCaptureForSubscriptions();
    return;
  }

  try {
    const frame = provider.getSpectrumSnapshot();
    if (!frame || frame.timestamp === lastFrameTimestamp) return;
    lastFrameTimestamp = frame.timestamp;
    broadcastFrame(frame);
    if (removeDeadSubscriptions() && subscriptions.size === 0) stopCapture();
  } catch (err) {
    log.warn('[AudioSpectrum] getSnapshot failed:', err);
    stopPolling();
  }
};

const startPolling = (fps = 30) => {
  const intervalMs = Math.max(16, Math.round(1000 / Math.max(1, Math.min(60, fps))));
  if (pollingTimer && pollingIntervalMs === intervalMs) return;
  stopPolling();
  pollingIntervalMs = intervalMs;
  pollingTimer = setInterval(pollFrame, intervalMs);
  pollFrame();
};

const stopCapture = (): AudioSpectrumStatus => {
  stopPolling();
  currentOptionsKey = '';
  const provider = activeProvider;
  activeProvider = '';

  if (provider === 'player-core') {
    const playerCore = getPlayerCore();
    if (!playerCore) return getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
    try {
      return withSubscriberCount(
        playerCore.stopSpectrum() ?? getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON),
      );
    } catch (err) {
      log.warn('[AudioSpectrum] player-core stop failed:', err);
      return getUnavailableStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
};

const syncCaptureForSubscriptions = (): AudioSpectrumStatus => {
  if (subscriptions.size === 0) return stopCapture();

  const playerCore = getPlayerCore();
  const options = getMergedOptions();
  const nextOptionsKey = JSON.stringify(options);

  if (playerCore) {
    if (activeProvider === 'player-core' && pollingTimer && currentOptionsKey === nextOptionsKey) {
      const status =
        playerCore.getSpectrumStatus() ?? getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
      return withSubscriberCount(status);
    }

    try {
      const status = withSubscriberCount(
        playerCore.startSpectrum(options) ?? getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON),
      );
      if (status.running) {
        activeProvider = 'player-core';
        currentOptionsKey = nextOptionsKey;
        startPolling(options.fps);
        return status;
      }
      log.warn('[AudioSpectrum] player-core spectrum unavailable, falling back:', status.reason);
    } catch (err) {
      log.warn('[AudioSpectrum] player-core start failed, falling back:', err);
    }
  }

  activeProvider = '';
  stopPolling();
  return getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
};

const getStatus = (): AudioSpectrumStatus => {
  if (activeProvider === 'player-core') {
    const playerCore = getPlayerCore();
    const status = playerCore?.getSpectrumStatus();
    return status
      ? withSubscriberCount(status)
      : getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
  }

  const playerCore = getPlayerCore();
  const playerStatus = playerCore?.getSpectrumStatus();
  if (playerStatus) return withSubscriberCount(playerStatus);

  return getUnavailableStatus(PLAYER_CORE_UNAVAILABLE_REASON);
};

const getSnapshot = (): AudioSpectrumFrame | null => {
  if (activeProvider === 'player-core') return getPlayerCore()?.getSpectrumSnapshot() ?? null;

  return getPlayerCore()?.getSpectrumSnapshot() ?? null;
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

export const registerAudioSpectrumIpc = (getController?: () => PlayerController | null) => {
  getPlayerController = getController ?? null;
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

      if (!destroyedWebContents.has(webContents)) {
        destroyedWebContents.add(webContents);
        webContents.once('destroyed', () => {
          if (removeWebContentsSubscriptions(webContents)) {
            syncCaptureForSubscriptions();
          }
        });
      }

      return { ok: true, status: syncCaptureForSubscriptions() };
    },
  );

  ipcMain.handle(
    'audio-spectrum:unsubscribe',
    (event, payload: AudioSpectrumUnsubscribePayload): AudioSpectrumStatus => {
      const subscriptionId = String(payload?.subscriptionId || '').trim();
      if (subscriptionId) {
        subscriptions.delete(getSubscriptionKey(event.sender, subscriptionId));
      }
      return syncCaptureForSubscriptions();
    },
  );
};

export const unregisterAudioSpectrumIpc = () => {
  if (!registered) return;
  registered = false;
  subscriptions.clear();
  getPlayerController = null;
  stopCapture();
  ipcMain.removeHandler('audio-spectrum:get-status');
  ipcMain.removeHandler('audio-spectrum:get-snapshot');
  ipcMain.removeHandler('audio-spectrum:subscribe');
  ipcMain.removeHandler('audio-spectrum:unsubscribe');
};
