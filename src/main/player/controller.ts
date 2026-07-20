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

const PINIA_SETTING_KEY = 'pinia:setting';
const DEFAULT_AUDIO_CACHE_SECS = 30;
const DEFAULT_AUDIO_OUTPUT_BUFFER_SECS = 2;
const DEFAULT_DEMUXER_MAX_MB = 48;
const DEFAULT_DEMUXER_BACK_MB = 12;
const DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS = 8;
const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

const readClampedNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const getPersistedNativeAudioConfig = () => {
  const saved = getKvStorage().get<Record<string, unknown>>(PINIA_SETTING_KEY);
  const audioCacheSecs = readClampedNumber(
    saved?.audioCacheSecs,
    DEFAULT_AUDIO_CACHE_SECS,
    10,
    120,
  );
  const audioBufferSecs = readClampedNumber(
    saved?.audioBufferSecs,
    DEFAULT_AUDIO_OUTPUT_BUFFER_SECS,
    1,
    5,
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
    audioDemuxerMaxMB,
    audioDemuxerBackMB,
    playbackStallTimeoutSecs,
  };
};

interface PlayerAddonEvent {
  event: string;
  time?: number;
  duration?: number;
  state?: PlayerState;
  reason?: string;
  message?: string;
  level?: string;
  devices?: Array<{ name: string; description: string }>;
  path?: string;
  seq?: number;
}

interface PlayerAddon {
  initialize(config?: {
    audioBufferSecs?: number;
    audioCacheSecs?: number;
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
  getAudioFilter(): string;
  setAudioDevice(deviceName: string): Promise<void>;
  getAudioDevices(): Promise<Array<{ name: string; description: string }>>;
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

  start(): boolean {
    if (!this.available) return false;
    this.addon = this.loadAddon();
    const networkSettings = refreshNetworkSettingsFromStorage();
    const audioConfig = getPersistedNativeAudioConfig();
    this.addon.initialize({
      audioBufferSecs: audioConfig.audioBufferSecs,
      audioCacheSecs: audioConfig.audioCacheSecs,
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
    await this.enqueue(() => this.getAddonOrThrow().loadFile(url, seq));
  }

  async loadMkvTrack(url: string, trackId: number): Promise<void> {
    const seq = ++this.loadSeq;
    this.state.path = url;
    this.state.audioTrackId = trackId;
    this.state.idle = false;
    await this.enqueue(() => this.getAddonOrThrow().loadMkvTrack(url, trackId, seq));
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

  async getAudioFilter(): Promise<string> {
    return this.getAddonOrThrow().getAudioFilter();
  }

  setAudioDevice(deviceName: string) {
    this.state.audioDevice = deviceName || 'auto';
    return this.enqueue(() =>
      this.getAddonOrThrow().setAudioDevice(this.state.audioDevice || 'auto'),
    );
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
    return this.enqueue(() => this.getAddonOrThrow().playWithFade(targetVolume, durationMs));
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

  private handleAddonEvent(event: PlayerAddonEvent): void {
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
      case 'duration-change':
        if (typeof event.duration === 'number') {
          this.state.duration = event.duration;
          this.emit('duration-change', event.duration);
        }
        break;
      case 'file-loaded':
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
      case 'audio-device-list-changed':
        this.emit('audio-device-list-changed', event.devices || []);
        break;
      case 'impulse-response-disabled':
        this.emit('impulse-response-disabled', { reason: event.reason || event.message });
        break;
      case 'error':
        this.emit('error', new Error(event.message || 'player error'));
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
