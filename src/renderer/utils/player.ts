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
  private audioCtx: AudioContext | null;
  private gainNode: GainNode | null;
  private sourceNode: MediaElementAudioSourceNode | null;
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
    this.audio = null;
    this.audioCtx = null;
    this.gainNode = null;
    this.sourceNode = null;
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

  // 初始化 Web Audio API 上下文和 GainNode
  private ensureAudioContext(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext();
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.volumeValue;
    this.gainNode.connect(this.audioCtx.destination);
  }

  // 将 audio 元素连接到 Web Audio API
  private connectAudioNode(): void {
    if (!this.audio || !this.audioCtx || !this.gainNode) return;
    // 断开旧连接
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // 忽略
      }
      this.sourceNode = null;
    }
    try {
      this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
      this.sourceNode.connect(this.gainNode);
    } catch (e) {
      logger.warn('PlayerEngine', '连接 AudioContext 失败', e);
    }
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

  private async applySinkId(): Promise<boolean> {
    if (!this.audio) return true;
    const nextSinkId = this.preferredSinkId || 'default';
    const mediaNode = this.audio as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (typeof mediaNode.setSinkId !== 'function') {
      logger.warn('PlayerEngine', 'setSinkId 不支持', { requestedDeviceId: nextSinkId });
      return nextSinkId === 'default';
    }
    try {
      await mediaNode.setSinkId(nextSinkId);
      logger.info('PlayerEngine', 'setSinkId 成功', { requestedDeviceId: nextSinkId });
      return true;
    } catch (error) {
      logger.warn('PlayerEngine', 'setSinkId 失败', { requestedDeviceId: nextSinkId, error });
      return false;
    }
  }

  private cancelPendingFade(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    // 取消 GainNode 上的调度
    if (this.gainNode && this.audioCtx) {
      try {
        this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
        this.gainNode.gain.value = this.volumeValue;
      } catch {
        // 忽略
      }
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
    if (!this.audio) return;
    const el = this.audio;
    this.audio = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
    // 断开 Web Audio 连接
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* 忽略 */
      }
      this.sourceNode = null;
    }
  }

  private buildAudio(url: string): void {
    this.cleanup();
    this.ensureAudioContext();

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.volume = 1; // 音量由 GainNode 控制
    this.audio = el;

    // 连接到 Web Audio API
    this.connectAudioNode();

    el.addEventListener('loadedmetadata', () => {
      this.emitDurationChange();
      void this.applySinkId();
    });
    el.addEventListener('canplay', () => {
      this.emitDurationChange();
    });
    el.addEventListener('play', () => {
      // 确保 AudioContext 处于运行状态
      if (this.audioCtx?.state === 'suspended') {
        void this.audioCtx.resume();
      }
      this.events.play?.();
      this.startTimeUpdates();
    });
    el.addEventListener('pause', () => {
      this.events.pause?.();
      this.stopTimeUpdates();
    });
    el.addEventListener('ended', () => {
      this.stopTimeUpdates();
      this.events.ended?.();
    });
    el.addEventListener('error', () => {
      this.handleError(el.error);
    });

    el.src = url;
    el.load();
  }

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    if (this.gainNode) {
      this.gainNode.gain.value = next;
    }
    return next;
  }

  // 参考 SPlayer：Web Audio API 原生淡入淡出
  private applyFadeTo(targetValue: number, durationSec: number): void {
    if (!this.gainNode || !this.audioCtx) return;
    const currentTime = this.audioCtx.currentTime;
    const currentValue = this.gainNode.gain.value;
    this.gainNode.gain.cancelScheduledValues(currentTime);
    this.gainNode.gain.setValueAtTime(currentValue, currentTime);
    if (durationSec <= 0) {
      const safeTime = currentTime + 0.02;
      this.gainNode.gain.linearRampToValueAtTime(targetValue, safeTime);
      return;
    }
    const safeStart = currentTime + 0.02;
    this.gainNode.gain.setValueAtTime(currentValue, safeStart);
    this.gainNode.gain.linearRampToValueAtTime(targetValue, safeStart + durationSec);
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const next = clamp(value, 0, 1);
    this.cancelPendingFade();
    if (!this.gainNode || !this.audioCtx || durationMs <= 0) {
      this.setVolume(next);
      return Promise.resolve();
    }

    const fadeSeq = ++this.fadeSeq;
    this.applyFadeTo(next, durationMs / 1000);
    this.volumeValue = next;

    return new Promise((resolve) => {
      this.pendingFadeResolve = resolve;
      this.fadeTimer = window.setTimeout(() => {
        if (fadeSeq === this.fadeSeq && this.gainNode) {
          this.gainNode.gain.cancelScheduledValues(0);
          this.gainNode.gain.value = next;
        }
        this.fadeTimer = null;
        this.pendingFadeResolve = null;
        resolve();
      }, durationMs + 50);
    });
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.5, 2);
    this.playbackRateValue = next;
    if (this.audio) this.audio.playbackRate = next;
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
    this.buildAudio(url);
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    this.preferredSinkId = deviceId || 'default';
    logger.info('PlayerEngine', '设置输出设备', { requestedDeviceId: this.preferredSinkId });
    return this.applySinkId();
  }

  async play(options?: { fadeIn?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (!this.audio) return;
    if (this.audioCtx?.state === 'suspended') {
      await this.audioCtx.resume();
    }
    const durationSec = options?.fadeIn ? (options.fadeDurationMs ?? 500) / 1000 : 0;
    // 淡入：先静音
    if (durationSec > 0 && this.gainNode && this.audioCtx) {
      this.gainNode.gain.cancelScheduledValues(0);
      this.gainNode.gain.value = 0;
    }
    try {
      await this.audio.play();
      // 播放开始后再设置淡入 ramp
      if (durationSec > 0) {
        this.applyFadeTo(this.volumeValue, durationSec);
      }
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    if (!this.audio) return;
    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0 && this.gainNode && this.audioCtx) {
      this.applyFadeTo(0, durationMs / 1000);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
    this.audio.pause();
    // 恢复 gain 值
    if (this.gainNode) {
      this.gainNode.gain.cancelScheduledValues(0);
      this.gainNode.gain.value = this.volumeValue;
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
