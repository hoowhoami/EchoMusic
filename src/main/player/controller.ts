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
const DEFAULT_AUDIO_OUTPUT_BUFFER_SECS = 0.2;
const DEFAULT_AUDIO_SAMPLERATE = 'auto';
const DEFAULT_AUDIO_CHANNELS = 'auto-safe';
const DEFAULT_AUDIO_FORMAT = 'auto';
const DEFAULT_GAPLESS_AUDIO = 'weak';
const MAX_AUDIO_OUTPUT_BUFFER_SECS = 10;
const DEFAULT_DEMUXER_READAHEAD_SECS = 1;
const DEFAULT_CACHE = 'auto' as const;
const DEFAULT_CACHE_SECS = 3_600_000;
const DEFAULT_CACHE_PAUSE = true;
const DEFAULT_CACHE_PAUSE_WAIT_SECS = 1;
const DEFAULT_DEMUXER_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_DEMUXER_MAX_BACK_BYTES = 50 * 1024 * 1024;
const MAX_DEMUXER_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS = 8;
const CACHE_STATE_LOG_INTERVAL_MS = 5000;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

const readClampedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const readCacheMode = (value: unknown): 'auto' | 'yes' | 'no' => {
  const normalized = String(value ?? DEFAULT_CACHE)
    .trim()
    .toLowerCase();
  return normalized === 'yes' || normalized === 'no' ? normalized : DEFAULT_CACHE;
};

const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readString = (value: unknown, fallback: string): string => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const getPersistedNativeAudioConfig = () => {
  const saved = getKvStorage().get<Record<string, unknown>>(PINIA_SETTING_KEY);
  const demuxerReadaheadSecs = readClampedNumber(
    saved?.demuxerReadaheadSecs,
    DEFAULT_DEMUXER_READAHEAD_SECS,
    0,
    DEFAULT_CACHE_SECS,
  );
  const cache = readCacheMode(saved?.cache);
  const cacheSecs = readClampedNumber(saved?.cacheSecs, DEFAULT_CACHE_SECS, 0, DEFAULT_CACHE_SECS);
  const cachePause = readBoolean(saved?.cachePause, DEFAULT_CACHE_PAUSE);
  const cachePauseWaitSecs = readClampedNumber(
    saved?.cachePauseWaitSecs,
    DEFAULT_CACHE_PAUSE_WAIT_SECS,
    0,
    DEFAULT_CACHE_SECS,
  );
  const audioBufferSecs = readClampedNumber(
    saved?.audioBufferSecs,
    DEFAULT_AUDIO_OUTPUT_BUFFER_SECS,
    0,
    MAX_AUDIO_OUTPUT_BUFFER_SECS,
  );
  const audioSamplerate = readString(saved?.audioSamplerate, DEFAULT_AUDIO_SAMPLERATE);
  const audioChannels = readString(saved?.audioChannels, DEFAULT_AUDIO_CHANNELS);
  const audioFormat = readString(saved?.audioFormat, DEFAULT_AUDIO_FORMAT);
  const gaplessAudio = readString(saved?.gaplessAudio, DEFAULT_GAPLESS_AUDIO);
  const demuxerMaxBytes = readClampedNumber(
    saved?.demuxerMaxBytes,
    DEFAULT_DEMUXER_MAX_BYTES,
    0,
    MAX_DEMUXER_BYTES,
  );
  const demuxerMaxBackBytes = readClampedNumber(
    saved?.demuxerMaxBackBytes,
    DEFAULT_DEMUXER_MAX_BACK_BYTES,
    0,
    demuxerMaxBytes,
  );
  const playbackStallTimeoutSecs = readClampedNumber(
    saved?.playbackStallTimeout,
    DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS,
    0,
    60,
  );
  return {
    audioBufferSecs,
    audioSamplerate,
    audioChannels,
    audioFormat,
    gaplessAudio,
    demuxerReadaheadSecs,
    cache,
    cacheSecs,
    cachePause,
    cachePauseWaitSecs,
    demuxerMaxBytes,
    demuxerMaxBackBytes,
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
    requestedBufferSecs?: number;
    deviceBufferSecs?: number;
    softwareBufferSecs?: number;
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
    audioSamplerate?: string;
    audioChannels?: string;
    audioFormat?: string;
    gaplessAudio?: string;
    demuxerReadaheadSecs?: number;
    cache?: string;
    cacheSecs?: number;
    cachePause?: boolean;
    cachePauseWaitSecs?: number;
    demuxerMaxBytes?: number;
    demuxerMaxBackBytes?: number;
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
  setPauseOnDeviceDisconnect(enabled: boolean): void;
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

export interface PlayerPlaybackContext {
  trackSeq?: number;
  generation?: number;
}

export type PlayerStateChangePayload = PlayerState & PlayerPlaybackContext;

export class PlayerController extends EventEmitter {
  private addon: PlayerAddon | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private loadSeq = 0;
  private activeTrackSeq = 0;
  private activeGeneration = 0;
  private seekSeq = 0;
  private pendingLoadSeq: number | null = null;
  private lastCacheStateLogAt = 0;
  private lastCacheStateLogKey = '';
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
    this.applyNativePlaybackState(nativeState);
    return this.currentState;
  }

  start(): boolean {
    if (!this.available) return false;
    this.destroy();
    this.addon = this.loadAddon();
    const networkSettings = refreshNetworkSettingsFromStorage();
    const audioConfig = getPersistedNativeAudioConfig();
    this.addon.registerEventHandler((_err, event) => this.handleAddonEvent(event));
    this.addon.initialize({
      audioBufferSecs: audioConfig.audioBufferSecs,
      audioSamplerate: audioConfig.audioSamplerate,
      audioChannels: audioConfig.audioChannels,
      audioFormat: audioConfig.audioFormat,
      gaplessAudio: audioConfig.gaplessAudio,
      demuxerReadaheadSecs: audioConfig.demuxerReadaheadSecs,
      cache: audioConfig.cache,
      cacheSecs: audioConfig.cacheSecs,
      cachePause: audioConfig.cachePause,
      cachePauseWaitSecs: audioConfig.cachePauseWaitSecs,
      demuxerMaxBytes: audioConfig.demuxerMaxBytes,
      demuxerMaxBackBytes: audioConfig.demuxerMaxBackBytes,
      networkTimeoutSecs: networkSettings.playerNetworkTimeoutSecs,
      playbackStallTimeoutSecs: audioConfig.playbackStallTimeoutSecs,
      httpProxy: networkSettings.playerHttpProxyUrl,
    });
    log.info('[PlayerController]', 'native audio cache configured', {
      ...audioConfig,
    });
    return true;
  }

  destroy(): void {
    this.addon?.destroy();
    this.addon = null;
    this.lastCacheStateLogAt = 0;
    this.lastCacheStateLogKey = '';
  }

  async loadFile(url: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.state.path = url;
    this.state.idle = false;
    this.pendingLoadSeq = seq;
    try {
      await this.enqueue(() => {
        if (this.pendingLoadSeq !== seq) return undefined;
        return this.getAddonOrThrow().loadFile(url, seq);
      });
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
      await this.enqueue(() => {
        if (this.pendingLoadSeq !== seq) return undefined;
        return this.getAddonOrThrow().loadMkvTrack(url, trackId, seq);
      });
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
    await this.enqueue(() => this.getAddonOrThrow().pause());
  }

  async stop(): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().stop());
  }

  async seek(time: number): Promise<void> {
    const seq = ++this.seekSeq;
    try {
      await this.enqueue(() => {
        if (seq !== this.seekSeq) return undefined;
        return this.getAddonOrThrow().seek(time);
      });
    } catch (err) {
      if (seq === this.seekSeq) throw err;
    }
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
    await this.enqueue(() => this.getAddonOrThrow().setEqualizer(gains));
  }

  async setImpulseResponse(payload: string | ImpulseResponsePlaybackOptions): Promise<void> {
    return this.enqueue(() => this.getAddonOrThrow().setImpulseResponse(payload));
  }

  async setImpulseResponseMix(mix: number): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setImpulseResponseMix(mix));
  }

  async getAudioGraph(): Promise<PlayerAudioGraphSnapshot> {
    return this.getAddonOrThrow().getAudioGraph();
  }

  async setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setAudioGraphParameter(patch));
  }

  async setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setAudioGraphPlan(plan));
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
    await this.enqueue(() => this.getAddonOrThrow().setNormalizationGain(gainDb));
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

  setPauseOnDeviceDisconnect(enabled: boolean): void {
    this.getAddonOrThrow().setPauseOnDeviceDisconnect(Boolean(enabled));
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

  private applyNativePlaybackState(nativeState: Partial<PlayerState>): void {
    const next = { ...this.state };
    if (typeof nativeState.timePos === 'number') next.timePos = nativeState.timePos;
    if (typeof nativeState.playing === 'boolean') next.playing = nativeState.playing;
    if (typeof nativeState.paused === 'boolean') next.paused = nativeState.paused;
    if (typeof nativeState.duration === 'number') next.duration = nativeState.duration;
    this.state = next;
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
          this.emit('time-update', {
            time: event.time,
            trackSeq: event.trackSeq,
            generation: event.generation,
          });
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
        if (event.state) this.applyNativePlaybackState(event.state);
        this.emit('state-change', {
          ...this.currentState,
          trackSeq: event.trackSeq,
          generation: event.generation,
        } satisfies PlayerStateChangePayload);
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
        this.logCoreStateChange(event);
        this.emit('core-state-change', {
          state: event.coreState,
          reason: event.reason,
          trackSeq: event.trackSeq,
          generation: event.generation,
        });
        break;
      case 'cache-state-change':
        this.logCacheStateChange(event);
        this.emit('cache-state-change', {
          paused: event.cachePaused,
          bufferingState: event.cacheBufferingState,
          bufferedSecs: event.cacheBufferedSecs,
          targetSecs: event.cacheTargetSecs,
          packetCache: event.packetCache,
          trackSeq: event.trackSeq,
          generation: event.generation,
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
          reason: event.reason,
        } satisfies PlayerErrorPayload);
        break;
      case 'log':
        log[
          event.level === 'error'
            ? 'error'
            : event.level === 'warn'
              ? 'warn'
              : event.level === 'debug'
                ? 'debug'
                : 'info'
        ]('[PlayerController]', event.message || '');
        break;
    }
  }

  private logCoreStateChange(event: PlayerAddonEvent): void {
    const payload = {
      state: event.coreState,
      reason: event.reason,
    };
    if (event.reason === 'cache-pause' || event.reason === 'cache-resume') {
      log.debug('[PlayerController]', 'core state changed', payload);
      return;
    }
    log.info('[PlayerController]', 'core state changed', payload);
  }

  private logCacheStateChange(event: PlayerAddonEvent): void {
    const packetCache = event.packetCache;
    const key = [
      event.trackSeq ?? '',
      event.generation ?? '',
      event.cachePaused ? 1 : 0,
      packetCache?.pendingSeek ? 1 : 0,
      packetCache?.eof ? 1 : 0,
      packetCache?.hasError ? 1 : 0,
    ].join('|');
    const now = Date.now();

    if (
      key === this.lastCacheStateLogKey &&
      now - this.lastCacheStateLogAt < CACHE_STATE_LOG_INTERVAL_MS
    ) {
      return;
    }

    this.lastCacheStateLogKey = key;
    this.lastCacheStateLogAt = now;
    const level = packetCache?.hasError ? 'warn' : 'debug';
    log[level]('[PlayerController]', 'cache state changed', {
      paused: event.cachePaused,
      bufferingState: event.cacheBufferingState,
      bufferedSecs: event.cacheBufferedSecs,
      targetSecs: event.cacheTargetSecs,
      packetCache,
    });
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
