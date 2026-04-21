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

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

export class PlayerEngine {
  private audio: HTMLAudioElement | null;
  private events: PlayerEngineEvents;
  private sourceUrl: string;
  private volumeValue: number;
  private playbackRateValue: number;
  private durationValue: number;
  private timeUpdateTimer: number | null;
  private lastTimeValue: number;
  private preferredSinkId: string;
  private fadeTimer: number | null;
  private fadeRafId: number | null;
  private pendingFadeResolve: (() => void) | null;
  private fadeSeq: number;
  // 用于批量移除 audio 事件监听器
  private abortController: AbortController | null;

  constructor() {
    this.audio = null;
    this.events = {};
    this.sourceUrl = '';
    this.volumeValue = 1;
    this.playbackRateValue = 1;
    this.durationValue = 0;
    this.timeUpdateTimer = null;
    this.lastTimeValue = -1;
    this.preferredSinkId = 'default';
    this.fadeTimer = null;
    this.fadeRafId = null;
    this.pendingFadeResolve = null;
    this.fadeSeq = 0;
    this.abortController = null;
  }

  // ── 内部：时间更新轮询 ──

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

  // ── 内部：淡入淡出 ──

  private cancelPendingFade(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
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

  // 使用 requestAnimationFrame 实现平滑音量渐变
  private animateFade(from: number, to: number, durationMs: number): Promise<void> {
    this.cancelPendingFade();
    if (!this.audio || durationMs <= 0) {
      this.setVolume(to);
      return Promise.resolve();
    }

    const fadeSeq = ++this.fadeSeq;
    const startTime = performance.now();

    return new Promise((resolve) => {
      this.pendingFadeResolve = resolve;

      const step = () => {
        if (fadeSeq !== this.fadeSeq || !this.audio) {
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

  // ── 内部：音频元素管理 ──

  private cleanup(): void {
    this.stopTimeUpdates();
    this.cancelPendingFade();
    if (!this.audio) return;
    // 先 abort 移除所有事件监听，避免 pause()/load() 触发残留回调
    this.abortController?.abort();
    this.abortController = null;
    const node = this.audio;
    this.audio = null;
    node.pause();
    node.removeAttribute('src');
    node.load(); // 释放资源
  }

  private createAudio(url: string): void {
    this.cleanup();

    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = this.volumeValue;
    audio.playbackRate = this.playbackRateValue;
    this.audio = audio;

    // 使用 AbortController 统一管理事件监听器的生命周期
    const ac = new AbortController();
    this.abortController = ac;
    const opts = { signal: ac.signal };

    audio.addEventListener(
      'loadedmetadata',
      () => {
        this.emitDurationChange();
        void this.applySinkId();
      },
      opts,
    );

    audio.addEventListener(
      'durationchange',
      () => {
        this.emitDurationChange();
      },
      opts,
    );

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
      () => {
        logger.warn('PlayerEngine', 'Audio stalled: network stall detected');
      },
      opts,
    );

    audio.addEventListener(
      'waiting',
      () => {
        logger.warn('PlayerEngine', 'Audio waiting: buffering');
      },
      opts,
    );

    audio.src = url;
  }

  // ── 内部：输出设备 ──

  private async applySinkId(): Promise<boolean> {
    if (!this.audio) {
      logger.debug('PlayerEngine', 'Skip applySinkId because audio node is not ready yet', {
        preferredSinkId: this.preferredSinkId,
      });
      return true;
    }

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

  // ── 公开 API ──

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    if (this.audio) {
      this.audio.volume = next;
    }
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const from = this.audio ? this.audio.volume : this.volumeValue;
    const to = clamp(value, 0, 1);
    this.volumeValue = to;
    return this.animateFade(from, to, durationMs);
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    if (this.audio) {
      this.audio.playbackRate = next;
    }
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
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.createAudio(url);
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.preferredSinkId = deviceId || 'default';
    logger.info('PlayerEngine', 'Set output device', { requestedDeviceId: this.preferredSinkId });
    return this.applySinkId();
  }

  async play(options?: { fadeIn?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (!this.audio) return;

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
    if (!this.audio) return;

    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;

    if (durationMs > 0) {
      // 保存真实音量，淡出会把 volumeValue 设为 0
      const savedVolume = this.volumeValue;
      const currentVolume = this.audio.volume;
      await this.animateFade(currentVolume, 0, durationMs);
      this.audio?.pause();
      // 恢复音量值，确保下次播放或新歌曲使用正确音量
      this.volumeValue = savedVolume;
      if (this.audio) {
        this.audio.volume = savedVolume;
      }
    } else {
      this.audio.pause();
    }
  }

  seek(time: number): void {
    if (!this.audio) return;
    this.audio.currentTime = time;
    this.emitTimeUpdate();
  }

  reset(): void {
    this.cleanup();
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  get source(): string {
    return this.sourceUrl;
  }

  get currentTime(): number {
    if (!this.audio) return 0;
    const value = this.audio.currentTime;
    return Number.isFinite(value) ? value : 0;
  }

  get duration(): number {
    if (!this.audio) return 0;
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
