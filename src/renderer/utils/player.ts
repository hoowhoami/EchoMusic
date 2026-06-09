import logger from './logger';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';

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
  /** 歌曲时长，单位毫秒（用于原生媒体控制） */
  durationMs?: number;
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
const LOAD_READY_TIMEOUT_MS = 15000;

// player preload API（类型来自 electron.d.ts）
const player = window.electron?.player;

// 原生媒体控制 preload API
const mediaControls = window.electron?.mediaControls;

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
  // 原生媒体控制始终尝试调用，IPC handler 在主进程侧做降级
  private lastMediaStateStatus = '';
  private lastTimelineSyncMs = 0;
  // 时间更新节流
  private lastTimeUpdateMs = 0;
  private readonly TIME_UPDATE_THROTTLE_MS = 250;
  private loadPromise: Promise<void> = Promise.resolve();
  private loadSeq = 0;
  private loadReadyResolve: (() => void) | null = null;
  private loadReadyReject: ((error: unknown) => void) | null = null;
  private loadReadyTimer: number | null = null;

  constructor() {
    if (player) {
      this.bindPlayerEvents();
    } else {
      logger.error('PlayerEngine', 'player engine API not available');
    }
  }

  // ── player 事件监听 ──

  private bindPlayerEvents(): void {
    const offTime = player.onTimeUpdate((time: number) => {
      if (time === this.lastTimeValue) return;
      this.lastTimeValue = time;
      // 节流：限制时间更新频率
      const now = Date.now();
      if (now - this.lastTimeUpdateMs < this.TIME_UPDATE_THROTTLE_MS) return;
      this.lastTimeUpdateMs = now;
      this.events.timeUpdate?.(time);
    });
    this.cleanupFns.push(offTime);

    const offDuration = player.onDurationChange((duration: number) => {
      if (duration === this.durationValue) return;
      this.durationValue = duration;
      this.events.durationChange?.(duration);
    });
    this.cleanupFns.push(offDuration);

    const offState = player.onStateChange((state: { playing?: boolean; paused?: boolean }) => {
      if (state.playing) {
        this.events.play?.();
      } else if (state.paused) {
        this.events.pause?.();
      }
    });
    this.cleanupFns.push(offState);

    const offEnd = player.onPlaybackEnd((reason: string) => {
      if (reason === 'eof') {
        this.events.ended?.();
      } else if (reason === 'error') {
        this.events.error?.(
          new CustomEvent('error', {
            detail: { reason: 'playback-end' },
          }),
        );
      }
    });
    this.cleanupFns.push(offEnd);

    const offFileLoaded = player.onFileLoaded(() => {
      this.resolveCurrentLoad();
    });
    this.cleanupFns.push(offFileLoaded);

    const offError = player.onError((message: string) => {
      logger.error('PlayerEngine', 'player error', { message });
      this.rejectCurrentLoad(new Error(message || 'player load failed'));
      this.events.error?.(
        new CustomEvent('error', {
          detail: { message: message || 'player playback failed' },
        }),
      );
    });
    this.cleanupFns.push(offError);
  }

  // ── 公开 API ──

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs?: number, label = 'operation'): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    let timer: number | null = null;
    const timeout = new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== null) window.clearTimeout(timer);
    });
  }

  private beginLoadWait(): number {
    this.rejectCurrentLoad(new Error('player load superseded'));
    const seq = ++this.loadSeq;
    if (!player) {
      this.loadPromise = Promise.resolve();
      return seq;
    }
    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.loadReadyResolve = () => {
        this.clearLoadWait();
        resolve();
      };
      this.loadReadyReject = (error: unknown) => {
        this.clearLoadWait();
        reject(error);
      };
      this.loadReadyTimer = window.setTimeout(() => {
        this.rejectLoad(seq, new Error('player load timed out'));
      }, LOAD_READY_TIMEOUT_MS);
    });
    return seq;
  }

  private clearLoadWait(): void {
    if (this.loadReadyTimer !== null) {
      window.clearTimeout(this.loadReadyTimer);
      this.loadReadyTimer = null;
    }
    this.loadReadyResolve = null;
    this.loadReadyReject = null;
  }

  private resolveCurrentLoad(): void {
    this.loadReadyResolve?.();
  }

  private rejectCurrentLoad(error: unknown): void {
    this.loadReadyReject?.(error);
  }

  private rejectLoad(seq: number, error: unknown): void {
    if (seq !== this.loadSeq) return;
    this.rejectCurrentLoad(error);
  }

  setSource(url: string, options?: { force?: boolean }): void {
    if (!url || (this.sourceUrl === url && !options?.force)) return;
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    const loadSeq = this.beginLoadWait();

    // 解析 MKV 音轨标记：player-mkv://track=N&url=...
    if (url.startsWith('player-mkv://')) {
      const params = new URLSearchParams(url.slice('player-mkv://'.length));
      const trackId = parseInt(params.get('track') || '1', 10);
      const mkvUrl = params.get('url') || '';
      void Promise.resolve(player?.loadMkvTrack(mkvUrl, trackId)).catch((error: unknown) => {
        this.rejectLoad(loadSeq, error);
      });
    } else {
      void Promise.resolve(player?.load(url)).catch((error: unknown) => {
        this.rejectLoad(loadSeq, error);
      });
    }
  }

  /** 加载 MKV 并选择指定音轨 */
  setMkvSource(url: string, audioTrackId: number): void {
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    const loadSeq = this.beginLoadWait();
    void Promise.resolve(player?.loadMkvTrack(url, audioTrackId)).catch((error: unknown) => {
      this.rejectLoad(loadSeq, error);
    });
  }

  async play(options?: {
    fadeIn?: boolean;
    fadeDurationMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    await this.loadPromise;
    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      logger.info('PlayerEngine', 'Fade in started', {
        targetVolume: this.volumeValue,
        durationMs,
      });
      // 复合命令：主进程内完成 setVolume(0) → play → fade，fade 不阻塞
      await this.withTimeout(
        player?.playWithFade(this.volumeValue, durationMs) ?? Promise.resolve(),
        options?.timeoutMs,
        'player play',
      );
    } else {
      await this.withTimeout(
        player?.play() ?? Promise.resolve(),
        options?.timeoutMs,
        'player play',
      );
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      // 非阻塞调用：淡出在 Rust 后台线程执行，不阻塞 UI
      await player?.pauseWithFade(this.volumeValue, durationMs);
    } else {
      await player?.pause();
    }
  }

  seek(time: number): void {
    this.loadPromise
      .then(() => player?.seek(time))
      .catch((err: unknown) => {
        logger.warn('PlayerEngine', 'seek failed', { time, error: String(err) });
      });
    this.lastTimeValue = time;
    this.events.timeUpdate?.(time);
  }

  setEqualizer(gains: number[]): void {
    player?.setEqualizer(gains.map((gain) => Number(gain) || 0));
  }

  setImpulseResponse(filePath: string | null, mix = 0.4): void {
    const payload: ImpulseResponsePlaybackOptions = {
      filePath: filePath || '',
      mix: clamp(Number(mix) || 0.4, 0.1, 1),
    };
    player?.setImpulseResponse(payload);
  }

  async getAudioFilter(): Promise<string> {
    return (await player?.getAudioFilter()) || '';
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    player?.setVolume(next);
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const to = clamp(value, 0, 1);
    const from = this.volumeValue;
    this.volumeValue = to;
    if (durationMs <= 0) {
      player?.setVolume(to);
      return Promise.resolve();
    }
    // fade 完成或被取消后，同步最终音量到 player，防止音量卡在中间值
    return (player?.fade(from, to, durationMs) ?? Promise.resolve()).then(() => {
      player?.setVolume(this.volumeValue);
    });
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    player?.setSpeed(next);
    return next;
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    try {
      // default 映射为 player 的 auto
      const playerDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
      await player?.setAudioDevice(playerDevice);
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.loadSeq += 1;
    this.clearLoadWait();
    this.loadPromise = Promise.resolve();
    player?.stop();
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  /** 设置 player 文件循环模式（单曲循环用） */
  setLoopFile(loop: boolean): void {
    player?.setLoopFile(loop);
  }

  // ── 音量均衡 ──

  setVolumeNormalization(enabled: boolean): void {
    this.normalizationEnabled = enabled;
    if (!enabled) {
      player?.setNormalizationGain(0);
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
      player?.setNormalizationGain(0);
      return;
    }
    const { lufs } = loudness;
    if (!Number.isFinite(lufs)) {
      this.normalizationGain = 1.0;
      player?.setNormalizationGain(0);
      return;
    }
    const gainLinear = this.computeNormalizationGain(loudness);
    const gainDb = 20 * Math.log10(gainLinear);
    this.normalizationGain = gainLinear;
    player?.setNormalizationGain(gainDb);
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

  // ── 系统媒体控制（通过主进程 native addon） ──

  /** 更新系统媒体控制的歌曲元数据 */
  updateMediaMetadata(meta: MediaSessionMeta): void {
    const coverUrl = meta.artwork?.[meta.artwork.length - 1]?.src;

    // 调试日志：打印发送给主进程的封面 URL
    logger.debug('MediaSession', 'updateMediaMetadata:', {
      title: meta.title,
      artist: meta.artist,
      coverUrl,
      artworkCount: meta.artwork?.length,
    });

    mediaControls?.updateMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album ?? '',
      coverUrl,
      durationMs: meta.durationMs || 0,
    });
  }

  /** 更新系统媒体控制的播放状态和进度 */
  updateMediaPlaybackState(state: MediaSessionState): void {
    // 播放状态变化时才发送，避免重复 IPC
    const newStatus = state.isPlaying ? 'Playing' : 'Paused';
    if (newStatus !== this.lastMediaStateStatus) {
      this.lastMediaStateStatus = newStatus;
      mediaControls?.updateState({ status: newStatus });
    }
    // 进度节流：每 2 秒同步一次
    if (state.duration > 0) {
      const now = Date.now();
      if (now - this.lastTimelineSyncMs >= 2000) {
        this.lastTimelineSyncMs = now;
        mediaControls?.updateTimeline({
          currentTimeMs: (state.currentTime || 0) * 1000,
          totalTimeMs: (state.duration || 0) * 1000,
        });
      }
    }
  }

  /** 注册系统媒体控制事件处理（通过主进程 IPC 转发） */
  setMediaSessionHandlers(handlers: {
    play?: () => void;
    pause?: () => void;
    previoustrack?: () => void;
    nexttrack?: () => void;
    seekto?: (time: number) => void;
    seekbackward?: (offset: number) => void;
    seekforward?: (offset: number) => void;
  }): void {
    // 监听主进程转发的原生媒体控制事件
    const offEvent = mediaControls?.onEvent?.((event: { type: string; positionMs?: number }) => {
      switch (event.type) {
        case 'Play':
          handlers.play?.();
          break;
        case 'Pause':
          handlers.pause?.();
          break;
        case 'NextSong':
          handlers.nexttrack?.();
          break;
        case 'PreviousSong':
          handlers.previoustrack?.();
          break;
        case 'Seek':
          if (event.positionMs !== undefined) {
            handlers.seekto?.(event.positionMs / 1000);
          }
          break;
      }
    });
    if (offEvent) this.cleanupFns.push(offEvent);
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
