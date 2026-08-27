import { EventEmitter } from 'events';
import { app } from 'electron';
import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import log from '../logger';
import { refreshNetworkSettingsFromStorage } from '../networkSettings';
import { getPersistedRendererSettings } from '../storage/persistedStores';
import type { NetworkSettings } from '../../shared/network';
import type { AudioEffectPlaybackOptions } from '../../shared/audio';
import { normalizeConvolutionMix } from '../../shared/audio-effect-support';
import type { PlayerErrorCode, PlayerErrorPayload } from '../../shared/player-error';
import type {
  PlayerAudioGraphParameterPatch,
  PlayerAudioGraphPlanPatch,
  PlayerAudioGraphSnapshot,
} from '../../shared/player-audio-graph';

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
const AO_STATE_LOG_INTERVAL_MS = 5000;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

type AudioEffectFileKind = string;

const resolveTrustedAudioEffectFile = async (
  value: unknown,
  kind: AudioEffectFileKind,
): Promise<string | undefined> => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('音效文件路径无效');

  const targetPath = await fs.promises.realpath(value.trim());
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) throw new Error('音效文件路径无效');

  const userData = app.getPath('userData');
  const importedRoot = await fs.promises.realpath(path.join(userData, 'irs')).catch(() => null);
  if (kind === 'impulse-response' && importedRoot) {
    const relative = path.relative(importedRoot, targetPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      const segments = relative.split(path.sep);
      if (segments.length === 1) return targetPath;
    }
  }

  const communityRoot = await fs.promises
    .realpath(path.join(userData, 'audio-effects'))
    .catch(() => null);
  if (communityRoot) {
    const relative = path.relative(communityRoot, targetPath);
    const segments = relative.split(path.sep);
    const expectedName =
      kind === 'vpf' ? 'effect.vpf' : kind === 'impulse-response' ? 'impulse-response.wav' : null;
    if (
      relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      segments.length === 2 &&
      /^community-effect-\d{1,20}$/.test(segments[0]) &&
      (expectedName === null || segments[1] === expectedName)
    ) {
      return targetPath;
    }
  }

  throw new Error('音效文件不在受信任的存储目录中');
};

const normalizeAudioEffectPlaybackOptions = async (
  options: AudioEffectPlaybackOptions | null,
): Promise<AudioEffectPlaybackOptions | null> => {
  if (options === null) return null;
  if (!options || typeof options !== 'object') throw new Error('音效参数无效');
  const providerPath = await resolveNativeProviderPath(options.providerPath);
  const providerResources = await Promise.all(
    (options.providerResources ?? []).map(async (resource) => {
      if (!resource || typeof resource.kind !== 'string') throw new Error('Provider resource 无效');
      const kind = resource.kind as AudioEffectFileKind;
      if (!kind.trim() || kind.length > 64) throw new Error('Provider resource 类型无效');
      const resolvedPath = await resolveTrustedAudioEffectFile(resource.path, kind);
      if (!resolvedPath) throw new Error('Provider resource 路径无效');
      return { kind, path: resolvedPath };
    }),
  );
  if (providerResources.some((resource) => resource.kind !== 'impulse-response') && !providerPath) {
    throw new Error('该音效资源需要外部 Provider');
  }
  const providerPresetJson =
    options.providerPresetJson == null ? undefined : String(options.providerPresetJson);
  const impulseResponsePath = await resolveTrustedAudioEffectFile(
    options.impulseResponsePath,
    'impulse-response',
  );
  if (providerPath)
    return {
      providerPath,
      providerPresetJson,
      providerResources,
      providerMode: options.providerMode === 'headphone' ? 'headphone' : 'speaker',
      impulseResponsePath,
    };
  if (!impulseResponsePath) return null;
  return {
    impulseResponsePath,
    impulseResponseMix: normalizeConvolutionMix(options.impulseResponseMix),
  };
};

const resolveNativeProviderPath = async (value: unknown): Promise<string | undefined> => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provider 路径无效');
  const targetPath = await fs.promises.realpath(value.trim());
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) throw new Error('Provider 路径无效');
  const providerRoot = await fs.promises
    .realpath(path.join(app.getPath('userData'), 'dsp-providers'))
    .catch(() => null);
  if (!providerRoot) throw new Error('Provider 不在受信任的目录中');
  const relative = path.relative(providerRoot, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Provider 不在受信任的目录中');
  }
  return targetPath;
};

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
  const saved = getPersistedRendererSettings();
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
  aoPaused?: boolean;
  aoReason?: string;
  aoBufferingState?: number;
  aoBufferedSecs?: number;
  aoTargetSecs?: number;
  packetCache?: {
    forwardBytes: number;
    backBytes: number;
    totalBytes: number;
    forwardSecs?: number;
    seekableRanges: Array<{ startSecs: number; endSecs: number }>;
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
    bufferMode: string;
    bufferFrames: number;
    bufferSecs: number;
    requestedBufferSecs?: number;
    deviceBufferSecs?: number;
    softwareBufferSecs?: number;
    aoBufferTargetSecs?: number;
    aoBufferCapacitySecs?: number;
    aoRequestFrames?: number;
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
  beginNextSourcePreparation(): number;
  cancelNextSourcePreparation(requestId: number): boolean;
  prepareNextSource(
    url: string,
    trackId: number | null,
    seq: number,
    requestId: number,
    normalizationGainDb?: number,
  ): Promise<boolean>;
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
  setAudioEffect(options: AudioEffectPlaybackOptions | null): Promise<void>;
  getAudioGraph(): Promise<PlayerAudioGraphSnapshot>;
  inspectDspProvider(path: string): Promise<unknown>;
  deleteDspProvider(path: string): Promise<void>;
  setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void>;
  setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): Promise<void>;
  setAudioOutput(deviceName: string, exclusive: boolean): Promise<void>;
  getAudioDevices(): Promise<Array<{ name: string; description: string; isDefault?: boolean }>>;
  setNormalizationGain(gainDb: number): Promise<void>;
  fade(from: number, to: number, durationMs: number): Promise<void>;
  cancelFade(): void;
  pauseWithFade(savedVolume: number, durationMs: number): Promise<void>;
  playWithFade(targetVolume: number, durationMs: number): Promise<void>;
  getState(): PlayerState;
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
  exclusiveOutput?: boolean;
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
  private lastAoStateLogAt = 0;
  private lastAoStateLogKey = '';
  private lastOutputBufferLogKey = '';
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
    exclusiveOutput: false,
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
    this.lastAoStateLogAt = 0;
    this.lastAoStateLogKey = '';
    this.lastOutputBufferLogKey = '';
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

  beginNextSourcePreparation(): number | null {
    const requestId = this.getAddonOrThrow().beginNextSourcePreparation();
    return requestId > 0 ? requestId : null;
  }

  cancelNextSourcePreparation(requestId: number): boolean {
    return this.getAddonOrThrow().cancelNextSourcePreparation(requestId);
  }

  async prepareNextSource(
    url: string,
    requestId: number,
    trackId?: number | null,
    normalizationGainDb?: number,
  ): Promise<number | null> {
    const seq = ++this.loadSeq;
    const prepared = await this.getAddonOrThrow().prepareNextSource(
      url,
      trackId ?? null,
      seq,
      requestId,
      normalizationGainDb ?? 0,
    );
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
    const addon = this.getAddonOrThrow();
    // Native owns the user-volume target and cancels any superseded fade.
    addon.setVolume(volume);
  }

  setSpeed(speed: number) {
    this.state.speed = speed;
    return this.enqueue(() => this.getAddonOrThrow().setSpeed(speed));
  }

  async setEq(gains: number[]): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setEqualizer(gains));
  }

  async setAudioEffect(options: AudioEffectPlaybackOptions | null): Promise<void> {
    const trustedOptions = await normalizeAudioEffectPlaybackOptions(options);
    return this.enqueue(() => this.getAddonOrThrow().setAudioEffect(trustedOptions));
  }

  async getAudioGraph(): Promise<PlayerAudioGraphSnapshot> {
    return await this.getAddonOrThrow().getAudioGraph();
  }

  async inspectDspProvider(providerPath: string): Promise<unknown> {
    const trustedPath = await resolveNativeProviderPath(providerPath);
    if (!trustedPath) throw new Error('Provider 路径无效');
    return await this.getAddonOrThrow().inspectDspProvider(trustedPath);
  }

  async deleteDspProvider(providerPath: string): Promise<void> {
    const trustedPath = await resolveNativeProviderPath(providerPath);
    if (!trustedPath) throw new Error('Provider 路径无效');
    const graph = await this.getAudioGraph();
    if (graph.providerPath === trustedPath) await this.setAudioEffect(null);
    await fs.promises.unlink(trustedPath);
  }

  async setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setAudioGraphParameter(patch));
  }

  async setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): Promise<void> {
    await this.enqueue(() => this.getAddonOrThrow().setAudioGraphPlan(plan));
  }

  setAudioOutput(deviceName: string, exclusive: boolean) {
    const nextDevice = deviceName || 'auto';
    return this.enqueue(async () => {
      const nextExclusive = Boolean(exclusive);
      await this.getAddonOrThrow().setAudioOutput(nextDevice, nextExclusive);
      this.state.audioDevice = nextDevice;
      this.state.exclusiveOutput = nextExclusive;
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
      await addon.play();
      void addon.playWithFade(targetVolume, durationMs).catch((error: unknown) => {
        log.warn('[PlayerController] play fade failed:', error);
      });
    });
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
        this.emit('file-loaded', {
          path: event.path,
          seq: event.seq,
          trackSeq: event.trackSeq,
          generation: event.generation,
        });
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
      case 'ao-state-change':
        this.logAoStateChange(event);
        this.emit('ao-state-change', {
          paused: event.aoPaused,
          reason: event.aoReason,
          bufferingState: event.aoBufferingState,
          bufferedSecs: event.aoBufferedSecs,
          targetSecs: event.aoTargetSecs,
          trackSeq: event.trackSeq,
          generation: event.generation,
        });
        break;
      case 'packet-cache-stats':
        this.emit('packet-cache-stats', event.packetCache);
        break;
      case 'audio-output-stats':
        this.logAudioOutputStats(event);
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
      case 'error':
        this.emit('error', {
          message: event.message || 'player error',
          errorCode: event.errorCode,
          reason: event.reason,
          trackSeq: event.trackSeq,
          generation: event.generation,
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
    if (event.reason?.startsWith('ao-')) {
      log.debug('[PlayerController]', 'core state changed', payload);
      return;
    }
    log.info('[PlayerController]', 'core state changed', payload);
  }

  private logAoStateChange(event: PlayerAddonEvent): void {
    const key = [
      event.trackSeq ?? '',
      event.generation ?? '',
      event.aoPaused ? 1 : 0,
      event.aoReason ?? '',
    ].join('|');
    const now = Date.now();

    if (key === this.lastAoStateLogKey && now - this.lastAoStateLogAt < AO_STATE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastAoStateLogKey = key;
    this.lastAoStateLogAt = now;
    log.debug('[PlayerController]', 'AO state changed', {
      paused: event.aoPaused,
      reason: event.aoReason,
      bufferingState: event.aoBufferingState,
      bufferedSecs: event.aoBufferedSecs,
      targetSecs: event.aoTargetSecs,
    });
  }

  private logAudioOutputStats(event: PlayerAddonEvent): void {
    const stats = event.outputStats;
    if (!stats) return;
    const key = [
      stats.backend,
      stats.bufferMode,
      stats.bufferFrames,
      stats.aoBufferTargetSecs,
      stats.aoRequestFrames,
    ].join('|');
    if (key === this.lastOutputBufferLogKey) return;
    this.lastOutputBufferLogKey = key;
    log.debug('[PlayerController]', 'audio output buffer changed', stats);
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
