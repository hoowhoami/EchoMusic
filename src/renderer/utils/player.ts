import logger from './logger';

export interface PlayerEngineEvents {
  timeUpdate?: (currentTime: number) => void;
  durationChange?: (duration: number) => void;
  ended?: () => void;
  play?: () => void;
  pause?: () => void;
  error?: (event: Event) => void;
}

export interface MediaSessionMeta {
  title: string;
  artist: string;
  album?: string;
  artwork?: Array<{ src: string; sizes: string; type: string }>;
}

export interface MediaSessionState {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  playbackRate: number;
}

export interface TrackLoudness {
  /** 曲目集成响度（LUFS） */
  lufs: number;
  /** 服务端建议的增益补偿（dB） */
  gain: number;
  /** 采样峰值（0 ~ 1） */
  peak: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const DEFAULT_REFERENCE_LUFS = -14.0;

// mpv preload API
const mpv = (window as any).electron?.mpv;

export class PlayerEngine {
  private events: PlayerEngineEvents = {};
  private sourceUrl = '';
  private volumeValue = 1;
  private playbackRateValue = 1;
  private durationValue = 0;
  private lastTimeValue = -1;
  private normalizationEnabled = false;
  private normalizationGain = 1.0;
  private referenceLufs = DEFAULT_REFERENCE_LUFS;
  private lastTrackLoudness: TrackLoudness | null = null;
  private cleanupFns: Array<() => void> = [];

  // 静音 audio 元素，用于激活 Chromium 的 MediaSession API
  // volume=0 + setSinkId('default') 确保不输出声音且不与 mpv 独占模式冲突
  private silentAudio: HTMLAudioElement;

  constructor() {
    this.silentAudio = new Audio();
    this.silentAudio.src =
      'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUoGAACA';
    this.silentAudio.loop = true;
    this.silentAudio.volume = 0.01;
    // 固定输出到默认设备，不跟随 mpv 独占设备
    if (typeof (this.silentAudio as any).setSinkId === 'function') {
      (this.silentAudio as any).setSinkId('default').catch(() => {});
    }

    if (mpv) {
      this.bindMpvEvents();
    } else {
      logger.error('PlayerEngine', 'mpv API not available');
    }
  }

  // ── mpv 事件监听 ──

  private bindMpvEvents(): void {
    const offTime = mpv.onTimeUpdate((time: number) => {
      if (time === this.lastTimeValue) return;
      this.lastTimeValue = time;
      this.events.timeUpdate?.(time);
    });
    this.cleanupFns.push(offTime);

    const offDuration = mpv.onDurationChange((duration: number) => {
      if (duration === this.durationValue) return;
      this.durationValue = duration;
      this.events.durationChange?.(duration);
    });
    this.cleanupFns.push(offDuration);

    const offState = mpv.onStateChange((state: { playing?: boolean; paused?: boolean }) => {
      if (state.playing) {
        this.silentAudio.play().catch(() => {});
        this.events.play?.();
      } else if (state.paused) {
        this.silentAudio.pause();
        this.events.pause?.();
      }
    });
    this.cleanupFns.push(offState);

    const offEnd = mpv.onPlaybackEnd((reason: string) => {
      if (reason === 'eof') {
        this.events.ended?.();
      } else if (reason === 'error') {
        this.events.error?.(new Event('error'));
      }
    });
    this.cleanupFns.push(offEnd);

    const offError = mpv.onError((message: string) => {
      logger.error('PlayerEngine', 'mpv error', { message });
    });
    this.cleanupFns.push(offError);
  }

  // ── 公开 API ──

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setSource(url: string): void {
    if (!url || this.sourceUrl === url) return;
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);

    // 解析 MKV 音轨标记：mpv-mkv://track=N&url=...
    if (url.startsWith('mpv-mkv://')) {
      const params = new URLSearchParams(url.slice('mpv-mkv://'.length));
      const trackId = parseInt(params.get('track') || '1', 10);
      const mkvUrl = params.get('url') || '';
      mpv?.loadMkvTrack(mkvUrl, trackId);
    } else {
      mpv?.load(url);
    }
  }

  /** 加载 MKV 并选择指定音轨 */
  setMkvSource(url: string, audioTrackId: number): void {
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    mpv?.loadMkvTrack(url, audioTrackId);
  }

  async play(options?: {
    fadeIn?: boolean;
    fadeDurationMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      const targetVolume = this.volumeValue;
      logger.info('PlayerEngine', 'Fade in started', { targetVolume, durationMs });
      await mpv?.setVolume(0);
      await mpv?.play();
      void mpv?.fade(0, targetVolume, durationMs);
    } else {
      await mpv?.play();
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      const savedVolume = this.volumeValue;
      await mpv?.fade(savedVolume, 0, durationMs);
      await mpv?.pause();
      await mpv?.setVolume(savedVolume);
      this.volumeValue = savedVolume;
    } else {
      await mpv?.pause();
    }
  }

  seek(time: number): void {
    mpv?.seek(time).catch((err: unknown) => {
      logger.warn('PlayerEngine', 'seek failed', { time, error: String(err) });
    });
    this.lastTimeValue = time;
    this.events.timeUpdate?.(time);
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    mpv?.setVolume(next);
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const to = clamp(value, 0, 1);
    const from = this.volumeValue;
    this.volumeValue = to;
    if (durationMs <= 0) {
      mpv?.setVolume(to);
      return Promise.resolve();
    }
    return mpv?.fade(from, to, durationMs) ?? Promise.resolve();
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    mpv?.setSpeed(next);
    return next;
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    try {
      // default 映射为 mpv 的 auto
      const mpvDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
      await mpv?.setAudioDevice(mpvDevice);
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    mpv?.stop();
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  // ── 音量均衡 ──

  setVolumeNormalization(enabled: boolean): void {
    this.normalizationEnabled = enabled;
    if (!enabled) {
      mpv?.setNormalizationGain(0);
      this.normalizationGain = 1.0;
    } else if (this.lastTrackLoudness) {
      // 开启时用已有的响度数据重新应用增益
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
    logger.info('PlayerEngine', 'Volume normalization toggled', { enabled });
  }

  applyTrackLoudness(loudness: TrackLoudness | null): void {
    this.lastTrackLoudness = loudness;
    if (!loudness || !this.normalizationEnabled) {
      this.normalizationGain = 1.0;
      mpv?.setNormalizationGain(0);
      return;
    }
    const { lufs } = loudness;
    if (!Number.isFinite(lufs)) {
      this.normalizationGain = 1.0;
      mpv?.setNormalizationGain(0);
      return;
    }
    const gainLinear = this.computeNormalizationGain(loudness);
    const gainDb = 20 * Math.log10(gainLinear);
    this.normalizationGain = gainLinear;
    mpv?.setNormalizationGain(gainDb);
    logger.info('PlayerEngine', 'Track loudness applied', {
      lufs,
      gainDb: gainDb.toFixed(2) + ' dB',
    });
  }

  setReferenceLufs(lufs: number): void {
    this.referenceLufs = clamp(lufs, -20, -8);
    if (this.normalizationEnabled && this.lastTrackLoudness) {
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
  }

  private computeNormalizationGain(loudness: TrackLoudness): number {
    const { lufs, gain: suggestedGain, peak } = loudness;
    let gain = Math.pow(10, (this.referenceLufs - lufs) / 20);
    if (suggestedGain !== 0) {
      gain *= Math.pow(10, suggestedGain / 20);
    }
    if (peak > 0 && peak * gain > 0.95) {
      gain = 0.95 / peak;
    }
    return clamp(gain, 0.1, 3.0);
  }

  // ── MediaSession（渲染进程浏览器 API，不依赖 mpv） ──

  updateMediaMetadata(meta: MediaSessionMeta): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: meta.album ?? '',
        artwork: meta.artwork ?? [],
      });
    } catch {}
  }

  updateMediaPlaybackState(state: MediaSessionState): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.playbackState = state.isPlaying ? 'playing' : 'paused';
    if (typeof session.setPositionState === 'function') {
      try {
        session.setPositionState({
          duration: state.duration || 0,
          playbackRate: state.playbackRate || 1,
          position: state.currentTime || 0,
        });
      } catch {}
    }
  }

  setMediaSessionHandlers(handlers: {
    play?: () => void;
    pause?: () => void;
    previoustrack?: () => void;
    nexttrack?: () => void;
    seekto?: (time: number) => void;
    seekbackward?: (offset: number) => void;
    seekforward?: (offset: number) => void;
  }): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', handlers.play ?? null);
    session.setActionHandler('pause', handlers.pause ?? null);
    session.setActionHandler('previoustrack', handlers.previoustrack ?? null);
    session.setActionHandler('nexttrack', handlers.nexttrack ?? null);
    session.setActionHandler(
      'seekto',
      handlers.seekto ? (d) => handlers.seekto?.(d.seekTime ?? 0) : null,
    );
    session.setActionHandler(
      'seekbackward',
      handlers.seekbackward ? (d) => handlers.seekbackward?.(d.seekOffset ?? 10) : null,
    );
    session.setActionHandler(
      'seekforward',
      handlers.seekforward ? (d) => handlers.seekforward?.(d.seekOffset ?? 10) : null,
    );
  }

  // ── getter ──

  get volumeNormalizationEnabled(): boolean {
    return this.normalizationEnabled;
  }
  get source(): string {
    return this.sourceUrl;
  }
  get currentTime(): number {
    return this.lastTimeValue >= 0 ? this.lastTimeValue : 0;
  }
  get duration(): number {
    return this.durationValue;
  }
  get volume(): number {
    return this.volumeValue;
  }
  get playbackRate(): number {
    return this.playbackRateValue;
  }
}
