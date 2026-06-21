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
let destroyedWebContents = new WeakSet<WebContents>();
let registered = false;
let capture: NativeSpectrumCapture | null | undefined;
let currentOptionsKey = '';
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingIntervalMs = 0;
let lastFrameTimestamp = 0;
let lastSuccessfulPollTime = 0;

const UNAVAILABLE_REASON = '系统音频频谱捕获不可用';
const POLLING_TIMEOUT_MS = 30000;

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
  lastSuccessfulPollTime = 0;
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

  // 超时检测：如果超过 30 秒没有成功轮询，自动停止
  if (lastSuccessfulPollTime > 0 && Date.now() - lastSuccessfulPollTime > POLLING_TIMEOUT_MS) {
    log.warn('[AudioSpectrum] Polling timeout, stopping capture');
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
    lastSuccessfulPollTime = Date.now();
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
  lastSuccessfulPollTime = Date.now();
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
          // 立即停止轮询，避免在清理过程中继续产生新的帧数据
          stopPolling();

          if (removeWebContentsSubscriptions(webContents)) {
            syncCaptureForSubscriptions();
          }

          // 如果没有订阅了，强制停止捕获
          if (subscriptions.size === 0) {
            stopCapture();
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

  // 强制停止所有轮询
  stopPolling();

  // 清理订阅
  subscriptions.clear();

  // 停止捕获
  stopCapture();

  // 清理 IPC handlers
  ipcMain.removeHandler('audio-spectrum:get-status');
  ipcMain.removeHandler('audio-spectrum:get-snapshot');
  ipcMain.removeHandler('audio-spectrum:subscribe');
  ipcMain.removeHandler('audio-spectrum:unsubscribe');

  // 重置 WebContents 引用
  destroyedWebContents = new WeakSet();
};
