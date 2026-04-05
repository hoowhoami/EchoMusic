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
    const sound = (this.howl as unknown as { _sounds?: Array<{ _node?: HTMLAudioElement }> } | null)?._sounds?.[0];
    const node = sound?._node;
    return node instanceof HTMLAudioElement ? node : null;
  }

  private async applySinkId(node?: HTMLAudioElement | null): Promise<boolean> {
    const targetNode = node ?? this.getAudioNode();
    if (!targetNode) {
      logger.debug('PlayerEngine', 'Skip applySinkId because audio node is not ready yet', {
        preferredSinkId: this.preferredSinkId,
      });
      return true;
    }

    const nextSinkId = this.preferredSinkId || 'default';
    const mediaNode = targetNode as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
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

  private cleanupHowl(): void {
    this.stopTimeUpdates();
    this.cancelPendingFade();
    if (!this.howl) return;
    const currentHowl = this.howl;
    this.howl = null;
    currentHowl.stop();
    currentHowl.off();
    currentHowl.unload();
  }

  private buildHowl(url: string): void {
    this.cleanupHowl();
    this.howl = new Howl({
      src: [url],
      html5: true,
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
      onstop: () => {
        this.events.pause?.();
        this.stopTimeUpdates();
      },
      onend: () => {
        this.stopTimeUpdates();
        this.events.ended?.();
      },
      onloaderror: (_id, error) => {
        this.handleError(error);
      },
      onplayerror: (_id, error) => {
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
    this.howl?.volume(next);
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const next = clamp(value, 0, 1);
    this.cancelPendingFade();
    if (!this.howl || durationMs <= 0) {
      this.setVolume(next);
      return Promise.resolve();
    }

    const from = this.volumeValue;
    const fadeSeq = ++this.fadeSeq;
    this.howl.fade(from, next, durationMs);

    return new Promise((resolve) => {
      this.pendingFadeResolve = resolve;
      this.fadeTimer = window.setTimeout(() => {
        if (fadeSeq === this.fadeSeq) {
          this.volumeValue = next;
        }
        this.fadeTimer = null;
        this.pendingFadeResolve = null;
        resolve();
      }, durationMs);
    });
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.5, 2);
    this.playbackRateValue = next;
    this.howl?.rate(next);
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
      // ignore MediaMetadata errors
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
        // ignore unsupported browsers
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
    logger.info('PlayerEngine', 'Set preferred output device', {
      requestedDeviceId: this.preferredSinkId,
    });
    return this.applySinkId();
  }

  async play(): Promise<void> {
    if (!this.howl) return;
    try {
      this.howl.play();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  pause(): void {
    this.howl?.pause();
  }

  seek(time: number): void {
    if (!this.howl) return;
    this.howl.seek(time);
    this.emitTimeUpdate();
  }

  reset(): void {
    this.cleanupHowl();
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
    const value = this.howl.seek();
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
