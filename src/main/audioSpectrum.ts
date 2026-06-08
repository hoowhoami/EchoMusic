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

export interface AudioSpectrumController {
  startSpectrum(options: AudioSpectrumOptions): AudioSpectrumStatus;
  stopSpectrum(): AudioSpectrumStatus;
  getSpectrumSnapshot(): AudioSpectrumFrame | null;
  getSpectrumStatus(): AudioSpectrumStatus;
}

export type AudioSpectrumControllerRef = {
  current: AudioSpectrumController | null;
};

type AudioSpectrumSubscription = {
  id: string;
  pluginId: string;
  webContents: WebContents;
  options: Required<AudioSpectrumOptions>;
  lastSentAt: number;
  lastFrameTimestamp: number;
};

const DEFAULT_OPTIONS: Required<AudioSpectrumOptions> = {
  fps: 30,
  binCount: 128,
  fftSize: 2048,
  smoothing: 0.72,
  minFrequency: 20,
  maxFrequency: 20000,
  scale: 'log',
  includeWaveform: false,
};

const subscriptions = new Map<string, AudioSpectrumSubscription>();
const destroyedWebContents = new WeakSet<WebContents>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let registered = false;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeFps = (value: unknown) => {
  const fps = Math.round(Number(value));
  if (!Number.isFinite(fps) || fps <= 0) return DEFAULT_OPTIONS.fps;
  return clamp(fps, 1, 60);
};

const normalizePowerOfTwo = (value: unknown, fallback: number, min: number, max: number) => {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next <= 0) return fallback;
  let power = 1;
  while (power < next) power *= 2;
  return clamp(power, min, max);
};

const normalizeOptions = (
  options: AudioSpectrumOptions | undefined,
): Required<AudioSpectrumOptions> => {
  const minFrequency = clamp(
    Math.round(Number(options?.minFrequency ?? DEFAULT_OPTIONS.minFrequency)),
    1,
    96000,
  );
  const maxFrequency = clamp(
    Math.round(Number(options?.maxFrequency ?? DEFAULT_OPTIONS.maxFrequency)),
    minFrequency + 1,
    96000,
  );

  return {
    fps: normalizeFps(options?.fps),
    binCount: clamp(
      Math.round(Number(options?.binCount ?? DEFAULT_OPTIONS.binCount)) || DEFAULT_OPTIONS.binCount,
      8,
      512,
    ),
    fftSize: normalizePowerOfTwo(options?.fftSize, DEFAULT_OPTIONS.fftSize, 256, 8192),
    smoothing: clamp(Number(options?.smoothing ?? DEFAULT_OPTIONS.smoothing), 0, 0.95),
    minFrequency,
    maxFrequency,
    scale:
      options?.scale === 'linear' || options?.scale === 'mel' || options?.scale === 'log'
        ? options.scale
        : DEFAULT_OPTIONS.scale,
    includeWaveform: Boolean(options?.includeWaveform),
  };
};

const getSubscriptionKey = (webContents: WebContents, subscriptionId: string) =>
  `${webContents.id}:${String(subscriptionId || '').trim()}`;

const mergeOptions = (): AudioSpectrumOptions => {
  if (subscriptions.size === 0) return DEFAULT_OPTIONS;

  const values = Array.from(subscriptions.values()).map((item) => item.options);
  return {
    fps: Math.max(...values.map((item) => item.fps)),
    binCount: Math.max(...values.map((item) => item.binCount)),
    fftSize: Math.max(...values.map((item) => item.fftSize)),
    smoothing: Math.max(...values.map((item) => item.smoothing)),
    minFrequency: Math.min(...values.map((item) => item.minFrequency)),
    maxFrequency: Math.max(...values.map((item) => item.maxFrequency)),
    scale: values.find((item) => item.scale !== 'log')?.scale ?? DEFAULT_OPTIONS.scale,
    includeWaveform: values.some((item) => item.includeWaveform),
  };
};

const withSubscriberCount = (
  status: AudioSpectrumStatus | null | undefined,
): AudioSpectrumStatus => ({
  available: Boolean(status?.available),
  running: Boolean(status?.running),
  provider: status?.provider ?? 'unavailable',
  reason: status?.reason,
  subscriberCount: subscriptions.size,
});

const getUnavailableStatus = (reason = 'mpv 播放引擎不可用'): AudioSpectrumStatus => ({
  available: false,
  running: false,
  provider: 'unavailable',
  reason,
  subscriberCount: subscriptions.size,
});

const normalizeFrame = (frame: AudioSpectrumFrame | null): AudioSpectrumFrame | null => {
  if (!frame) return null;
  return {
    ...frame,
    timePos: typeof frame.timePos === 'number' ? frame.timePos : null,
    bins: Array.from(frame.bins ?? []),
    waveform: frame.waveform ? Array.from(frame.waveform) : undefined,
  };
};

const stopPollTimer = () => {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
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

const syncNativeSpectrum = (ref: AudioSpectrumControllerRef): AudioSpectrumStatus => {
  const controller = ref.current;
  if (!controller) return getUnavailableStatus();

  try {
    if (subscriptions.size === 0) {
      stopPollTimer();
      return withSubscriberCount(controller.stopSpectrum());
    }
    return withSubscriberCount(controller.startSpectrum(mergeOptions()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '频谱分析器启动失败');
    log.warn('[AudioSpectrum] Native spectrum sync failed:', error);
    return getUnavailableStatus(message);
  }
};

const ensurePollTimer = (ref: AudioSpectrumControllerRef) => {
  if (pollTimer || subscriptions.size === 0) return;

  pollTimer = setInterval(() => {
    if (subscriptions.size === 0) {
      stopPollTimer();
      return;
    }

    const controller = ref.current;
    if (!controller) return;

    const now = Date.now();
    let hasDueSubscriber = false;
    for (const subscription of Array.from(subscriptions.values())) {
      if (subscription.webContents.isDestroyed()) {
        subscriptions.delete(getSubscriptionKey(subscription.webContents, subscription.id));
        continue;
      }

      const interval = 1000 / subscription.options.fps;
      if (now - subscription.lastSentAt >= interval) {
        hasDueSubscriber = true;
      }
    }
    if (!hasDueSubscriber) return;

    let frame: AudioSpectrumFrame | null = null;
    try {
      frame = normalizeFrame(controller.getSpectrumSnapshot());
    } catch (error) {
      log.warn('[AudioSpectrum] Failed to read spectrum snapshot:', error);
      frame = null;
    }
    if (!frame) return;

    const frameTimestamp = Math.round(Number(frame.timestamp) || 0);
    for (const subscription of Array.from(subscriptions.values())) {
      if (subscription.webContents.isDestroyed()) {
        subscriptions.delete(getSubscriptionKey(subscription.webContents, subscription.id));
        continue;
      }

      const interval = 1000 / subscription.options.fps;
      if (now - subscription.lastSentAt < interval) continue;
      subscription.lastSentAt = now;
      if (frameTimestamp && subscription.lastFrameTimestamp === frameTimestamp) continue;
      subscription.lastFrameTimestamp = frameTimestamp;
      subscription.webContents.send('audio-spectrum:frame', subscription.id, frame);
    }
  }, 1000 / 60);
};

export const registerAudioSpectrumIpc = (ref: AudioSpectrumControllerRef) => {
  if (registered) return;
  registered = true;

  ipcMain.handle('audio-spectrum:get-status', () =>
    withSubscriberCount(ref.current?.getSpectrumStatus() ?? getUnavailableStatus()),
  );

  ipcMain.handle('audio-spectrum:get-snapshot', () => {
    try {
      return normalizeFrame(ref.current?.getSpectrumSnapshot() ?? null);
    } catch (error) {
      log.warn('[AudioSpectrum] Failed to get snapshot:', error);
      return null;
    }
  });

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
        options: normalizeOptions(payload?.options),
        lastSentAt: 0,
        lastFrameTimestamp: 0,
      });

      if (!destroyedWebContents.has(webContents)) {
        destroyedWebContents.add(webContents);
        webContents.once('destroyed', () => {
          if (removeWebContentsSubscriptions(webContents)) {
            syncNativeSpectrum(ref);
          }
        });
      }

      const status = syncNativeSpectrum(ref);
      ensurePollTimer(ref);
      return { ok: true, status };
    },
  );

  ipcMain.handle(
    'audio-spectrum:unsubscribe',
    (event, payload: AudioSpectrumUnsubscribePayload): AudioSpectrumStatus => {
      const subscriptionId = String(payload?.subscriptionId || '').trim();
      if (subscriptionId) {
        subscriptions.delete(getSubscriptionKey(event.sender, subscriptionId));
      }
      return syncNativeSpectrum(ref);
    },
  );
};

export const unregisterAudioSpectrumIpc = () => {
  if (!registered) return;
  registered = false;
  subscriptions.clear();
  stopPollTimer();
  ipcMain.removeHandler('audio-spectrum:get-status');
  ipcMain.removeHandler('audio-spectrum:get-snapshot');
  ipcMain.removeHandler('audio-spectrum:subscribe');
  ipcMain.removeHandler('audio-spectrum:unsubscribe');
};
