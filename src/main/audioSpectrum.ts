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
import { loadSpectrumCapture, type NativeSpectrumCapture } from './spectrumCapture';

type AudioSpectrumSubscription = {
  id: string;
  pluginId: string;
  webContents: WebContents;
  options?: AudioSpectrumOptions;
};

const subscriptions = new Map<string, AudioSpectrumSubscription>();
const destroyedWebContents = new WeakSet<WebContents>();
let registered = false;
let capture: NativeSpectrumCapture | null | undefined;
let currentOptionsKey = '';
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingIntervalMs = 0;
let lastFrameTimestamp = 0;

const UNAVAILABLE_REASON = '系统音频频谱捕获不可用';

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

const getCapture = () => {
  if (capture !== undefined) return capture;
  capture = loadSpectrumCapture();
  return capture;
};

const getMergedOptions = (): AudioSpectrumOptions => {
  let fps = 30;
  let binCount = 128;
  let fftSize = 2048;
  let smoothing = 0.65;
  let minFrequency = 20;
  let maxFrequency = 20000;
  let scale: AudioSpectrumOptions['scale'] = 'log';
  let includeWaveform = false;

  for (const subscription of subscriptions.values()) {
    const options = subscription.options || {};
    fps = Math.max(fps, clampNumber(options.fps, 1, 60) ?? fps);
    binCount = Math.max(binCount, clampNumber(options.binCount, 8, 512) ?? binCount);
    fftSize = Math.max(fftSize, clampNumber(options.fftSize, 512, 8192) ?? fftSize);
    smoothing = Math.min(smoothing, clampNumber(options.smoothing, 0, 0.95) ?? smoothing);
    minFrequency = Math.min(
      minFrequency,
      clampNumber(options.minFrequency, 1, 20000) ?? minFrequency,
    );
    maxFrequency = Math.max(
      maxFrequency,
      clampNumber(options.maxFrequency, minFrequency + 1, 24000) ?? maxFrequency,
    );
    if (options.scale) scale = options.scale;
    includeWaveform = includeWaveform || Boolean(options.includeWaveform);
  }

  return {
    fps,
    binCount,
    fftSize,
    smoothing,
    minFrequency,
    maxFrequency,
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

  const nativeCapture = getCapture();
  if (!nativeCapture) {
    stopPolling();
    return;
  }

  try {
    const frame = nativeCapture.getSnapshot();
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
  const nativeCapture = capture === undefined ? null : capture;
  if (!nativeCapture) return getUnavailableStatus();

  try {
    return withSubscriberCount(nativeCapture.stop());
  } catch (err) {
    log.warn('[AudioSpectrum] stop failed:', err);
    return getUnavailableStatus(err instanceof Error ? err.message : String(err));
  }
};

const syncCaptureForSubscriptions = (): AudioSpectrumStatus => {
  if (subscriptions.size === 0) return stopCapture();

  const nativeCapture = getCapture();
  if (!nativeCapture) return getUnavailableStatus('echo-spectrum-capture native addon 未加载');

  const options = getMergedOptions();
  const nextOptionsKey = JSON.stringify(options);
  if (pollingTimer && currentOptionsKey === nextOptionsKey) {
    try {
      return withSubscriberCount(nativeCapture.getStatus());
    } catch (err) {
      log.warn('[AudioSpectrum] getStatus failed:', err);
      return getUnavailableStatus(err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const status = withSubscriberCount(nativeCapture.start(options));
    currentOptionsKey = nextOptionsKey;
    if (status.running) startPolling(options.fps);
    else stopPolling();
    return status;
  } catch (err) {
    log.warn('[AudioSpectrum] start failed:', err);
    stopPolling();
    return getUnavailableStatus(err instanceof Error ? err.message : String(err));
  }
};

const getStatus = (): AudioSpectrumStatus => {
  const nativeCapture = getCapture();
  if (!nativeCapture) return getUnavailableStatus('echo-spectrum-capture native addon 未加载');

  try {
    return withSubscriberCount(nativeCapture.getStatus());
  } catch (err) {
    log.warn('[AudioSpectrum] getStatus failed:', err);
    return getUnavailableStatus(err instanceof Error ? err.message : String(err));
  }
};

const getSnapshot = (): AudioSpectrumFrame | null => {
  const nativeCapture = getCapture();
  if (!nativeCapture) return null;

  try {
    return nativeCapture.getSnapshot();
  } catch (err) {
    log.warn('[AudioSpectrum] getSnapshot failed:', err);
    return null;
  }
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

export const registerAudioSpectrumIpc = () => {
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
  stopCapture();
  ipcMain.removeHandler('audio-spectrum:get-status');
  ipcMain.removeHandler('audio-spectrum:get-snapshot');
  ipcMain.removeHandler('audio-spectrum:subscribe');
  ipcMain.removeHandler('audio-spectrum:unsubscribe');
};
