import { Howl } from 'howler';
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
  private howl: Howl | null;
  private events: PlayerEngineEvents;
  private sourceUrl: string;
  private volumeValue: number;
  private playbackRateValue: number;
  private durationValue: number;
  private timeUpdateTimer: number | null;
  private lastTimeValue: number;
  private preferredSinkId: string;
  private fadeTimer: number | null;
  private pendingFadeResolve: (() => void) | null;
  private fadeSeq: number;

  constructor() {
    this.howl = null;
    this.events = {};
    this.sourceUrl = '';
    this.volumeValue = 1;
    this.playbackRateValue = 1;
    this.durationValue = 0;
    this.timeUpdateTimer = null;
    this.lastTimeValue = -1;
    this.preferredSinkId = 'default';
    this.fadeTimer = null;
    this.pendingFadeResolve = null;
    this.fadeSeq = 0;
  }

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

  private handleError(payload?: unknown): void {
    const errorEvent = new Event('error');
    if (payload && typeof payload === 'object') {
      (errorEvent as Event & { detail?: unknown }).detail = payload;
    }
    this.events.error?.(errorEvent);
  }

  private getAudioNode(): HTMLAudioElement | null {
    if (!this.howl) return null;
    const howlInternal = this.howl as any;
    return howlInternal._sounds?.[0]?._node as HTMLAudioElement | null;
  }

  private async applySinkId(): Promise<boolean> {
    const audioNode = this.getAudioNode();
    if (!audioNode) {
      logger.debug('PlayerEngine', 'Skip applySinkId because audio node is not ready yet', {
        preferredSinkId: this.preferredSinkId,
      });
      return true;
    }

    const nextSinkId = this.preferredSinkId || 'default';
    const mediaNode = audioNode as HTMLAudioElement & {
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

  private cancelPendingFade(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (this.pendingFadeResolve) {
      const resolve = this.pendingFadeResolve;
      this.pendingFadeResolve = null;
      resolve();
    }
  }

  private cleanup(): void {
    this.stopTimeUpdates();
    this.cancelPendingFade();
    if (!this.howl) return;
    const sound = this.howl;
    this.howl = null;
    sound.unload();
  }

  private buildHowl(url: string): void {
    this.cleanup();

    this.howl = new Howl({
      src: [url],
      html5: true, // 使用 HTML5 Audio 以支持流式播放
      preload: true,
      volume: this.volumeValue,
      rate: this.playbackRateValue,
      onload: () => {
        this.emitDurationChange();
        void this.applySinkId();
      },
      onplay: () => {
        void this.applySinkId();
        this.events.play?.();
        this.startTimeUpdates();
      },
      onpause: () => {
        this.events.pause?.();
        this.stopTimeUpdates();
      },
      onend: () => {
        this.stopTimeUpdates();
        this.events.ended?.();
      },
      onloaderror: (_id, error) => {
        logger.error('PlayerEngine', 'Howl load error', error);
        this.handleError(error);
      },
      onplayerror: (_id, error) => {
        logger.error('PlayerEngine', 'Howl play error', error);
        this.handleError(error);
      },
    });
  }

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    if (this.howl) {
      this.howl.volume(next);
    }
    return next;
  }

  // Howler 原生支持淡入淡出
  fadeTo(value: number, durationMs = 0): Promise<void> {
    const next = clamp(value, 0, 1);
    this.cancelPendingFade();

    if (!this.howl || durationMs <= 0) {
      this.setVolume(next);
      return Promise.resolve();
    }

    const fadeSeq = ++this.fadeSeq;
    this.volumeValue = next;

    return new Promise((resolve) => {
      this.pendingFadeResolve = resolve;

      // 使用 Howler 的 fade 方法
      this.howl!.fade(this.howl!.volume(), next, durationMs);

      this.fadeTimer = window.setTimeout(() => {
        if (fadeSeq === this.fadeSeq) {
          this.volumeValue = next;
        }
        this.fadeTimer = null;
        this.pendingFadeResolve = null;
        resolve();
      }, durationMs + 50);
    });
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    if (this.howl) {
      this.howl.rate(next);
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
    this.buildHowl(url);
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.preferredSinkId = deviceId || 'default';
    logger.info('PlayerEngine', 'Set output device', { requestedDeviceId: this.preferredSinkId });
    return this.applySinkId();
  }

  async play(options?: { fadeIn?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (!this.howl) return;

    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;

    if (durationMs > 0) {
      // 淡入：先设置音量为 0，然后播放，再淡入到目标音量
      const targetVolume = this.volumeValue;
      this.howl.volume(0);
      this.howl.play();
      // 使用 Howler 的 fade 方法实现淡入
      this.howl.fade(0, targetVolume, durationMs);
    } else {
      this.howl.play();
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (!this.howl) return;

    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;

    if (durationMs > 0) {
      // 淡出：从当前音量淡出到 0，然后暂停
      const currentVolume = this.howl.volume();
      this.howl.fade(currentVolume, 0, durationMs);

      // 等待淡出完成后暂停
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      this.howl?.pause();

      // 恢复音量
      if (this.howl) {
        this.howl.volume(this.volumeValue);
      }
    } else {
      this.howl.pause();
    }
  }

  seek(time: number): void {
    if (!this.howl) return;
    this.howl.seek(time);
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
    if (!this.howl) return 0;
    const value = this.howl.seek() as number;
    return Number.isFinite(value) ? value : 0;
  }

  get duration(): number {
    if (!this.howl) return 0;
    const value = this.howl.duration();
    return Number.isFinite(value) ? value : 0;
  }

  get volume(): number {
    return this.volumeValue;
  }

  get playbackRate(): number {
    return this.playbackRateValue;
  }
}
