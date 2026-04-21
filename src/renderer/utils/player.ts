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

/**
 * 曲目响度信息，用于音量均衡计算。
 * 数据来源于 getSongUrl API 响应中的 volume / volume_gain / volume_peak 字段。
 */
export interface TrackLoudness {
  /** 曲目集成响度（LUFS），例如 -10.3 */
  lufs: number;
  /** 服务端建议的增益补偿（dB），通常为 0 */
  gain: number;
  /** 采样峰值（0 ~ 1），用于防削波限幅 */
  peak: number;
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

/** 默认参考响度 -14 LUFS */
const DEFAULT_REFERENCE_LUFS = -14.0;

export class PlayerEngine {
  private audio: HTMLAudioElement;
  private events: PlayerEngineEvents;
  private sourceUrl: string;
  private volumeValue: number;
  private playbackRateValue: number;
  private durationValue: number;
  private timeUpdateTimer: number | null;
  private lastTimeValue: number;
  private preferredSinkId: string;
  private fadeRafId: number | null;
  private pendingFadeResolve: (() => void) | null;
  private fadeSeq: number;
  private abortController: AbortController;
  // 音量均衡：Web Audio API 处理链
  private audioContext: AudioContext | null;
  private sourceNode: MediaElementAudioSourceNode | null;
  private gainNode: GainNode | null;
  private normalizationEnabled: boolean;
  /** 当前生效的均衡增益系数（线性值，1.0 = 无调整） */
  private normalizationGain: number;
  /** 音量均衡参考响度（LUFS） */
  private referenceLufs: number;
  /** 当前曲目的响度数据，用于参考值变更时重算增益 */
  private lastTrackLoudness: TrackLoudness | null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this.events = {};
    this.sourceUrl = '';
    this.volumeValue = 1;
    this.playbackRateValue = 1;
    this.durationValue = 0;
    this.timeUpdateTimer = null;
    this.lastTimeValue = -1;
    this.preferredSinkId = 'default';
    this.fadeRafId = null;
    this.pendingFadeResolve = null;
    this.fadeSeq = 0;
    this.abortController = new AbortController();
    this.audioContext = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.normalizationEnabled = false;
    this.normalizationGain = 1.0;
    this.referenceLufs = DEFAULT_REFERENCE_LUFS;
    this.lastTrackLoudness = null;
    this.bindAudioEvents();
  }

  // ── 事件绑定 ──

  private bindAudioEvents(): void {
    const audio = this.audio;
    const opts = { signal: this.abortController.signal };

    audio.addEventListener(
      'loadedmetadata',
      () => {
        this.emitDurationChange();
        void this.applySinkId();
      },
      opts,
    );

    audio.addEventListener('durationchange', () => this.emitDurationChange(), opts);

    audio.addEventListener(
      'play',
      () => {
        this.events.play?.();
        this.startTimeUpdates();
      },
      opts,
    );

    audio.addEventListener(
      'pause',
      () => {
        this.events.pause?.();
        this.stopTimeUpdates();
      },
      opts,
    );

    audio.addEventListener(
      'ended',
      () => {
        this.stopTimeUpdates();
        this.events.ended?.();
      },
      opts,
    );

    audio.addEventListener(
      'error',
      () => {
        const mediaError = audio.error;
        logger.error('PlayerEngine', 'Audio error', {
          code: mediaError?.code,
          message: mediaError?.message,
        });
        const errorEvent = new Event('error');
        (errorEvent as Event & { detail?: unknown }).detail = {
          code: mediaError?.code,
          message: mediaError?.message,
        };
        this.events.error?.(errorEvent);
      },
      opts,
    );

    audio.addEventListener(
      'stalled',
      () => logger.warn('PlayerEngine', 'Audio stalled: network stall detected'),
      opts,
    );

    audio.addEventListener(
      'waiting',
      () => logger.warn('PlayerEngine', 'Audio waiting: buffering'),
      opts,
    );
  }

  // ── 时间更新 ──

  private emitDurationChange(): void {
    const duration = this.duration;
    if (!Number.isFinite(duration)) return;
    if (duration === this.durationValue) return;
    this.durationValue = duration;
    this.events.durationChange?.(duration);
  }

  private emitTimeUpdate(): void {
    const current = this.currentTime;
    if (!Number.isFinite(current)) return;
    if (current === this.lastTimeValue) return;
    this.lastTimeValue = current;
    this.events.timeUpdate?.(current);
    this.emitDurationChange();
  }

  private startTimeUpdates(): void {
    this.stopTimeUpdates();
    this.emitTimeUpdate();
    this.timeUpdateTimer = window.setInterval(() => {
      this.emitTimeUpdate();
    }, 250);
  }

  private stopTimeUpdates(): void {
    if (this.timeUpdateTimer !== null) {
      window.clearInterval(this.timeUpdateTimer);
      this.timeUpdateTimer = null;
    }
  }

  // ── 淡入淡出 ──

  private cancelPendingFade(): void {
    if (this.fadeRafId !== null) {
      cancelAnimationFrame(this.fadeRafId);
      this.fadeRafId = null;
    }
    if (this.pendingFadeResolve) {
      const resolve = this.pendingFadeResolve;
      this.pendingFadeResolve = null;
      resolve();
    }
  }

  /** 使用 requestAnimationFrame 实现平滑音量渐变 */
  private animateFade(from: number, to: number, durationMs: number): Promise<void> {
    this.cancelPendingFade();
    if (durationMs <= 0) {
      this.setVolume(to);
      return Promise.resolve();
    }

    const fadeSeq = ++this.fadeSeq;
    const startTime = performance.now();

    return new Promise((resolve) => {
      this.pendingFadeResolve = resolve;

      const step = () => {
        if (fadeSeq !== this.fadeSeq) {
          resolve();
          return;
        }
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / durationMs, 1);
        const current = from + (to - from) * progress;
        this.audio.volume = clamp(current, 0, 1);

        if (progress < 1) {
          this.fadeRafId = requestAnimationFrame(step);
        } else {
          this.fadeRafId = null;
          this.volumeValue = to;
          this.pendingFadeResolve = null;
          resolve();
        }
      };

      this.fadeRafId = requestAnimationFrame(step);
    });
  }

  // ── 音频资源管理 ──

  /** 停止播放并释放当前音频资源，复用同一个 audio 元素 */
  private stopAndUnload(): void {
    this.stopTimeUpdates();
    this.cancelPendingFade();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  // ── 输出设备 ──

  private async applySinkId(): Promise<boolean> {
    const nextSinkId = this.preferredSinkId || 'default';
    const mediaNode = this.audio as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };

    if (typeof mediaNode.setSinkId !== 'function') {
      logger.warn('PlayerEngine', 'setSinkId is not supported by current media element', {
        requestedDeviceId: nextSinkId,
      });
      return nextSinkId === 'default';
    }

    try {
      await mediaNode.setSinkId(nextSinkId);
      logger.info('PlayerEngine', 'setSinkId applied successfully', {
        requestedDeviceId: nextSinkId,
      });
      return true;
    } catch (error) {
      logger.warn('PlayerEngine', 'setSinkId failed', {
        requestedDeviceId: nextSinkId,
        error,
      });
      return false;
    }
  }

  // ── 音量均衡（Web Audio API） ──

  /**
   * 构建 Web Audio 处理链：MediaElementSource → GainNode → Destination。
   * 仅在首次启用音量均衡时调用一次，后续切歌复用同一条链路。
   */
  private initAudioGraph(): boolean {
    if (this.audioContext) return true;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.sourceNode = this.audioContext.createMediaElementSource(this.audio);
      this.gainNode = this.audioContext.createGain();
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);
      this.gainNode.gain.setValueAtTime(this.normalizationGain, this.audioContext.currentTime);
      logger.info('PlayerEngine', 'Audio processing graph initialized');
      return true;
    } catch (error) {
      logger.error('PlayerEngine', 'Failed to initialize audio processing graph', error);
      this.audioContext = null;
      this.sourceNode = null;
      this.gainNode = null;
      return false;
    }
  }

  /** 确保 AudioContext 处于运行状态（浏览器策略可能自动挂起） */
  private async ensureAudioContextRunning(): Promise<void> {
    if (!this.audioContext || this.audioContext.state !== 'suspended') return;
    try {
      await this.audioContext.resume();
    } catch (error) {
      logger.warn('PlayerEngine', 'Failed to resume AudioContext', error);
    }
  }

  /**
   * 根据曲目响度信息计算均衡增益系数。
   *
   * 算法：
   * 1. 计算当前曲目与参考响度的 dB 差值，转换为线性增益
   * 2. 叠加服务端建议的增益补偿
   * 3. 防削波：确保增益后峰值不超过 0.95
   * 4. 限幅：最终增益限制在 0.1 ~ 3.0（约 -20dB ~ +9.5dB）
   */
  private computeNormalizationGain(loudness: TrackLoudness): number {
    const { lufs, gain: suggestedGain, peak } = loudness;

    // 参考响度与曲目响度的差值 → 线性增益
    let gain = Math.pow(10, (this.referenceLufs - lufs) / 20);

    // 叠加服务端建议的增益补偿
    if (suggestedGain !== 0) {
      gain *= Math.pow(10, suggestedGain / 20);
    }

    // 防削波：增益后峰值不超过 0.95
    if (peak > 0 && peak * gain > 0.95) {
      gain = 0.95 / peak;
    }

    return clamp(gain, 0.1, 3.0);
  }

  /** 将增益系数应用到 GainNode */
  private applyGain(gain: number): void {
    if (!this.gainNode || !this.audioContext) {
      if (this.normalizationEnabled) {
        logger.warn('PlayerEngine', 'Cannot apply gain: audio graph not initialized');
      }
      return;
    }
    this.gainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
  }

  // ── 公开 API ──

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    this.audio.volume = next;
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const from = this.audio.volume;
    const to = clamp(value, 0, 1);
    this.volumeValue = to;
    return this.animateFade(from, to, durationMs);
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    this.audio.playbackRate = next;
    return next;
  }

  updateMediaMetadata(meta: MediaSessionMeta): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: meta.album ?? '',
        artwork: meta.artwork ?? [],
      });
    } catch {
      // 忽略
    }
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
      } catch {
        // 忽略
      }
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
      handlers.seekto ? (details) => handlers.seekto?.(details.seekTime ?? 0) : null,
    );
    session.setActionHandler(
      'seekbackward',
      handlers.seekbackward ? (details) => handlers.seekbackward?.(details.seekOffset ?? 10) : null,
    );
    session.setActionHandler(
      'seekforward',
      handlers.seekforward ? (details) => handlers.seekforward?.(details.seekOffset ?? 10) : null,
    );
  }

  setSource(url: string): void {
    if (!url || this.sourceUrl === url) return;
    this.stopAndUnload();
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.audio.volume = this.volumeValue;
    this.audio.playbackRate = this.playbackRateValue;
    this.audio.src = url;
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.preferredSinkId = deviceId || 'default';
    logger.info('PlayerEngine', 'Set output device', { requestedDeviceId: this.preferredSinkId });
    return this.applySinkId();
  }

  async play(options?: { fadeIn?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (this.normalizationEnabled && this.audioContext) {
      await this.ensureAudioContextRunning();
    }

    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;

    if (durationMs > 0) {
      const targetVolume = this.volumeValue;
      this.audio.volume = 0;
      await this.audio.play();
      void this.animateFade(0, targetVolume, durationMs);
    } else {
      await this.audio.play();
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;

    if (durationMs > 0) {
      const savedVolume = this.volumeValue;
      const currentVolume = this.audio.volume;
      await this.animateFade(currentVolume, 0, durationMs);
      this.audio.pause();
      this.volumeValue = savedVolume;
      this.audio.volume = savedVolume;
    } else {
      this.audio.pause();
    }
  }

  seek(time: number): void {
    this.audio.currentTime = time;
    this.emitTimeUpdate();
  }

  reset(): void {
    this.stopAndUnload();
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  // ── 音量均衡 ──

  /** 启用或禁用音量均衡 */
  setVolumeNormalization(enabled: boolean): void {
    this.normalizationEnabled = enabled;
    if (enabled) {
      this.initAudioGraph();
    }
    const gain = enabled ? this.normalizationGain : 1.0;
    this.applyGain(gain);
    logger.info('PlayerEngine', 'Volume normalization toggled', {
      enabled,
      gain: gain.toFixed(3),
    });
  }

  /**
   * 为当前曲目应用响度均衡。
   * 每次切歌后由 store 调用，传入从 API 解析的响度信息。
   * 传 null 或未启用均衡时重置增益为 1.0。
   */
  applyTrackLoudness(loudness: TrackLoudness | null): void {
    this.lastTrackLoudness = loudness;
    if (!loudness || !this.normalizationEnabled) {
      this.normalizationGain = 1.0;
      if (this.normalizationEnabled && !loudness) {
        logger.debug('PlayerEngine', 'No loudness data available, gain reset to 1.0');
      }
    } else {
      const { lufs, gain: suggestedGain, peak } = loudness;
      if (!Number.isFinite(lufs)) {
        logger.warn('PlayerEngine', 'Invalid loudness data, gain reset to 1.0', loudness);
        this.normalizationGain = 1.0;
      } else {
        this.normalizationGain = this.computeNormalizationGain(loudness);
        logger.info('PlayerEngine', 'Track loudness applied', {
          lufs,
          gain: suggestedGain,
          peak,
          normalizationGain: this.normalizationGain.toFixed(3),
          normalizationGainDb: (20 * Math.log10(this.normalizationGain)).toFixed(2) + ' dB',
        });
      }
    }
    this.applyGain(this.normalizationGain);
  }

  /** 设置音量均衡参考响度（LUFS），立即对当前歌曲生效 */
  setReferenceLufs(lufs: number): void {
    this.referenceLufs = clamp(lufs, -20, -8);
    logger.info('PlayerEngine', 'Reference LUFS updated', { referenceLufs: this.referenceLufs });
    // 用新参考值重算当前歌曲的增益
    if (this.normalizationEnabled && this.lastTrackLoudness) {
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
  }

  get volumeNormalizationEnabled(): boolean {
    return this.normalizationEnabled;
  }

  get source(): string {
    return this.sourceUrl;
  }

  get currentTime(): number {
    const value = this.audio.currentTime;
    return Number.isFinite(value) ? value : 0;
  }

  get duration(): number {
    const value = this.audio.duration;
    return Number.isFinite(value) ? value : 0;
  }

  get volume(): number {
    return this.volumeValue;
  }

  get playbackRate(): number {
    return this.playbackRateValue;
  }
}
