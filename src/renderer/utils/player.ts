import logger from './logger';
import type { AudioEffectPlaybackOptions } from '../../shared/audio';
import type { PlayerErrorPayload } from '../../shared/playerError';
import type {
  PlayerAudioGraphParameterPatch,
  PlayerAudioGraphPlanPatch,
  PlayerAudioGraphSnapshot,
} from '../../shared/playerAudioGraph';
import {
  calculateNormalizationGainDb,
  DEFAULT_REFERENCE_LUFS,
  type TrackLoudness,
} from '../../shared/loudness';
export type { TrackLoudness } from '../../shared/loudness';
import { DEFAULT_PLAYER_VOLUME, matchesPendingSeekTarget } from '../../shared/playback';
import type { PlaybackSource } from '@/stores/player/types';
import type { TrackTransitionPlaybackInfo } from '../../shared/trackTransition';

export interface PlayerEngineEvents {
  timeUpdate?: (currentTime: number, payload?: PlayerPlaybackContext) => void;
  seeked?: (currentTime: number) => void;
  seekStateChange?: (payload: PlayerSeekStatePayload) => void;
  playbackRestart?: (payload?: { time?: number; reason?: string }) => void;
  durationChange?: (duration: number) => void;
  /** 新文件加载完成（player file-loaded），用于切歌后放行进度回报 */
  fileLoaded?: (
    payload?: {
      path?: string;
      seq?: number;
      startTime?: number;
      transition?: TrackTransitionPlaybackInfo;
    } & PlayerPlaybackContext,
  ) => void;
  ended?: (payload?: PlayerPlaybackContext) => void;
  play?: (payload?: PlayerPlaybackContext & { time?: number }) => void;
  pause?: (payload?: PlayerPlaybackContext & { time?: number }) => void;
  error?: (event: Event) => void;
  /** Native 播放引擎检测到播放卡死，携带卡死时的播放位置（秒） */
  stalled?: (position: number) => void;
  coreStateChange?: (payload: PlayerCoreStatePayload) => void;
  aoStateChange?: (payload: PlayerAoStatePayload) => void;
  packetCacheStats?: (payload?: PlayerPacketCacheStats) => void;
  audioOutputStats?: (payload?: PlayerAudioOutputStats) => void;
  audioGraphChange?: (payload: PlayerAudioGraphSnapshot | null) => void;
}

export type { PlayerAudioGraphSnapshot };

export interface PlayerPlaybackContext {
  trackSeq?: number;
  generation?: number;
}

export interface PlayerSeekStatePayload extends PlayerPlaybackContext {
  active: boolean;
  time?: number;
}

export interface PlayerPacketCacheStats {
  forwardBytes: number;
  backBytes: number;
  totalBytes: number;
  forwardSecs?: number;
  seekableRanges: Array<{ startSecs: number; endSecs: number }>;
  eof: boolean;
  pendingSeek: boolean;
  hasError: boolean;
}

export interface PlayerAudioOutputStats {
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
}

export interface PlayerCoreStatePayload extends PlayerPlaybackContext {
  state?: string;
  reason?: string;
}

export interface PlayerAoStatePayload extends PlayerPlaybackContext {
  paused?: boolean;
  reason?: string;
  bufferingState?: number;
  bufferedSecs?: number;
  targetSecs?: number;
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

export interface MediaSessionSkipIntervals {
  forwardOffset: number;
  backwardOffset: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const NORMALIZATION_GAIN_EPSILON = 0.0005;

const isPlayerErrorPayload = (error: unknown): error is PlayerErrorPayload => {
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<PlayerErrorPayload>;
  return typeof payload.message === 'string';
};

export const normalizePlayerErrorPayload = (error: unknown): PlayerErrorPayload => {
  if (isPlayerErrorPayload(error)) return error;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error || 'player error');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('no audio output device available') ||
    normalized.includes('failed to get default wasapi output device') ||
    normalized.includes('requested device is no longer available') ||
    normalized.includes('device is no longer available')
  ) {
    return {
      message,
      errorCode: 'output-device-unavailable',
      reason: 'device-not-available',
    };
  }

  if (
    normalized.includes('audio output device') ||
    normalized.includes('output device') ||
    normalized.includes('output stream') ||
    normalized.includes('output config')
  ) {
    return {
      message,
      errorCode: normalized.includes('stream') ? 'output-stream' : 'output-device-unavailable',
    };
  }

  return { message };
};

// player preload API（类型来自 electron.d.ts）
const player = window.electron?.player;

// 原生媒体控制 preload API
const mediaControls = window.electron?.mediaControls;

const normalizePlaybackSource = (source: string | PlaybackSource): PlaybackSource => {
  if (typeof source !== 'string') {
    return {
      url: String(source.url || '').trim(),
      audioTrackId:
        source.audioTrackId !== undefined && source.audioTrackId !== null
          ? Number(source.audioTrackId)
          : null,
    };
  }

  return { url: source };
};

const getPlaybackSourceKey = (source: PlaybackSource) =>
  `${source.audioTrackId ? `mkv:${source.audioTrackId}:` : ''}${source.url}`;

export class PlayerEngine {
  private events: PlayerEngineEvents = {};
  private sourceUrl = '';
  private volumeValue = DEFAULT_PLAYER_VOLUME;
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
  private pendingSeek: { target: number } | null = null;
  private sourceRevision = 0;
  private sourceSwitchRevision = 0;
  private sourceRequest: Promise<number> | null = null;
  private sourcePending = false;
  // 在飞行中的换源加载 promise（loadSource 结算后置空），用于恢复播放等命令等待其落地
  private sourceLoadPromise: Promise<void> | null = null;

  constructor() {
    if (player) {
      this.bindPlayerEvents();
    } else {
      logger.error('PlayerEngine', 'player API not available');
    }
  }

  // ── player 事件监听 ──

  private bindPlayerEvents(): void {
    const offTime = player.onTimeUpdate((payload) => {
      if (this.sourcePending) return;
      const time = typeof payload === 'number' ? payload : Number(payload?.time);
      if (!Number.isFinite(time)) return;
      if (this.pendingSeek) return;
      const previousTime = this.lastTimeValue;
      if (time === previousTime) return;
      // 节流：限制时间更新频率
      const now = Date.now();
      const isPositionJump = previousTime >= 0 && Math.abs(time - previousTime) > 0.75;
      this.lastTimeValue = time;
      if (!isPositionJump && now - this.lastTimeUpdateMs < this.TIME_UPDATE_THROTTLE_MS) return;
      this.lastTimeUpdateMs = now;
      this.events.timeUpdate?.(
        time,
        typeof payload === 'number'
          ? undefined
          : { trackSeq: payload.trackSeq, generation: payload.generation },
      );
    });
    this.cleanupFns.push(offTime);

    const offSeeked = player.onSeeked?.((time: number) => {
      if (this.sourcePending) return;
      if (!matchesPendingSeekTarget(this.pendingSeek?.target, time)) return;
      this.clearSeekPending();
      this.lastTimeValue = time;
      this.lastTimeUpdateMs = Date.now();
      this.events.seeked?.(time);
      this.events.timeUpdate?.(time);
    });
    if (offSeeked) this.cleanupFns.push(offSeeked);

    const offSeekState = player.onSeekStateChange?.((payload) => {
      this.events.seekStateChange?.(payload);
    });
    if (offSeekState) this.cleanupFns.push(offSeekState);

    const offPlaybackRestart = player.onPlaybackRestart?.((payload) => {
      if (this.sourcePending) return;
      if (!matchesPendingSeekTarget(this.pendingSeek?.target, payload?.time)) return;
      this.clearSeekPending();
      if (typeof payload?.time === 'number') {
        this.lastTimeValue = payload.time;
        this.lastTimeUpdateMs = Date.now();
      }
      this.events.playbackRestart?.(payload);
    });
    if (offPlaybackRestart) this.cleanupFns.push(offPlaybackRestart);

    const offDuration = player.onDurationChange((duration: number) => {
      if (this.sourcePending) return;
      if (duration === this.durationValue) return;
      this.durationValue = duration;
      this.events.durationChange?.(duration);
    });
    this.cleanupFns.push(offDuration);

    const offFileLoaded = player.onFileLoaded?.(
      (
        payload?: {
          path?: string;
          seq?: number;
          startTime?: number;
          transition?: TrackTransitionPlaybackInfo;
        } & PlayerPlaybackContext,
      ) => {
        // Explicit loads are bound by their command acknowledgement, never a late event
        // from a source that was superseded while the URL resolver was running.
        if (this.sourcePending) return;
        this.clearSeekPending();
        this.lastTimeValue = -1;
        this.lastTimeUpdateMs = 0;
        if (typeof payload?.startTime === 'number' && Number.isFinite(payload.startTime)) {
          this.lastTimeValue = payload.startTime;
          this.lastTimeUpdateMs = Date.now();
        }
        this.events.fileLoaded?.(payload);
      },
    );
    if (offFileLoaded) this.cleanupFns.push(offFileLoaded);

    const offState = player.onStateChange((state) => {
      if (this.sourcePending) return;
      const context = {
        trackSeq: state.trackSeq,
        generation: state.generation,
        time: state.timePos,
      };
      if (state.playing) {
        this.events.play?.(context);
      } else if (state.paused) {
        this.events.pause?.(context);
      }
    });
    this.cleanupFns.push(offState);

    const offEnd = player.onPlaybackEnd((reason: string, context?: PlayerPlaybackContext) => {
      if (this.sourcePending) return;
      if (reason === 'eof') {
        this.events.ended?.(context);
      } else if (reason === 'error') {
        this.events.error?.(new Event('error'));
      }
    });
    this.cleanupFns.push(offEnd);

    const offError = player.onError((payload: PlayerErrorPayload) => {
      const normalized = normalizePlayerErrorPayload(payload);
      logger.error('PlayerEngine', 'player error', normalized);
      this.events.error?.(new CustomEvent('error', { detail: normalized }));
    });
    this.cleanupFns.push(offError);

    const offStall = player.onStall?.((position: number) => {
      this.events.stalled?.(position);
    });
    if (offStall) this.cleanupFns.push(offStall);

    const offCoreState = player.onCoreStateChange?.((payload) => {
      this.events.coreStateChange?.(payload);
    });
    if (offCoreState) this.cleanupFns.push(offCoreState);

    const offAoState = player.onAoStateChange?.((payload) => {
      this.events.aoStateChange?.(payload);
    });
    if (offAoState) this.cleanupFns.push(offAoState);

    const offPacketCache = player.onPacketCacheStats?.((payload) => {
      this.events.packetCacheStats?.(payload);
    });
    if (offPacketCache) this.cleanupFns.push(offPacketCache);

    const offOutputStats = player.onAudioOutputStats?.((payload) => {
      this.events.audioOutputStats?.(payload);
    });
    if (offOutputStats) this.cleanupFns.push(offOutputStats);

    const offAudioGraph = player.onAudioGraphChange?.((payload) => {
      this.events.audioGraphChange?.(payload ?? null);
    });
    if (offAudioGraph) this.cleanupFns.push(offAudioGraph);
  }

  private clearSeekPending(): void {
    this.pendingSeek = null;
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

  async setSource(source: string | PlaybackSource, options?: { force?: boolean }): Promise<void> {
    const playbackSource = normalizePlaybackSource(source);
    if (!playbackSource.url) return;
    const sourceKey = getPlaybackSourceKey(playbackSource);
    if (this.sourceUrl === sourceKey && !options?.force) return;
    this.beginSourceChange();
    this.sourceUrl = sourceKey;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);

    await this.loadSource(playbackSource);
  }

  /** Invalidate transport work immediately, including the URL-resolution window. */
  beginSourceChange(): void {
    ++this.sourceRevision;
    this.sourcePending = true;
    this.sourceUrl = '';
    this.clearSeekPending();
    this.lastTimeValue = -1;
    this.lastTimeUpdateMs = 0;
    this.sourceRequest =
      player?.beginSourceChange() ?? Promise.reject(new Error('player API not available'));
    // Resolution can fail before setSource consumes this promise.
    void this.sourceRequest.catch((error) =>
      logger.warn('PlayerEngine', 'Begin source change failed', error),
    );
  }

  private async loadSource(source: PlaybackSource): Promise<void> {
    const revision = this.sourceRevision;
    const requestId = await this.sourceRequest;
    if (revision !== this.sourceRevision) return;
    const loadTask = (async () => {
      const result =
        source.audioTrackId && source.audioTrackId > 0
          ? await player?.loadMkvTrack(source.url, source.audioTrackId, requestId ?? undefined)
          : await player?.load(source.url, requestId ?? undefined);
      if (revision !== this.sourceRevision) return;
      if (!result) throw new Error('Audio source load was superseded');
      this.sourcePending = false;
      this.clearSeekPending();
      this.lastTimeValue = -1;
      this.lastTimeUpdateMs = 0;
      this.durationValue = result.duration;
      this.events.durationChange?.(result.duration);
      this.events.fileLoaded?.({ path: source.url, seq: result.seq, trackSeq: result.seq });
    })();
    this.sourceLoadPromise = loadTask;
    await loadTask;
  }

  async switchSource(source: string | PlaybackSource): Promise<number | null | undefined> {
    const revision = this.sourceRevision;
    const switchRevision = ++this.sourceSwitchRevision;
    const playbackSource = normalizePlaybackSource(source);
    if (!playbackSource.url) return;
    const result = await player?.switchSource?.(
      playbackSource.url,
      playbackSource.audioTrackId ?? null,
    );
    if (revision !== this.sourceRevision || switchRevision !== this.sourceSwitchRevision) return;
    // EOF can precede the audible end while queued audio is still playing.
    if (result === null) return null;
    if (!result) throw new Error('Audio source switch did not complete');
    this.clearSeekPending();
    this.sourceUrl = getPlaybackSourceKey(playbackSource);
    this.lastTimeValue = -1;
    return result?.[2];
  }

  /** 加载 MKV 并选择指定音轨 */
  setMkvSource(url: string, audioTrackId: number): Promise<void> {
    return this.setSource({ url, audioTrackId }, { force: true });
  }

  /**
   * 卡死恢复专用重载：换用新地址重新加载，但不重置 UI 的 duration/lastTime，
   * 避免进度条在 reload 期间闪回 0。归零/回跳的过滤由 store 的 stallRecovering 护栏处理。
   */
  async reloadSource(source: string | PlaybackSource): Promise<void> {
    const playbackSource = normalizePlaybackSource(source);
    if (!playbackSource.url) return;
    this.beginSourceChange();
    this.sourceUrl = getPlaybackSourceKey(playbackSource);
    await this.loadSource(playbackSource);
  }

  async beginNextSourcePreparation(): Promise<number | null> {
    return (await player?.beginNextSourcePreparation?.()) ?? null;
  }

  cancelNextSourcePreparation(requestId: number): void {
    void player?.cancelNextSourcePreparation?.(requestId).catch((error: unknown) => {
      logger.warn('PlayerEngine', 'cancel next source preparation failed', {
        error: String(error),
      });
    });
  }

  async prepareNextSource(
    source: PlaybackSource,
    requestId: number,
    normalizationGainDb = 0,
  ): Promise<number | null> {
    const playbackSource = normalizePlaybackSource(source);
    if (!playbackSource.url) return null;
    return (
      (await player?.prepareNextSource?.(
        playbackSource.url,
        requestId,
        playbackSource.audioTrackId ?? null,
        normalizationGainDb,
      )) ?? null
    );
  }

  clearPreparedNextSource(): void {
    void player?.clearPreparedNextSource?.()?.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'clear prepared source failed', { error: String(error) });
    });
  }

  async commitPreparedNextSource(transitionMs = 15): Promise<boolean> {
    return (await player?.commitPreparedNextSource?.(transitionMs)) ?? false;
  }

  adoptPreparedSource(source: string | PlaybackSource): void {
    const playbackSource = normalizePlaybackSource(source);
    if (!playbackSource.url) return;
    this.clearSeekPending();
    this.sourceUrl = getPlaybackSourceKey(playbackSource);
    this.lastTimeValue = -1;
  }

  /** 下发播放卡死检测阈值（秒，0=禁用）到 native 播放引擎看门狗 */
  setStallTimeout(seconds: number): void {
    void player?.setStallTimeout?.(Math.max(0, Number(seconds) || 0))?.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set stall timeout failed', { error: String(error) });
    });
  }

  /** 歌曲过渡设置：无缝 / 淡入淡出（0~15 秒）/ 智能混音基础 / 智能混音进阶。 */
  setTransitionSettings(options: { mode: string; fadeSecs: number; matchTempo?: boolean }): void {
    void player
      ?.setTransitionSettings?.(options)
      ?.then((snapshot) => {
        logger.info('PlayerEngine', 'Track transition settings applied', snapshot ?? options);
      })
      .catch((error: unknown) => {
        logger.warn('PlayerEngine', 'set transition settings failed', { error: String(error) });
      });
  }

  async play(options?: {
    fadeIn?: boolean;
    fadeDurationMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const revision = this.sourceRevision;
    const requestId = await this.sourceRequest;
    if (revision !== this.sourceRevision) return;
    if (this.sourcePending) {
      // 恢复播放撞上仍在下发的换源加载：静默早退会让渲染层标记为"播放中"而引擎
      // 实际保持暂停，需要再次点击暂停/播放才能恢复。等待这次加载落地后再补发播放命令。
      const pendingLoad = this.sourceLoadPromise;
      if (pendingLoad) {
        await pendingLoad.catch(() => undefined);
        if (revision !== this.sourceRevision) return;
      }
      // 加载失败且未被换代时无法继续，交给上层走重载兜底，避免静默成功。
      if (this.sourcePending) {
        throw new Error('Play deferred: audio source load not settled');
      }
    }
    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      logger.info('PlayerEngine', 'Fade in requested', {
        targetVolume: this.volumeValue,
        durationMs,
      });
      // 复合命令：主进程内完成 setVolume(0) → play → fade，fade 不阻塞
      await this.withTimeout(
        player?.playWithFade(this.volumeValue, durationMs, requestId ?? undefined) ??
          Promise.resolve(),
        options?.timeoutMs,
        'player play',
      );
    } else {
      await this.withTimeout(
        player?.play(requestId ?? undefined) ?? Promise.resolve(),
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

  async seek(time: number): Promise<void> {
    if (!Number.isFinite(time)) return;
    const request = { target: Math.max(0, time) };
    this.pendingSeek = request;
    this.lastTimeValue = -1;
    this.lastTimeUpdateMs = 0;
    try {
      await player?.seek(request.target);
    } catch (err) {
      logger.warn('PlayerEngine', 'seek failed', { time, error: String(err) });
    } finally {
      // EOF and superseded native seeks can resolve without seeked/playback-restart.
      // The command lifetime owns this gate; an older command must not clear a new one.
      if (this.pendingSeek === request) this.clearSeekPending();
    }
  }

  setEqualizer(gains: number[]): void {
    const command = player?.setEqualizer(gains.map((gain) => Number(gain) || 0));
    if (!command) return;
    void command.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set equalizer failed', { error: String(error) });
    });
  }

  async setSpatialAudioEffect(options: AudioEffectPlaybackOptions | null): Promise<void> {
    const command = player?.setAudioEffect(options);
    if (!command) return;
    try {
      await command;
    } catch (error: unknown) {
      logger.warn('PlayerEngine', 'set audio effect failed', { error: String(error) });
      throw error;
    }
  }

  async getAudioGraph(): Promise<PlayerAudioGraphSnapshot | null> {
    return (await player?.getAudioGraph?.()) ?? null;
  }

  async setAudioGraphParameter(patch: PlayerAudioGraphParameterPatch): Promise<void> {
    const command = player?.setAudioGraphParameter?.(patch);
    if (!command) return;
    try {
      await command;
    } catch (error: unknown) {
      logger.warn('PlayerEngine', 'set audio graph parameter failed', {
        patch,
        error: String(error),
      });
      throw error;
    }
  }

  setAudioGraphPlan(plan: PlayerAudioGraphPlanPatch): void {
    const command = player?.setAudioGraphPlan?.(plan);
    if (!command) return;
    void command.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set audio graph plan failed', {
        plan,
        error: String(error),
      });
    });
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 100);
    this.volumeValue = next;
    void player?.setVolume(next)?.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set volume failed', { error: String(error) });
    });
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const to = clamp(value, 0, 100);
    const from = this.volumeValue;
    this.volumeValue = to;
    if (durationMs <= 0) {
      void player?.setVolume(to)?.catch((error: unknown) => {
        logger.warn('PlayerEngine', 'set volume failed', { error: String(error) });
      });
      return Promise.resolve();
    }
    // fade 完成或被取消后，同步最终音量到 player，防止音量卡在中间值
    return (player?.fade(from, to, durationMs) ?? Promise.resolve()).then(() => {
      void player?.setVolume(this.volumeValue)?.catch((error: unknown) => {
        logger.warn('PlayerEngine', 'set volume failed', { error: String(error) });
      });
    });
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    const command = player?.setSpeed(next);
    if (!command) return next;
    void command.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set speed failed', { error: String(error) });
    });
    return next;
  }

  reset(): void {
    ++this.sourceRevision;
    this.sourcePending = true;
    this.sourceRequest = null;
    this.clearSeekPending();
    void player?.stop()?.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'stop failed', { error: String(error) });
    });
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  /** 设置 player 文件循环模式（单曲循环用） */
  setLoopFile(loop: boolean): void {
    void player?.setLoopFile(loop)?.catch((error: unknown) => {
      logger.warn('PlayerEngine', 'set loop file failed', { error: String(error) });
    });
  }

  // ── 音量均衡 ──

  setVolumeNormalization(enabled: boolean): void {
    this.normalizationEnabled = enabled;
    if (!enabled) {
      this.resetNormalizationGain();
    } else if (this.lastTrackLoudness) {
      // 开启时用已有的响度数据重新应用增益
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
    logger.info('PlayerEngine', 'Volume normalization toggled', { enabled });
  }

  applyTrackLoudness(loudness: TrackLoudness | null): void {
    this.lastTrackLoudness = loudness;
    if (!loudness || !this.normalizationEnabled) {
      this.resetNormalizationGain();
      return;
    }
    const { lufs } = loudness;
    if (!Number.isFinite(lufs)) {
      this.resetNormalizationGain();
      return;
    }
    const gainDb = calculateNormalizationGainDb(loudness, this.referenceLufs);
    const gainLinear = Math.pow(10, gainDb / 20);
    if (Math.abs(this.normalizationGain - gainLinear) < NORMALIZATION_GAIN_EPSILON) return;
    this.normalizationGain = gainLinear;
    const command = player?.setNormalizationGain(gainDb);
    if (command) {
      void command.catch((error: unknown) => {
        logger.warn('PlayerEngine', 'set normalization gain failed', { error: String(error) });
      });
    }
    logger.info('PlayerEngine', 'Track loudness applied', {
      lufs,
      referenceLufs: this.referenceLufs,
      peakDb: loudness.peak,
      upstreamGainDb: loudness.gain,
      gainDb: gainDb.toFixed(2) + ' dB',
    });
  }

  adoptPreparedTrackLoudness(loudness: TrackLoudness | null): void {
    // Native owns the queued overlap reference and the final gain marker. Update the
    // track cache without overwriting either gain at the audible track boundary.
    this.lastTrackLoudness = loudness;
    this.normalizationGain = Math.pow(10, this.getTrackLoudnessGainDb(loudness) / 20);
  }

  getTrackLoudnessGainDb(loudness: TrackLoudness | null): number {
    if (!loudness || !this.normalizationEnabled || !Number.isFinite(loudness.lufs)) return 0;
    return calculateNormalizationGainDb(loudness, this.referenceLufs);
  }

  get normalizationGainDb(): number {
    return this.normalizationEnabled ? 20 * Math.log10(this.normalizationGain) : 0;
  }

  setReferenceLufs(lufs: number): void {
    this.referenceLufs = clamp(lufs, -20, -8);
    if (this.normalizationEnabled && this.lastTrackLoudness) {
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
    logger.info('PlayerEngine', 'Reference loudness updated', {
      referenceLufs: this.referenceLufs,
      currentGainDb: this.normalizationGainDb.toFixed(2) + ' dB',
    });
  }

  private resetNormalizationGain(): void {
    if (Math.abs(this.normalizationGain - 1.0) < NORMALIZATION_GAIN_EPSILON) return;
    this.normalizationGain = 1.0;
    const command = player?.setNormalizationGain(0);
    if (command) {
      void command.catch((error: unknown) => {
        logger.warn('PlayerEngine', 'set normalization gain failed', { error: String(error) });
      });
    }
  }

  // ── 系统媒体控制（通过主进程 native addon） ──

  /** 更新系统媒体控制的歌曲元数据 */
  updateMediaMetadata(meta: MediaSessionMeta): void {
    const coverUrl = meta.artwork?.[meta.artwork.length - 1]?.src;

    mediaControls?.updateMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album ?? '',
      coverUrl,
      durationMs: meta.durationMs || 0,
    });
    void window.electron?.output
      ?.setTrackMeta({
        title: meta.title,
        artist: meta.artist,
        album: meta.album ?? '',
        artwork: coverUrl,
        durationMs: meta.durationMs || 0,
      })
      .catch(() => undefined);
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

  /** 更新系统媒体控制的快进 / 快退偏好间隔 */
  updateMediaSkipIntervals(intervals: MediaSessionSkipIntervals): void {
    mediaControls?.updateSkipIntervals({
      forwardMs: Math.max(0, Number(intervals.forwardOffset) || 0) * 1000,
      backwardMs: Math.max(0, Number(intervals.backwardOffset) || 0) * 1000,
    });
  }

  /** 注册系统媒体控制事件处理（通过主进程 IPC 转发） */
  setMediaSessionHandlers(handlers: {
    play?: () => void;
    pause?: () => void;
    previoustrack?: () => void;
    nexttrack?: () => void;
    seekto?: (time: number) => void;
    seekbackward?: (offset?: number) => void;
    seekforward?: (offset?: number) => void;
  }): void {
    // 监听主进程转发的原生媒体控制事件
    const offEvent = mediaControls?.onEvent?.(
      (event: { type: string; positionMs?: number; offsetMs?: number }) => {
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
          case 'SeekForward':
            handlers.seekforward?.(
              event.offsetMs !== undefined ? event.offsetMs / 1000 : undefined,
            );
            break;
          case 'SeekBackward':
            handlers.seekbackward?.(
              event.offsetMs !== undefined ? event.offsetMs / 1000 : undefined,
            );
            break;
        }
      },
    );
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
