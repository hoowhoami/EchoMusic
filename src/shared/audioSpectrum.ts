export type AudioSpectrumSource = 'player' | 'silence' | 'unavailable';
export type AudioSpectrumPlaybackState = 'playing' | 'paused' | 'idle';
export type AudioSpectrumScale = 'linear' | 'log' | 'mel';
export type AudioSpectrumProvider = 'player' | 'unavailable';

export interface AudioSpectrumOptions {
  fps?: number;
  binCount?: number;
  fftSize?: number;
  smoothing?: number;
  minFrequency?: number;
  maxFrequency?: number;
  scale?: AudioSpectrumScale;
  includeWaveform?: boolean;
}

export interface AudioSpectrumFrame {
  source: AudioSpectrumSource;
  state: AudioSpectrumPlaybackState;
  timestamp: number;
  timePos: number | null;
  sampleRate: number;
  fftSize: number;
  minFrequency: number;
  maxFrequency: number;
  /**
   * Frequency magnitudes normalized to 0..1 from the player engine.
   */
  bins: number[];
  waveform?: number[];
  rms: number;
  peak: number;
}

export interface AudioSpectrumStatus {
  available: boolean;
  running: boolean;
  provider: AudioSpectrumProvider;
  reason?: string;
  subscriberCount?: number;
}

export interface AudioSpectrumSubscribePayload {
  subscriptionId: string;
  pluginId?: string;
  options?: AudioSpectrumOptions;
}

export interface AudioSpectrumUnsubscribePayload {
  subscriptionId: string;
}

export interface AudioSpectrumSetPausedPayload {
  subscriptionId: string;
  paused: boolean;
}

/**
 * 订阅者是否处于「暂停投递」状态。暂停的订阅仍然保留在订阅表中（便于恢复），
 * 但不再参与 getMergedOptions 的参数合并，也不会收到任何帧。
 */
export interface AudioSpectrumSubscriptionState {
  paused: boolean;
}

/**
 * subscribe() 的返回值：本身可调用以退订，同时提供 setPaused 供渲染进程在
 * 页面不可见时暂停投递（订阅保留、参数合并不受其影响），重新可见时恢复。
 */
export type AudioSpectrumSubscriptionHandle = (() => void) & {
  setPaused: (paused: boolean) => void;
};

export type AudioSpectrumSubscribeResult =
  | {
      ok: true;
      status: AudioSpectrumStatus;
    }
  | {
      ok: false;
      error: string;
      status?: AudioSpectrumStatus;
    };

export const audioSpectrumOptionsIncludeWaveform = (
  options: Iterable<AudioSpectrumOptions | undefined>,
) => {
  for (const option of options) {
    if (option?.includeWaveform === true) return true;
  }
  return false;
};

const clampNumber = (value: unknown, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
};

/**
 * 合并多个订阅者的参数。取各订阅者的「最苛刻」并集：fps/binCount/maxFrequency 取最大值，
 * minFrequency/smoothing 取最小值，waveform 取或。
 *
 * 传入前应先过滤掉 paused 的订阅：不可见的订阅者不应抬高其他订阅者的轮询速率与载荷。
 */
export const mergeAudioSpectrumOptions = (
  optionsList: Iterable<AudioSpectrumOptions | undefined>,
): AudioSpectrumOptions => {
  let fps: number | undefined;
  let binCount: number | undefined;
  let minFrequency: number | undefined;
  let maxFrequency: number | undefined;
  let smoothing: number | undefined;

  const list = Array.from(optionsList);
  const includeWaveform = audioSpectrumOptionsIncludeWaveform(list);

  for (const options of list) {
    if (!options) continue;
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
    includeWaveform,
  };
};

export const normalizeAudioSpectrumWaveform = (value: unknown, includeWaveform: boolean) => {
  if (!includeWaveform || !Array.isArray(value)) return undefined;
  return value.map((sample) => {
    const number = Number(sample);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(-1, number));
  });
};

export const filterAudioSpectrumFrameForSubscriber = (
  frame: AudioSpectrumFrame,
  includeWaveform: boolean,
): AudioSpectrumFrame => {
  if (includeWaveform || frame.waveform === undefined) return frame;
  return { ...frame, waveform: undefined };
};
