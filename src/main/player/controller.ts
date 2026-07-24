import { EventEmitter } from 'events';
import { app } from 'electron';
import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import log from '../logger';
import { refreshNetworkSettingsFromStorage } from '../networkSettings';
import { getKvStorage } from '../storage/kv';
import type { NetworkSettings } from '../../shared/network';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import type { PlayerErrorCode, PlayerErrorPayload } from '../../shared/player-error';
import type {
  PlayerAudioGraphParameterPatch,
  PlayerAudioGraphPlanPatch,
  PlayerAudioGraphSnapshot,
} from '../../shared/player-audio-graph';

const PINIA_SETTING_KEY = 'pinia:setting';
const DEFAULT_AUDIO_CACHE_SECS = 1;
const DEFAULT_AUDIO_CACHE_PAUSE_WAIT_SECS = 1;
const DEFAULT_AUDIO_OUTPUT_BUFFER_SECS = 0.2;
const DEFAULT_DEMUXER_MAX_MB = 150;
const DEFAULT_DEMUXER_BACK_MB = 50;
const DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS = 8;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

const readClampedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const getPersistedNativeAudioConfig = () => {
  const saved = getKvStorage().get<Record<string, unknown>>(PINIA_SETTING_KEY);
  const audioCacheSecs = readClampedNumber(saved?.audioCacheSecs, DEFAULT_AUDIO_CACHE_SECS, 1, 120);
  const audioCachePauseWaitSecs = readClampedNumber(
    saved?.audioCachePauseWaitSecs,
    DEFAULT_AUDIO_CACHE_PAUSE_WAIT_SECS,
    0.1,
    30,
  );
  const audioBufferSecs = readClampedNumber(
    saved?.audioBufferSecs,
    DEFAULT_AUDIO_OUTPUT_BUFFER_SECS,
    0.05,
    1,
  );
  const audioDemuxerMaxMB = readClampedNumber(
    saved?.audioDemuxerMaxMB,
    DEFAULT_DEMUXER_MAX_MB,
    8,
    512,
  );
  const audioDemuxerBackMB = readClampedNumber(
    saved?.audioDemuxerBackMB,
    DEFAULT_DEMUXER_BACK_MB,
    0,
    audioDemuxerMaxMB,
  );
  const playbackStallTimeoutSecs = readClampedNumber(
    saved?.playbackStallTimeout,
    DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS,
    0,
    60,
  );
  return {
    audioBufferSecs,
    audioCacheSecs,
    audioCachePauseWaitSecs,
    audioDemuxerMaxMB,
    audioDemuxerBackMB,
    playbackStallTimeoutSecs,
  };
};

interface PlayerAddonEvent {
  event: string;
  eventId?: number;
  trackSeq?: number;
  generation?: number;
  time?: number;
  duration?: number;
  state?: PlayerState;
  reason?: string;
  message?: string;
  errorCode?: PlayerErrorCode;
  level?: string;
  devices?: Array<{ name: string; description: string; isDefault?: boolean }>;
  deviceChangeKind?: string;
  disconnectedDevices?: Array<{ name: string; description: string; isDefault?: boolean }>;
  path?: string;
  seq?: number;
  coreState?: string;
  cachePaused?: boolean;
  cacheBufferingState?: number;
  cacheBufferedSecs?: number;
  cacheTargetSecs?: number;
  packetCache?: {
    forwardBytes: number;
    backBytes: number;
    totalBytes: number;
    forwardSecs?: number;
    seekableStartSecs?: number;
    seekableEndSecs?: number;
    eof: boolean;
    pendingSeek: boolean;
    hasError: boolean;
  };
  outputStats?: {
    backend: string;
    sampleRate: number;
    engineSampleRate: number;
    channels: number;
    format: string;
    bufferFrames: number;
    bufferSecs: number;
    delaySecs: number;
    underruns: number;
  };
  audioGraph?: PlayerAudioGraphSnapshot;
}

export interface PlayerAudioDevice {
  name: string;
  description: string;
  isDefault?: boolean;
}

export interface PlayerAudioDeviceListChangedPayload {
  devices: PlayerAudioDevice[];
  deviceChangeKind?: string;
  disconnectedDevices?: PlayerAudioDevice[];
}

interface PlayerAddon {
  initialize(config?: {
    audioBufferSecs?: number;
    audioCacheSecs?: number;
    audioCachePauseWaitSecs?: number;
    audioDemuxerMaxMb?: number;
    audioDemuxerBackMb?: number;
    networkTimeoutSecs?: number;
    playbackStallTimeoutSecs?: number;
    httpProxy?: string;
  }): void;
  destroy(): void;
  registerEventHandler(callback: (err: Error | null, event: PlayerAddonEvent) => void): void;
  loadFile(url: string, seq?: number): Promise<void>;
  loadMkvTrack(url: string, trackId: number, seq?: number): Promise<void>;
  prepareNextSource(url: string, trackId?: number | null, seq?: number): Promise<boolean>;
  clearPreparedNextSource(): void;
  getTrackList(url?: string): Promise<
    Array<{
      id: number;
      type: string;
      selected?: boolean;
      codec?: string;
      title?: string;
      lang?: string;
    }>
  >;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(time: number): Promise<void>;
  setVolume(volume: number): void;
  setSpeed(speed: number): Promise<void>;
  setEqualizer(gains: number[]): Promise<void>;
  setImpulseResponse(payload: string | ImpulseResponsePlaybackOptions): Promise<void>;
  setImpulseResponseMix(mix: number): Promise<void>;
  getAudioGraph(): PlayerAudioGraphSnapshot;
  setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void>;
  setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): Promise<void>;
  setAudioDevice(deviceName: string): Promise<void>;
  getAudioDevices(): Promise<Array<{ name: string; description: string; isDefault?: boolean }>>;
  setNormalizationGain(gainDb: number): Promise<void>;
  fade(from: number, to: number, durationMs: number): Promise<void>;
  cancelFade(): void;
  pauseWithFade(savedVolume: number, durationMs: number): Promise<void>;
  playWithFade(targetVolume: number, durationMs: number): Promise<void>;
  getState(): PlayerState;
  setExclusiveOutput(exclusive: boolean): Promise<void>;
  setLoopFile(loop: boolean): void;
  setStallTimeout(seconds: number): void;
  setNetworkTimeout(seconds: number): void;
  setHttpProxy(proxy: string): void;
  configureSpectrum(options?: unknown): { available: boolean; running: boolean; reason?: string };
  getSpectrumStatus(): { available: boolean; running: boolean; reason?: string };
  getSpectrumSnapshot(): Promise<unknown>;
}

export interface PlayerState {
  playing: boolean;
  paused: boolean;
  duration: number;
  timePos: number;
  volume?: number;
  speed?: number;
  idle?: boolean;
  path?: string;
  audioDevice?: string;
  audioTrackId?: number;
}

export class PlayerController extends EventEmitter {
  private addon: PlayerAddon | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private loadSeq = 0;
  private activeTrackSeq = 0;
  private activeGeneration = 0;
  private pendingLoadSeq: number | null = null;
  private state: PlayerState = {
    playing: false,
    paused: true,
    duration: 0,
    timePos: 0,
    volume: 100,
    speed: 1,
    idle: true,
    path: '',
    audioDevice: 'auto',
    audioTrackId: 0,
  };

  get available(): boolean {
    return this.resolveAddonPath() !== null;
  }

  get currentState(): PlayerState {
    return { ...this.state };
  }

  getState(): PlayerState {
    let nativeState: PlayerState | undefined;
    try {
      nativeState = this.addon?.getState();
    } catch (error) {
      log.debug('[PlayerController] native state unavailable:', error);
    }
    if (!nativeState) return this.currentState;
    this.state = {
      ...this.state,
      ...nativeState,
      audioDevice: this.state.audioDevice,
      audioTrackId: this.state.audioTrackId,
    };
    return this.currentState;
  }

  start(): boolean {
    if (!this.available) return false;
    this.addon = this.loadAddon();
    const networkSettings = refreshNetworkSettingsFromStorage();
    const audioConfig = getPersistedNativeAudioConfig();
    this.addon.initialize({
      audioBufferSecs: audioConfig.audioBufferSecs,
      audioCacheSecs: audioConfig.audioCacheSecs,
      audioCachePauseWaitSecs: audioConfig.audioCachePauseWaitSecs,
      audioDemuxerMaxMb: audioConfig.audioDemuxerMaxMB,
      audioDemuxerBackMb: audioConfig.audioDemuxerBackMB,
      networkTimeoutSecs: networkSettings.playerNetworkTimeoutSecs,
      playbackStallTimeoutSecs: audioConfig.playbackStallTimeoutSecs,
      httpProxy: networkSettings.playerHttpProxyUrl,
    });
    log.info('[PlayerController]', 'native audio cache configured', {
      ...audioConfig,
    });
    this.addon.registerEventHandler((_err, event) => this.handleAddonEvent(event));
    return true;
  }

  destroy(): void {
    this.addon?.destroy();
    this.addon = null;
  }

  async loadFile(url: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.state.path = url;
    this.state.idle = false;
    this.pendingLoadSeq = seq;
    try {
      await this.enqueue(() => this.getAddonOrThrow().loadFile(url, seq));
    } catch (err) {
      if (this.pendingLoadSeq === seq) this.pendingLoadSeq = null;
      throw err;
    }
  }

  async loadMkvTrack(url: string, trackId: number): Promise<void> {
    const seq = ++this.loadSeq;
    this.state.path = url;
    this.state.audioTrackId = trackId;
    this.state.idle = false;
    this.pendingLoadSeq = seq;
    try {
      await this.enqueue(() => this.getAddonOrThrow().loadMkvTrack(url, trackId, seq));
    } catch (err) {
      if (this.pendingLoadSeq === seq) this.pendingLoadSeq = null;
      throw err;
    }
  }

  async prepareNextSource(url: string, trackId?: number | null): Promise<number | null> {
    const seq = ++this.loadSeq;
    const prepared = await this.getAddonOrThrow().prepareNextSource(url, trackId ?? null, seq);
    return prepared ? seq : null;
  }

  clearPreparedNextSource(): void {
    this.getAddonOrThrow().clearPreparedNextSource();
  }

  getTrackList(url?: string) {
    return this.getAddonOrThrow().getTrackList(url);
  }

  play() {
    return this.enqueue(() => this.getAddonOrThrow().play());
  }

  async pause(): Promise<void> {
    this.getAddonOrThrow().pause();
  }

  async stop(): Promise<void> {
    this.getAddonOrThrow().stop();
  }

  async seek(time: number): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().seek(time));
  }

  async setVolume(volume: number): Promise<void> {
    this.state.volume = volume;
    this.getAddonOrThrow().setVolume(volume);
  }

  setSpeed(speed: number) {
    this.state.speed = speed;
    return this.enqueue(() => this.getAddonOrThrow().setSpeed(speed));
  }

  async setEq(gains: number[]): Promise<void> {
    await this.getAddonOrThrow().setEqualizer(gains);
  }

  async setImpulseResponse(payload: string | ImpulseResponsePlaybackOptions): Promise<void> {
    return this.getAddonOrThrow().setImpulseResponse(payload);
  }

  async setImpulseResponseMix(mix: number): Promise<void> {
    await this.getAddonOrThrow().setImpulseResponseMix(mix);
  }

  async getAudioGraph(): Promise<PlayerAudioGraphSnapshot> {
    return this.getAddonOrThrow().getAudioGraph();
  }

  async setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void> {
    await this.getAddonOrThrow().setAudioGraphParameter(patch);
  }

  async setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): Promise<void> {
    await this.getAddonOrThrow().setAudioGraphPlan(plan);
  }

  setAudioDevice(deviceName: string) {
    const nextDevice = deviceName || 'auto';
    return this.enqueue(async () => {
      await this.getAddonOrThrow().setAudioDevice(nextDevice);
      this.state.audioDevice = nextDevice;
    });
  }

  getAudioDevices() {
    return this.getAddonOrThrow().getAudioDevices();
  }

  async applyNormalizationGain(gainDb: number): Promise<void> {
    await this.getAddonOrThrow().setNormalizationGain(gainDb);
  }

  fade(from: number, to: number, durationMs: number) {
    return this.enqueue(() => this.getAddonOrThrow().fade(from, to, durationMs));
  }

  cancelFade(): void {
    this.getAddonOrThrow().cancelFade();
  }

  pauseWithFade(savedVolume: number, durationMs: number) {
    return this.enqueue(async () => {
      await this.getAddonOrThrow().pauseWithFade(savedVolume, durationMs);
      this.getAddonOrThrow().pause();
      this.getAddonOrThrow().setVolume(savedVolume);
    });
  }

  playWithFade(targetVolume: number, durationMs: number) {
    return this.enqueue(async () => {
      const addon = this.getAddonOrThrow();
      addon.cancelFade();
      addon.setVolume(0);
      await addon.play();
      void addon.playWithFade(targetVolume, durationMs).catch((error: unknown) => {
        log.warn('[PlayerController] play fade failed:', error);
      });
    });
  }

  setExclusive(exclusive: boolean) {
    return this.enqueue(() => this.getAddonOrThrow().setExclusiveOutput(exclusive));
  }

  async setLoopFile(loop: boolean): Promise<void> {
    this.getAddonOrThrow().setLoopFile(loop);
  }

  setStallTimeout(seconds: number): void {
    this.getAddonOrThrow().setStallTimeout(Math.max(0, Math.min(60, Number(seconds) || 0)));
  }

  async setNetwork(settings: NetworkSettings): Promise<void> {
    const addon = this.getAddonOrThrow();
    addon.setHttpProxy(settings.playerHttpProxyUrl);
    addon.setNetworkTimeout(settings.playerNetworkTimeoutSecs);
  }

  configureSpectrum(options?: unknown) {
    return this.getAddonOrThrow().configureSpectrum(options);
  }

  getSpectrumStatus() {
    return this.getAddonOrThrow().getSpectrumStatus();
  }

  getSpectrumSnapshot() {
    return this.getAddonOrThrow().getSpectrumSnapshot();
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.commandQueue.catch(() => undefined).then(operation);
    this.commandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private getAddonOrThrow(): PlayerAddon {
    if (!this.addon) throw new Error('player addon not initialized');
    return this.addon;
  }

  private shouldAcceptAddonEvent(event: PlayerAddonEvent): boolean {
    const trackSeq = Number(event.trackSeq);
    if (!Number.isFinite(trackSeq) || trackSeq <= 0) return true;

    if (this.pendingLoadSeq !== null) {
      return trackSeq === this.pendingLoadSeq;
    }

    if (this.activeTrackSeq > 0 && trackSeq < this.activeTrackSeq) return false;
    if (this.activeTrackSeq > 0 && trackSeq === this.activeTrackSeq) {
      const generation = Number(event.generation);
      if (
        Number.isFinite(generation) &&
        generation > 0 &&
        this.activeGeneration > 0 &&
        generation < this.activeGeneration
      ) {
        return false;
      }
    }

    return true;
  }

  private rememberAcceptedAddonEventContext(event: PlayerAddonEvent): void {
    const trackSeq = Number(event.trackSeq);
    const generation = Number(event.generation);
    if (Number.isFinite(trackSeq) && trackSeq > 0 && trackSeq >= this.activeTrackSeq) {
      if (trackSeq > this.activeTrackSeq) this.activeGeneration = 0;
      this.activeTrackSeq = trackSeq;
    }
    if (
      Number.isFinite(generation) &&
      generation > 0 &&
      (!Number.isFinite(trackSeq) || trackSeq <= 0 || trackSeq === this.activeTrackSeq)
    ) {
      this.activeGeneration = Math.max(this.activeGeneration, generation);
    }
  }

  private handleAddonEvent(event: PlayerAddonEvent): void {
    if (!this.shouldAcceptAddonEvent(event)) return;
    this.rememberAcceptedAddonEventContext(event);

    switch (event.event) {
      case 'time-update':
        if (typeof event.time === 'number') {
          this.state.timePos = event.time;
          this.emit('time-update', event.time);
        }
        break;
      case 'seeked':
        if (typeof event.time === 'number') {
          this.state.timePos = event.time;
          this.emit('seeked', event.time);
        }
        break;
      case 'playback-restart':
        if (typeof event.time === 'number') {
          this.state.timePos = event.time;
        }
        log.info('[PlayerController]', 'playback restart', {
          time: event.time,
          reason: event.reason,
        });
        this.emit('playback-restart', {
          time: event.time,
          reason: event.reason,
        });
        break;
      case 'duration-change':
        if (typeof event.duration === 'number') {
          this.state.duration = event.duration;
          this.emit('duration-change', event.duration);
        }
        break;
      case 'file-loaded':
        if (typeof event.seq === 'number' && Number.isFinite(event.seq) && event.seq > 0) {
          this.activeTrackSeq = event.seq;
          if (this.pendingLoadSeq === event.seq) this.pendingLoadSeq = null;
        } else if (
          typeof event.trackSeq === 'number' &&
          Number.isFinite(event.trackSeq) &&
          event.trackSeq > 0
        ) {
          this.activeTrackSeq = event.trackSeq;
          if (this.pendingLoadSeq === event.trackSeq) this.pendingLoadSeq = null;
        }
        this.emit('file-loaded', { path: event.path, seq: event.seq });
        break;
      case 'state-change':
        if (event.state) this.state = { ...this.state, ...event.state };
        this.emit('state-change', this.currentState);
        break;
      case 'playback-end':
        this.state.playing = false;
        this.state.paused = true;
        this.emit('playback-end', event.reason || 'eof');
        break;
      case 'stalled':
        if (typeof event.time === 'number') {
          this.emit('stalled', event.time);
        }
        break;
      case 'core-state-change':
        log.info('[PlayerController]', 'core state changed', {
          state: event.coreState,
          reason: event.reason,
        });
        this.emit('core-state-change', {
          state: event.coreState,
          reason: event.reason,
        });
        break;
      case 'cache-state-change':
        log.info('[PlayerController]', 'cache state changed', {
          paused: event.cachePaused,
          bufferingState: event.cacheBufferingState,
          bufferedSecs: event.cacheBufferedSecs,
          targetSecs: event.cacheTargetSecs,
          packetCache: event.packetCache,
        });
        this.emit('cache-state-change', {
          paused: event.cachePaused,
          bufferingState: event.cacheBufferingState,
          bufferedSecs: event.cacheBufferedSecs,
          targetSecs: event.cacheTargetSecs,
          packetCache: event.packetCache,
        });
        break;
      case 'packet-cache-stats':
        this.emit('packet-cache-stats', event.packetCache);
        break;
      case 'audio-output-stats':
        this.emit('audio-output-stats', event.outputStats);
        break;
      case 'audio-graph-change':
        this.emit('audio-graph-change', event.audioGraph);
        break;
      case 'audio-device-list-changed':
        this.emit('audio-device-list-changed', {
          devices: event.devices || [],
          deviceChangeKind: event.deviceChangeKind,
          disconnectedDevices: event.disconnectedDevices || [],
        });
        break;
      case 'impulse-response-disabled':
        this.emit('impulse-response-disabled', { reason: event.reason || event.message });
        break;
      case 'error':
        this.emit('error', {
          message: event.message || 'player error',
          errorCode: event.errorCode,
        } satisfies PlayerErrorPayload);
        break;
      case 'log':
        log[event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info'](
          '[PlayerController]',
          event.message || '',
        );
        break;
    }
  }

  private resolveAddonPath(): string | null {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'native', 'echo-ffmpeg-player.node')]
      : [
          path.join(__dirname, '../../native/echo-ffmpeg-player/echo-ffmpeg-player.node'),
          path.join(process.cwd(), 'native/echo-ffmpeg-player/echo-ffmpeg-player.node'),
        ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  private loadAddon(): PlayerAddon {
    const addonPath = this.resolveAddonPath();
    if (addonPath) return nativeRequire(addonPath) as PlayerAddon;
    return nativeRequire(path.join(process.cwd(), 'native/echo-ffmpeg-player')) as PlayerAddon;
  }
}
