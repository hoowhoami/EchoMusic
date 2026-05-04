import { defineStore } from 'pinia';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import logger from '@/utils/logger';
import { getCloudSongUrl, getSongClimax, getSongPrivilegeLite, getSongUrl } from '@/api/music';
import { getServerNow, uploadPlayHistory } from '@/api/user';
import {
  PlayerEngine,
  type MediaSessionMeta,
  type MediaSessionState,
  type PlayerEngineEvents,
  type TrackLoudness,
} from '@/utils/player';
import { getCoverUrl } from '@/utils/cover';
import type { Song, SongRelateGood } from '@/models/song';
import {
  doesRelateGoodMatchQuality,
  getSongQualityCandidates,
  isPaidSong,
  isPlayableSong,
  resolveEffectiveSongQuality,
} from '@/utils/song';
import type {
  AudioEffectValue,
  AudioQualityValue,
  OutputDeviceDisconnectBehavior,
  PlayMode,
} from '../types';

const normalizeQuality = (value: string | undefined): AudioQualityValue => {
  if (
    value === '128' ||
    value === '320' ||
    value === 'flac' ||
    value === 'high' ||
    value === 'super'
  )
    return value;
  return 'high';
};

const normalizeEffect = (value: string | undefined): AudioEffectValue => {
  const options: AudioEffectValue[] = [
    'none',
    'piano',
    'vocal',
    'accompaniment',
    'subwoofer',
    'ancient',
    'surnay',
    'dj',
    'viper_tape',
    'viper_atmos',
    'viper_clear',
  ];
  return options.includes(value as AudioEffectValue) ? (value as AudioEffectValue) : 'none';
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const findPlayableIndex = (
  songs: Song[],
  startIndex: number,
  forward: boolean,
  inclusive = true,
): number => {
  if (songs.length === 0) return -1;
  const normalizedStart = startIndex >= 0 ? startIndex % songs.length : 0;
  for (let step = 0; step < songs.length; step += 1) {
    const offset = inclusive ? step : step + 1;
    const index = forward
      ? (normalizedStart + offset) % songs.length
      : (normalizedStart - offset + songs.length) % songs.length;
    if (isPlayableSong(songs[index])) return index;
  }
  return -1;
};

const resolveUrlFromResponse = (payload: unknown): string => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  if (Array.isArray(payload)) {
    const first = payload.find((item) => typeof item === 'string' && item.trim());
    return typeof first === 'string' ? first : '';
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const urlField = record.url ?? record.play_url ?? record.playUrl;
    if (typeof urlField === 'string' && urlField.trim()) return urlField;
    if (Array.isArray(urlField)) {
      const candidate = urlField.find((item) => typeof item === 'string' && item.trim());
      return typeof candidate === 'string' ? candidate : '';
    }
    if ('data' in record) return resolveUrlFromResponse(record.data);
    if ('info' in record) return resolveUrlFromResponse(record.info);
  }
  return '';
};

/** 从 API 响应中提取曲目响度信息 */
const resolveTrackLoudness = (payload: unknown): TrackLoudness | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  // 响度字段可能在顶层或 data 层
  const source =
    typeof record.volume === 'number'
      ? record
      : typeof record.data === 'object' && record.data !== null
        ? (record.data as Record<string, unknown>)
        : null;
  if (!source || typeof source.volume !== 'number') return null;
  const lufs = source.volume as number;
  const gain =
    typeof source.volume_gain === 'number'
      ? (source.volume_gain as number)
      : typeof source.volumeGain === 'number'
        ? (source.volumeGain as number)
        : 0;
  const peak =
    typeof source.volume_peak === 'number'
      ? (source.volume_peak as number)
      : typeof source.volumePeak === 'number'
        ? (source.volumePeak as number)
        : 0;
  if (!Number.isFinite(lufs)) return null;
  // volume=0 且 volume_gain=0 表示服务端没有响度数据
  if (lufs === 0 && gain === 0) return null;
  return { lufs, gain, peak: Math.max(0, peak) };
};

const findTrackById = (
  id: string | null,
  list: Song[] | null | undefined,
  playlistStore: ReturnType<typeof usePlaylistStore>,
): Song | undefined => {
  if (!id) return undefined;
  const targetId = String(id);
  const pool = [
    list ?? [],
    playlistStore.activeQueue?.songs ?? [],
    playlistStore.defaultList,
    playlistStore.favorites,
  ];
  for (const group of pool) {
    const found = group.find((song) => String(song.id) === targetId);
    if (found) return found;
  }
  return undefined;
};

const HISTORY_UPLOAD_MIN_SECONDS = 15;
const HISTORY_UPLOAD_PROGRESS_RATIO = 0.5;

const resolveTrackMxid = (track: Song | null | undefined): number | null => {
  if (!track) return null;
  const candidates = [track.mixSongId, track.fileId, track.id];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const trimPlayCountMap = (source: Record<string, number>, limit = 500): Record<string, number> => {
  const entries = Object.entries(source);
  if (entries.length <= limit) return source;
  return Object.fromEntries(entries.slice(entries.length - limit));
};

const resolveServerTimestamp = (payload: unknown): number | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const source = (record.data && typeof record.data === 'object' ? record.data : record) as Record<
    string,
    unknown
  >;
  const candidates = [
    source.now,
    source.time,
    source.timestamp,
    source.server_time,
    source.serverTime,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
  }
  return null;
};

type ResolvedAudioSource = {
  url: string;
  quality: AudioQualityValue | null;
  effect: AudioEffectValue;
  loudness: TrackLoudness | null;
};

type ClimaxMark = { start: number; end: number };

type PlaybackNotice = {
  code: string;
  title: string;
  reason: string;
  detail: string;
  trackId: string | null;
};

// 保持一个全局 PlayerEngine 实例
const engine = new PlayerEngine();
let outputDeviceChangeHandler:
  | ((devices: Array<{ name: string; description: string }>) => void)
  | null = null;

const buildMediaMeta = (track: Song | undefined): MediaSessionMeta | null => {
  if (!track) return null;
  return {
    title: track.title,
    artist: track.artist || '未知歌手',
    album: track.album ?? '',
    artwork: [96, 128, 192, 256, 384, 512].map((size) => ({
      src: getCoverUrl(track.coverUrl, size),
      sizes: `${size}x${size}`,
      type: 'image/jpeg',
    })),
  };
};

const buildMediaState = (state: {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  playbackRate: number;
}): MediaSessionState => ({
  isPlaying: state.isPlaying,
  duration: state.duration,
  currentTime: state.currentTime,
  playbackRate: state.playbackRate,
});

const buildStoppedPlaybackState = (state: { playbackRate: number }): MediaSessionState => ({
  isPlaying: false,
  duration: 0,
  currentTime: 0,
  playbackRate: state.playbackRate,
});

const privilegeLiteRequests = new Map<string, Promise<SongRelateGood[]>>();

const parseRelateGoodsFromPrivilege = (payload: unknown): SongRelateGood[] => {
  if (!payload || typeof payload !== 'object') return [];
  const source =
    'data' in (payload as Record<string, unknown>) ? (payload as { data?: unknown }).data : payload;
  const list = Array.isArray(source) ? source : [];
  const first = list[0] as Record<string, unknown> | undefined;
  const goods = (first?.relate_goods ?? first?.relateGoods ?? []) as unknown;
  if (!Array.isArray(goods)) return [];
  return goods
    .filter((item) => typeof item === 'object' && item !== null)
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({
      hash: typeof item.hash === 'string' ? item.hash : undefined,
      quality: typeof item.quality === 'string' ? item.quality : undefined,
      level: typeof item.level === 'number' ? item.level : undefined,
    }));
};

const summarizeSong = (track: Song | undefined) => {
  if (!track) return null;
  return {
    id: String(track.id),
    title: track.title,
    artist: track.artist || '未知歌手',
    album: track.album || '',
    duration: track.duration || 0,
    hash: track.hash || '',
    privilege: track.privilege ?? null,
    payType: track.payType ?? null,
    source: track.source || '',
  };
};

const resolvePlaybackNotice = (params: {
  code: string;
  track?: Song | null;
  autoNextEnabled?: boolean;
  autoNextDelaySeconds?: number;
}): PlaybackNotice => {
  const trackId = params.track ? String(params.track.id) : null;
  const requiresPurchase = Boolean(params.track && isPaidSong(params.track));
  const autoNextDelay = Math.max(0, Math.floor(params.autoNextDelaySeconds ?? 0));
  const autoNextDetail = params.autoNextEnabled
    ? `${autoNextDelay > 0 ? `${autoNextDelay} 秒后` : '即将'}尝试下一首`
    : '请稍后重试';

  if (params.code === 'track-not-playable') {
    return {
      code: params.code,
      title: '播放失败',
      reason: '当前歌曲暂不可播放',
      detail: autoNextDetail,
      trackId,
    };
  }

  if (params.code === 'audio-url-unavailable') {
    return {
      code: params.code,
      title: '播放失败',
      reason: requiresPurchase ? '可能需要购买或账号权限' : '暂时无法获取可用音源',
      detail: autoNextDetail,
      trackId,
    };
  }

  return {
    code: params.code,
    title: '播放失败',
    reason: requiresPurchase ? '可能需要购买或账号权限' : '音频加载或播放过程中出现异常',
    detail: autoNextDetail,
    trackId,
  };
};

export const usePlayerStore = defineStore('player', {
  state: () => ({
    isPlaying: false,
    isLyricViewOpen: false,
    volume: 0.8,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    playMode: 'list' as PlayMode,
    equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as number[],
    currentTrackId: null as string | null,
    currentSourceQueueId: null as string | null,
    isLoading: false,
    lastError: '' as string | null,
    currentPlaylist: null as Song[] | null,
    currentAudioUrl: '' as string,
    currentResolvedAudioQuality: null as AudioQualityValue | null,
    currentResolvedAudioEffect: 'none' as AudioEffectValue,
    audioEffect: 'none' as AudioEffectValue,
    recentSeekIgnoreEnd: false,
    settingsWatcherRegistered: false,
    isDraggingProgress: false,
    pendingSettingRefresh: false,
    climaxMarks: [] as ClimaxMark[],
    outputDeviceWatcherRegistered: false,
    outputDeviceRefreshTimer: null as number | null,
    appliedOutputDeviceId: 'default' as string,
    _lastAppliedExclusive: false,
    currentAudioQualityOverride: null as AudioQualityValue | null,
    playbackRequestSeq: 0,
    climaxRequestSeq: 0,
    currentTrackSnapshot: null as Song | null,
    historyUploadCommitted: false,
    historyUploadTrackId: null as string | null,
    historyUploadPlayCount: 0,
    historyPlayCountMap: {} as Record<string, number>,
    autoNextTimer: null as number | null,
    autoNextAttempts: 0,
    autoNextSourceTrackId: null as string | null,
    playbackNotice: null as PlaybackNotice | null,
    shuffleQueue: null as number[] | null,
    shuffleQueueLength: 0,
    shufflePlayed: new Set<number>(),
    seekTargetTime: null as number | null,
    seekTimestamp: 0,
    isResuming: false,
  }),
  actions: {
    toggleLyricView(open?: boolean) {
      this.isLyricViewOpen = open ?? !this.isLyricViewOpen;
    },
    showPlaybackNotice(code: string, track?: Song | null) {
      const settingStore = useSettingStore();
      this.playbackNotice = resolvePlaybackNotice({
        code,
        track,
        autoNextEnabled: settingStore.autoNext,
        autoNextDelaySeconds: settingStore.autoNextDelaySeconds,
      });
    },

    clearPlaybackNotice(trackId?: string | number | null) {
      if (!this.playbackNotice) return;
      if (
        trackId !== undefined &&
        trackId !== null &&
        this.playbackNotice.trackId !== String(trackId)
      )
        return;
      this.playbackNotice = null;
    },

    getTrackedPlayCount(track?: Song | null): number {
      const mxid = resolveTrackMxid(track);
      if (!mxid) return Math.max(0, track?.playCount ?? 0);
      return Math.max(0, this.historyPlayCountMap[String(mxid)] ?? track?.playCount ?? 0);
    },

    syncTrackedPlayCount(track: Song, playCount: number) {
      const mxid = resolveTrackMxid(track);
      if (!mxid || playCount <= 0) return;
      this.historyPlayCountMap = trimPlayCountMap({
        ...this.historyPlayCountMap,
        [String(mxid)]: Math.max(playCount, this.historyPlayCountMap[String(mxid)] ?? 0),
      });
    },

    hydrateHistoryPlayCounts(tracks: Song[]) {
      if (tracks.length === 0) return;
      const nextMap = { ...this.historyPlayCountMap };
      let changed = false;
      tracks.forEach((track) => {
        const mxid = resolveTrackMxid(track);
        const playCount = Math.max(0, track.playCount ?? 0);
        if (!mxid || playCount <= 0) return;
        const key = String(mxid);
        if (playCount > (nextMap[key] ?? 0)) {
          nextMap[key] = playCount;
          changed = true;
        }
      });
      if (changed) {
        this.historyPlayCountMap = trimPlayCountMap(nextMap);
      }
    },

    resetHistoryUploadState(track?: Song | null) {
      this.historyUploadCommitted = false;
      this.historyUploadTrackId = track ? String(track.id) : null;
      this.historyUploadPlayCount = Math.max(1, this.getTrackedPlayCount(track) + 1);
    },

    async commitListeningHistory(track?: Song | null) {
      const target = track ?? this.currentTrackSnapshot;
      if (!target || !this.currentTrackId) return;
      const activeTrackId = String(this.currentTrackId);
      if (String(target.id) !== activeTrackId) return;
      if (this.historyUploadCommitted && this.historyUploadTrackId === activeTrackId) return;

      const mxid = resolveTrackMxid(target);
      if (!mxid) {
        logger.warn(
          'PlayerStore',
          'Skip play history upload because mxid is missing',
          summarizeSong(target),
        );
        return;
      }

      const effectiveDuration = Number(target.duration || this.duration || 0);
      const effectiveProgress = Number(this.currentTime || 0);
      const requiredProgress =
        effectiveDuration > 0
          ? Math.min(
              Math.max(
                effectiveDuration * HISTORY_UPLOAD_PROGRESS_RATIO,
                HISTORY_UPLOAD_MIN_SECONDS,
              ),
              effectiveDuration,
            )
          : HISTORY_UPLOAD_MIN_SECONDS;

      if (effectiveProgress < requiredProgress) {
        return;
      }

      let timestamp = Math.floor(Date.now() / 1000);
      try {
        const nowRes = await getServerNow();
        timestamp = resolveServerTimestamp(nowRes) ?? timestamp;
      } catch (error) {
        logger.warn('PlayerStore', 'Fetch server time failed, fallback to local timestamp', error);
      }

      try {
        const playCount = Math.max(
          1,
          this.historyUploadPlayCount || this.getTrackedPlayCount(target) + 1,
        );
        const res = await uploadPlayHistory(mxid, { time: timestamp, pc: playCount });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          this.historyUploadCommitted = true;
          this.historyUploadTrackId = activeTrackId;
          this.historyUploadPlayCount = playCount;
          this.syncTrackedPlayCount(target, playCount);
          if (this.currentTrackSnapshot && String(this.currentTrackSnapshot.id) === activeTrackId) {
            this.currentTrackSnapshot = {
              ...this.currentTrackSnapshot,
              playCount,
              lastPlayedAt: timestamp,
            };
          }
          logger.info('PlayerStore', 'Play history uploaded', {
            track: summarizeSong(target),
            mxid,
            playCount,
            timestamp,
            progress: effectiveProgress,
          });
        }
      } catch (error) {
        logger.error('PlayerStore', 'Upload history sync error:', error);
      }
    },

    maybeCommitListeningHistory() {
      void this.commitListeningHistory();
    },

    clearAutoNextTimer() {
      if (this.autoNextTimer !== null) {
        window.clearTimeout(this.autoNextTimer);
        this.autoNextTimer = null;
      }
    },

    clearOutputDeviceRefreshTimer() {
      if (this.outputDeviceRefreshTimer !== null) {
        window.clearTimeout(this.outputDeviceRefreshTimer);
        this.outputDeviceRefreshTimer = null;
      }
    },

    unregisterOutputDeviceWatcher() {
      outputDeviceChangeHandler = null;
      this.outputDeviceWatcherRegistered = false;
      this.clearOutputDeviceRefreshTimer();
    },

    applyFailedPlaybackState(options?: { keepResolvedSource?: boolean }) {
      this.isLoading = false;
      this.isPlaying = false;
      this.currentTime = 0;
      this.duration = 0;
      if (!options?.keepResolvedSource) {
        this.currentAudioUrl = '';
        this.currentResolvedAudioQuality = null;
        this.currentResolvedAudioEffect = 'none';
      }

      engine.updateMediaPlaybackState(
        buildStoppedPlaybackState({
          playbackRate: this.playbackRate,
        }),
      );
    },

    scheduleAutoNext() {
      const settingStore = useSettingStore();
      const playlistStore = usePlaylistStore();
      if (!settingStore.autoNext || !this.currentTrackId) return;

      const list =
        (playlistStore.activeQueue?.songs?.length ?? 0) > 0
          ? (playlistStore.activeQueue?.songs ?? [])
          : (this.currentPlaylist ?? []);
      if (list.length <= 1) return;

      const currentTrackId = String(this.currentTrackId);
      const maxAttempts = Math.max(0, Math.floor(settingStore.autoNextMaxAttempts || 0));
      if (maxAttempts > 0 && this.autoNextAttempts >= maxAttempts) {
        return;
      }

      this.clearAutoNextTimer();
      const delayMs = Math.max(0, Math.floor((settingStore.autoNextDelaySeconds || 0) * 1000));
      this.autoNextTimer = window.setTimeout(() => {
        this.autoNextTimer = null;
        if (
          String(this.currentTrackId ?? '') !== currentTrackId ||
          this.isPlaying ||
          this.isLoading
        )
          return;
        this.autoNextAttempts += 1;
        void this.skipToNextAfterFailure();
      }, delayMs);
    },

    skipToNextAfterFailure() {
      const playlistStore = usePlaylistStore();
      playlistStore.syncQueuedNextTrackIds();
      if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
        const currentTrack =
          findTrackById(this.currentTrackId, this.currentPlaylist, playlistStore) ??
          this.currentTrackSnapshot;
        void playlistStore.ensurePersonalFmQueue({
          track: currentTrack,
          playtime: this.currentTime,
          isOverplay: false,
        });
      }
      const list =
        (playlistStore.activeQueue?.songs?.length ?? 0) > 0
          ? (playlistStore.activeQueue?.songs ?? [])
          : (this.currentPlaylist ?? []);
      if (list.length === 0 || !this.currentTrackId) return;

      const currentIndex = list.findIndex(
        (song) => String(song.id) === String(this.currentTrackId),
      );
      let nextIndex = -1;

      if (this.playMode === 'random') {
        nextIndex = this.pickRandomIndex(list.length, currentIndex);
        if (!isPlayableSong(list[nextIndex])) {
          nextIndex = findPlayableIndex(list, nextIndex, true, false);
        }
      } else {
        nextIndex = findPlayableIndex(list, Math.max(0, currentIndex), true, false);
      }

      const nextSong = nextIndex >= 0 ? list[nextIndex] : null;
      if (!nextSong) return;

      return this.playTrack(String(nextSong.id), list, {
        preserveFailureChain: true,
        sourceQueueId: this.currentSourceQueueId,
      });
    },

    init() {
      const settingStore = useSettingStore();
      logger.info('PlayerStore', 'Initializing player store', {
        volume: this.volume,
        playbackRate: this.playbackRate,
        playMode: this.playMode,
      });
      // 恢复持久化的音量与倍速
      engine.setVolume(this.volume);
      engine.setPlaybackRate(this.playbackRate);
      // 恢复音量均衡设置
      engine.setVolumeNormalization(settingStore.volumeNormalization);
      engine.setReferenceLufs(settingStore.volumeNormalizationLufs);
      // 同步文件循环模式
      engine.setLoopFile(this.playMode === 'single');
      this.registerSettingWatchers(settingStore);
      this.registerOutputDeviceWatcher(settingStore);
      void this.refreshOutputDevices(undefined, settingStore);

      // 节流：MediaSession 位置状态每 2 秒同步一次即可
      let lastMediaSessionSync = 0;
      const MEDIA_SESSION_SYNC_MS = 2000;
      // 节流：播放历史上报每 5 秒检查一次
      let lastHistoryCheck = 0;
      const HISTORY_CHECK_MS = 5000;

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime) => {
          if (this.isDraggingProgress) return;
          // seek 后短暂忽略回退的 timeUpdate
          if (
            this.seekTargetTime !== null &&
            Date.now() - this.seekTimestamp < 500 &&
            currentTime < this.seekTargetTime - 0.5
          ) {
            return;
          }
          this.seekTargetTime = null;
          this.currentTime = currentTime;

          const now = Date.now();
          if (now - lastHistoryCheck >= HISTORY_CHECK_MS) {
            lastHistoryCheck = now;
            this.maybeCommitListeningHistory();
          }
          if (now - lastMediaSessionSync >= MEDIA_SESSION_SYNC_MS) {
            lastMediaSessionSync = now;
            engine.updateMediaPlaybackState(
              buildMediaState({
                isPlaying: this.isPlaying,
                duration: this.duration,
                currentTime,
                playbackRate: this.playbackRate,
              }),
            );
          }
        },
        durationChange: (duration) => {
          // 始终使用 mpv 报告的实际时长，这是真实可播放范围
          this.duration = duration;
          engine.updateMediaPlaybackState(
            buildMediaState({
              isPlaying: this.isPlaying,
              duration,
              currentTime: this.currentTime,
              playbackRate: this.playbackRate,
            }),
          );
          // 检测实际时长与歌曲元数据时长的差异，差异过大时提示歌词可能不同步
          const lyricStore = useLyricStore();
          const trackDuration = this.currentTrackSnapshot?.duration ?? 0;
          if (duration > 0 && trackDuration > 0) {
            const diff = Math.abs(duration - trackDuration);
            lyricStore.lyricSyncWarning = diff > 10 && diff / trackDuration > 0.1;
          } else {
            lyricStore.lyricSyncWarning = false;
          }
        },
        ended: () => {
          if (this.recentSeekIgnoreEnd) {
            logger.debug('PlayerStore', 'Ignore ended event after recent seek');
            this.recentSeekIgnoreEnd = false;
            return;
          }
          logger.info('PlayerStore', 'Received playback ended event', {
            currentTrackId: this.currentTrackId,
            currentTime: this.currentTime,
            duration: this.duration,
            playMode: this.playMode,
          });
          this.handlePlaybackEnded();
        },
        play: () => {
          logger.info('PlayerStore', 'Playback started', {
            currentTrackId: this.currentTrackId,
            currentTime: this.currentTime,
            duration: this.duration,
          });
          this.isPlaying = true;
          this.isLoading = false;
          this.clearPlaybackNotice(this.currentTrackId);
          settingStore.syncPreventSleep(true);
          engine.updateMediaPlaybackState(
            buildMediaState({
              isPlaying: true,
              duration: this.duration,
              currentTime: this.currentTime,
              playbackRate: this.playbackRate,
            }),
          );
        },
        pause: () => {
          logger.info('PlayerStore', 'Playback paused', {
            currentTrackId: this.currentTrackId,
            currentTime: this.currentTime,
            duration: this.duration,
          });
          this.isPlaying = false;
          settingStore.syncPreventSleep(false);
          engine.updateMediaPlaybackState(
            buildMediaState({
              isPlaying: false,
              duration: this.duration,
              currentTime: this.currentTime,
              playbackRate: this.playbackRate,
            }),
          );
        },
        error: (event) => {
          // 过滤虚假的播放错误（isTrusted=false 表示合成事件，通常不是真实错误）
          if (event && !event.isTrusted && !(event as any)?.detail) {
            return;
          }

          logger.error('PlayerStore', 'Audio playback error:', event);
          this.lastError = (event as any)?.type ?? 'playback-error';
          this.showPlaybackNotice('playback-failed', this.currentTrackSnapshot);
          this.applyFailedPlaybackState({ keepResolvedSource: true });
          settingStore.syncPreventSleep(false);

          if (settingStore.autoNext && this.currentPlaylist?.length) {
            this.scheduleAutoNext();
            return;
          }

          this.clearAutoNextTimer();
        },
      };

      engine.setEvents(events);
      engine.setMediaSessionHandlers({
        play: () => {
          if (!this.isPlaying) this.togglePlay();
        },
        pause: () => {
          if (this.isPlaying) this.togglePlay();
        },
        previoustrack: () => this.prev(),
        nexttrack: () => this.next(),
        seekto: (time) => this.seek(time),
        seekbackward: (offset) => this.seek(Math.max(0, this.currentTime - offset)),
        seekforward: (offset) => this.seek(Math.min(this.duration, this.currentTime + offset)),
      });

      // 渲染进程重新加载后，从 mpv 同步当前播放状态
      window.electron?.mpv?.getState?.().then((state) => {
        if (!state) return;
        if (state.playing && !this.isPlaying) {
          this.isPlaying = true;
          this.isLoading = false;
          settingStore.syncPreventSleep(true);
        }
        if (state.duration > 0) {
          this.duration = state.duration;
        }
        if (state.timePos > 0) {
          this.currentTime = state.timePos;
        }
      });
    },

    registerSettingWatchers(settingStore: ReturnType<typeof useSettingStore>) {
      if (this.settingsWatcherRegistered) return;
      this.settingsWatcherRegistered = true;

      let snapshot = {
        defaultAudioQuality: settingStore.defaultAudioQuality,
        compatibilityMode: settingStore.compatibilityMode,
        volumeFade: settingStore.volumeFade,
        volumeFadeTime: settingStore.volumeFadeTime,
        outputDevice: settingStore.outputDevice,
        exclusiveAudioDevice: settingStore.exclusiveAudioDevice,
      };

      settingStore.$subscribe((_mutation, state) => {
        const shouldRefreshDefaultQuality =
          this.currentAudioQualityOverride === null &&
          state.defaultAudioQuality !== snapshot.defaultAudioQuality;
        const shouldRefresh =
          shouldRefreshDefaultQuality || state.compatibilityMode !== snapshot.compatibilityMode;
        const shouldUpdateFade =
          state.volumeFade !== snapshot.volumeFade ||
          state.volumeFadeTime !== snapshot.volumeFadeTime;
        const shouldUpdateOutputDevice =
          state.outputDevice !== snapshot.outputDevice ||
          state.exclusiveAudioDevice !== snapshot.exclusiveAudioDevice;

        snapshot = {
          defaultAudioQuality: state.defaultAudioQuality,
          compatibilityMode: state.compatibilityMode,
          volumeFade: state.volumeFade,
          volumeFadeTime: state.volumeFadeTime,
          outputDevice: state.outputDevice,
          exclusiveAudioDevice: state.exclusiveAudioDevice,
        };

        if (shouldRefresh) {
          if (this.isLoading || this.pendingSettingRefresh) {
            this.pendingSettingRefresh = true;
          } else {
            void this.refreshCurrentTrack();
          }
        }

        if (shouldUpdateFade && this.isPlaying) {
          void this.fadeVolume(this.volume, { durationMs: 120, respectUserVolume: false });
        }

        if (shouldUpdateOutputDevice) {
          void this.applyOutputDevice(state.outputDevice, settingStore);
        }
      });
    },

    async togglePlay() {
      logger.info('PlayerStore', 'Toggle play requested', {
        currentTrackId: this.currentTrackId,
        isPlaying: this.isPlaying,
        hasSource: !!engine.source,
        isResuming: this.isResuming,
      });

      if (this.isResuming) {
        logger.debug('PlayerStore', 'Ignoring toggle: already resuming');
        return;
      }

      if (!this.currentTrackId) {
        const playlist = usePlaylistStore();
        if ((playlist.activeQueue?.songs.length ?? playlist.defaultList.length) > 0) {
          const activeSongs = playlist.activeQueue?.songs ?? playlist.defaultList;
          let firstTrackIndex = 0;
          if (this.playMode === 'random') {
            firstTrackIndex = Math.floor(Math.random() * activeSongs.length);
          }
          const playableIndex = findPlayableIndex(activeSongs, firstTrackIndex, true, true);
          if (playableIndex !== -1) {
            const trackToPlay = activeSongs[playableIndex];
            logger.info('PlayerStore', 'No active track, starting playback', {
              trackId: trackToPlay.id,
              index: playableIndex,
              playMode: this.playMode,
              listLength: activeSongs.length,
            });
            this.playTrack(trackToPlay.id, activeSongs);
          } else {
            logger.warn('PlayerStore', 'No playable track found in the list.');
          }
        }
        return;
      }

      if (this.isPlaying) {
        // 乐观更新：立即切换 UI 状态，不等待 IPC 往返
        // mpv 的 state-change 事件会做最终确认（幂等赋值 isPlaying = false）
        // pause 命令几乎不可能失败（唯一场景是 mpv 崩溃，此时音乐本身也停了）
        this.isPlaying = false;
        const settingStore = useSettingStore();
        settingStore.syncPreventSleep(false);
        engine.updateMediaPlaybackState(
          buildMediaState({
            isPlaying: false,
            duration: this.duration,
            currentTime: this.currentTime,
            playbackRate: this.playbackRate,
          }),
        );

        engine.pause().catch((err) => {
          logger.error('PlayerStore', 'Pause command failed', err);
        });
        return;
      }

      if (!engine.source) {
        logger.info('PlayerStore', 'No active audio source, replaying current track', {
          currentTrackId: this.currentTrackId,
        });
        await this.playTrack(this.currentTrackId);
        return;
      }

      this.isResuming = true;
      this.isPlaying = true;
      const settingStore = useSettingStore();
      settingStore.syncPreventSleep(true);
      engine.updateMediaPlaybackState(
        buildMediaState({
          isPlaying: true,
          duration: this.duration,
          currentTime: this.currentTime,
          playbackRate: this.playbackRate,
        }),
      );

      try {
        const timeoutMs = (settingStore.playResumeTimeout ?? 5) * 1000;
        await engine.play({ timeoutMs: timeoutMs > 0 ? timeoutMs : undefined });
      } catch (error) {
        logger.error('PlayerStore', 'Playback resume failed, replaying current track', error);
        // play 失败，回滚状态并尝试重新加载
        this.isPlaying = false;
        settingStore.syncPreventSleep(false);
        try {
          await this.playTrack(this.currentTrackId);
        } catch {
          // playTrack 也失败则放弃
        }
      } finally {
        this.isResuming = false;
      }
    },

    notifySeekStart() {
      this.isDraggingProgress = true;
    },

    notifySeekEnd() {
      this.isDraggingProgress = false;
    },

    setVolume(value: number) {
      this.volume = engine.setVolume(value);
      logger.debug('PlayerStore', 'Volume updated', {
        requested: value,
        applied: this.volume,
      });
    },

    async setVolumeSmooth(value: number, durationMs?: number) {
      await this.fadeVolume(value, { durationMs, respectUserVolume: false });
    },

    setPlaybackRate(rate: number) {
      this.playbackRate = engine.setPlaybackRate(rate);
      logger.info('PlayerStore', 'Playback rate updated', {
        rate: this.playbackRate,
      });
      engine.updateMediaPlaybackState(
        buildMediaState({
          isPlaying: this.isPlaying,
          duration: this.duration,
          currentTime: this.currentTime,
          playbackRate: this.playbackRate,
        }),
      );
    },

    seek(time: number) {
      // 用 mpv 报告的实际时长做 clamp，比 store 的 duration（可能来自元数据）更准确
      const effectiveDuration = engine.duration > 0 ? engine.duration : this.duration;
      const targetTime = Math.max(0, Math.min(effectiveDuration, time));
      logger.info('PlayerStore', 'Seek requested', {
        currentTrackId: this.currentTrackId,
        from: this.currentTime,
        to: targetTime,
        duration: this.duration,
        engineDuration: engine.duration,
      });
      if (this.isDraggingProgress) {
        this.isDraggingProgress = false;
      }
      this.seekTargetTime = targetTime;
      this.seekTimestamp = Date.now();
      engine.seek(targetTime);
      this.currentTime = targetTime;
      this.recentSeekIgnoreEnd = true;
      window.setTimeout(() => {
        this.recentSeekIgnoreEnd = false;
      }, 800);
      engine.updateMediaPlaybackState(
        buildMediaState({
          isPlaying: this.isPlaying,
          duration: this.duration,
          currentTime: targetTime,
          playbackRate: this.playbackRate,
        }),
      );
    },

    setPlayMode(mode: PlayMode) {
      this.playMode = mode;
      // 切换模式时重置随机队列
      this.shuffleQueue = null;
      this.shuffleQueueLength = 0;
      this.shufflePlayed = new Set();
      // 同步 mpv 文件循环：单曲循环由 mpv 内部处理，不依赖 end-file 事件
      engine.setLoopFile(mode === 'single');
      logger.info('PlayerStore', 'Play mode updated', {
        mode,
      });
      engine.updateMediaPlaybackState(
        buildMediaState({
          isPlaying: this.isPlaying,
          duration: this.duration,
          currentTime: this.currentTime,
          playbackRate: this.playbackRate,
        }),
      );
    },

    setVolumeNormalization(enabled: boolean) {
      engine.setVolumeNormalization(enabled);
      logger.info('PlayerStore', 'Volume normalization updated', { enabled });
    },

    setReferenceLufs(lufs: number) {
      engine.setReferenceLufs(lufs);
      logger.info('PlayerStore', 'Reference LUFS updated', { lufs });
    },

    setEq(gains: number[]) {
      const clampedGains = gains.map((g) => clampNumber(g, -12, 12));
      this.equalizerGains = clampedGains;
      engine.setEqualizer(clampedGains);
      logger.info('PlayerStore', 'Equalizer updated', { gains: clampedGains });
    },

    async playTrack(
      id: string,
      playlist?: Song[],
      options?: {
        preserveFailureChain?: boolean;
        autoPlay?: boolean;
        sourceQueueId?: string | null;
      },
    ) {
      const playlistStore = usePlaylistStore();
      const lyricStore = useLyricStore();
      const settingStore = useSettingStore();
      const requestSeq = ++this.playbackRequestSeq;
      const sourceList = playlist ?? playlistStore.activeQueue?.songs ?? playlistStore.defaultList;
      logger.info('PlayerStore', 'Play track requested', {
        requestedTrackId: String(id),
        sourceListLength: sourceList.length,
        currentTrackId: this.currentTrackId,
        isPlaying: this.isPlaying,
      });
      const resolvedId = String(id);
      this.clearAutoNextTimer();
      if (!options?.preserveFailureChain) {
        this.autoNextAttempts = 0;
        this.autoNextSourceTrackId = null;
      }
      const track =
        sourceList.find((s) => String(s.id) === resolvedId) ||
        playlistStore.favorites.find((s) => String(s.id) === resolvedId);

      if (!track) {
        logger.warn('PlayerStore', 'Requested track not found in available lists', {
          requestedTrackId: resolvedId,
          sourceListLength: sourceList.length,
        });
        return;
      }

      logger.info('PlayerStore', 'Resolved track for playback', summarizeSong(track));

      if (!isPlayableSong(track)) {
        logger.warn('PlayerStore', 'Track not playable:', track);
        this.lastError = 'track-not-playable';
        this.currentTrackSnapshot = track;
        this.currentTrackId = resolvedId;
        this.currentPlaylist = sourceList;
        this.showPlaybackNotice('track-not-playable', track);
        this.applyFailedPlaybackState();
        this.clearAutoNextTimer();
        if (settingStore.autoNext && sourceList.length > 0) {
          this.autoNextSourceTrackId = resolvedId;
          this.scheduleAutoNext();
        }
        return;
      }

      const autoPlay = options?.autoPlay ?? true;
      const wasPlaying = autoPlay ? this.isPlaying : false;

      // 淡出不阻塞 UI，在后台线程执行
      // 注意：需要先重置引擎，淡出会继续在后台进行
      if (wasPlaying && settingStore.volumeFade) {
        const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
        // 非阻塞调用，不等待淡出完成
        void engine.pause({ fadeOut: true, fadeDurationMs: fadeMs });
      }

      if (requestSeq !== this.playbackRequestSeq) {
        logger.info('PlayerStore', 'Ignore stale playTrack before switching target', {
          requestSeq,
          latestRequestSeq: this.playbackRequestSeq,
          track: summarizeSong(track),
        });
        return;
      }

      engine.reset();
      engine.setPlaybackRate(this.playbackRate);

      this.currentTrackId = resolvedId;
      this.currentSourceQueueId =
        options?.sourceQueueId ??
        playlistStore.activeQueue?.id ??
        playlistStore.activeQueueId ??
        null;
      this.currentTrackSnapshot = track;
      this.resetHistoryUploadState(track);
      this.currentPlaylist = sourceList;
      playlistStore.updateQueueCurrentTrack(resolvedId);
      this.currentAudioUrl = '';
      this.currentResolvedAudioQuality = null;
      this.currentResolvedAudioEffect = 'none';
      this.currentTime = 0;
      this.duration = 0;
      this.isPlaying = false;
      this.isLoading = true;
      this.lastError = null;
      this.clearPlaybackNotice();
      this.climaxMarks = [];

      playlistStore.consumeQueuedNextTrackId(id);
      playlistStore.syncQueuedNextTrackIds();

      const lyricHash = String(track.hash ?? track.id ?? '');
      if (track.lyric) {
        lyricStore.setLyric(track.lyric, lyricHash);
      } else {
        lyricStore.clear(lyricHash, '歌词加载中...');
      }
      if (lyricHash) {
        void lyricStore.fetchLyrics(lyricHash, {
          preserveCurrent: Boolean(track.lyric),
        });
      } else if (!track.lyric) {
        lyricStore.clear('', '暂无歌词');
      }

      const pendingMediaMeta = buildMediaMeta(track);
      if (pendingMediaMeta) {
        engine.updateMediaMetadata({
          ...pendingMediaMeta,
          durationMs: (track.duration || 0) * 1000,
        });
      }
      engine.updateMediaPlaybackState(
        buildStoppedPlaybackState({
          playbackRate: this.playbackRate,
        }),
      );

      logger.info('PlayerStore', 'Resolving audio url for track', {
        track: summarizeSong(track),
        defaultAudioQuality: settingStore.defaultAudioQuality,
        audioEffect: this.audioEffect,
        compatibilityMode: settingStore.compatibilityMode,
      });
      const resolved = await this.resolveAudioUrl(track);
      if (requestSeq !== this.playbackRequestSeq) {
        logger.info('PlayerStore', 'Ignore stale playTrack result', {
          requestSeq,
          latestRequestSeq: this.playbackRequestSeq,
          track: summarizeSong(track),
        });
        return;
      }
      if (!resolved.url) {
        logger.error('PlayerStore', 'Resolve audio url failed', {
          track: summarizeSong(track),
          autoNext: settingStore.autoNext,
        });
        this.lastError = 'audio-url-unavailable';
        this.currentTrackSnapshot = track;
        this.currentTrackId = resolvedId;
        this.currentPlaylist = sourceList;
        this.showPlaybackNotice('audio-url-unavailable', track);
        this.applyFailedPlaybackState();
        if (settingStore.autoNext && sourceList.length > 0) {
          this.autoNextSourceTrackId = resolvedId;
          this.scheduleAutoNext();
        }
        return;
      }

      this.currentAudioQualityOverride = null;
      this.currentAudioUrl = resolved.url;
      this.currentResolvedAudioQuality = resolved.quality;
      this.currentResolvedAudioEffect = resolved.effect;
      track.audioUrl = resolved.url;

      logger.info('PlayerStore', 'Binding resolved source to engine', {
        track: summarizeSong(track),
        audioUrlLength: resolved.url.length,
        resolvedQuality: resolved.quality,
        resolvedEffect: resolved.effect,
      });
      engine.setSource(resolved.url);
      engine.applyTrackLoudness(resolved.loudness);
      // 同步文件循环模式
      engine.setLoopFile(this.playMode === 'single');

      try {
        if (autoPlay) {
          if (settingStore.volumeFade) {
            const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 500, 3000);
            await engine.play({ fadeIn: true, fadeDurationMs: fadeMs });
          } else {
            await engine.play();
          }
        }
        if (requestSeq !== this.playbackRequestSeq) {
          logger.info('PlayerStore', 'Ignore stale playTrack after engine.play', {
            requestSeq,
            latestRequestSeq: this.playbackRequestSeq,
            track: summarizeSong(track),
          });
          return;
        }
        logger.info('PlayerStore', 'Play track succeeded', {
          track: summarizeSong(track),
          wasPlaying,
          autoPlay,
          playlistLength: sourceList.length,
        });
        this.isLoading = false;
        this.autoNextAttempts = 0;
        this.autoNextSourceTrackId = String(track.id);
        this.clearAutoNextTimer();
        // mpv 未推送 duration 时用 track 元数据兜底（流式音频场景）
        if (!this.duration && !engine.duration && track.duration) {
          this.duration = track.duration;
        }
        // 非淡入模式才直接设音量（淡入时由 engine 内部处理）
        if (!autoPlay || !settingStore.volumeFade) {
          engine.setVolume(this.volume);
        }
        if (!autoPlay) {
          this.isPlaying = false;
          engine.updateMediaPlaybackState(
            buildStoppedPlaybackState({
              playbackRate: this.playbackRate,
            }),
          );
        } else if (!this.isPlaying) {
          // mpv 的 state-change 事件可能因 IPC 延迟未到达，强制同步状态
          this.isPlaying = true;
          settingStore.syncPreventSleep(true);
        }
        void this.fetchClimaxMarks(track);
        if (this.pendingSettingRefresh) {
          this.pendingSettingRefresh = false;
          void this.refreshCurrentTrack();
        }
      } catch (error) {
        logger.error('PlayerStore', 'Play track failed:', error);
        if (requestSeq !== this.playbackRequestSeq) {
          logger.info('PlayerStore', 'Ignore stale playTrack error', {
            requestSeq,
            latestRequestSeq: this.playbackRequestSeq,
            track: summarizeSong(track),
          });
          return;
        }
        this.lastError = 'playback-failed';
        this.showPlaybackNotice('playback-failed', track);
        settingStore.syncPreventSleep(false);
        this.applyFailedPlaybackState({ keepResolvedSource: true });

        if (settingStore.volumeFade) {
          engine.setVolume(this.volume);
        }

        if (settingStore.autoNext && sourceList.length > 0) {
          this.autoNextSourceTrackId = resolvedId;
          this.scheduleAutoNext();
        }

        if (this.pendingSettingRefresh) {
          this.pendingSettingRefresh = false;
          void this.refreshCurrentTrack();
        }
      }
    },

    getEffectiveAudioQuality(settingStore = useSettingStore()): AudioQualityValue {
      return normalizeQuality(this.currentAudioQualityOverride ?? settingStore.defaultAudioQuality);
    },

    getResolvedAudioQuality(
      track: Pick<Song, 'relateGoods'>,
      settingStore = useSettingStore(),
    ): AudioQualityValue {
      return resolveEffectiveSongQuality(
        track,
        this.getEffectiveAudioQuality(settingStore),
        settingStore.compatibilityMode ?? true,
      );
    },

    async ensureTrackRelateGoods(
      track: Song,
      options?: { forceRefresh?: boolean },
    ): Promise<SongRelateGood[]> {
      const existing = track.relateGoods ?? [];
      if (existing.length > 0 && !options?.forceRefresh) return existing;
      if (!track.hash || track.source === 'cloud') return existing;

      const requestKey = `${track.hash}:${track.albumId ?? ''}`;
      const pending = privilegeLiteRequests.get(requestKey);
      if (pending) return pending;

      logger.info(
        'PlayerStore',
        options?.forceRefresh
          ? 'Refreshing privilege lite for track before playback'
          : 'Preloading privilege lite for track',
        summarizeSong(track),
      );
      const request = (async () => {
        try {
          const privilegeRes = await getSongPrivilegeLite(track.hash, track.albumId);
          const relateGoods = parseRelateGoodsFromPrivilege(privilegeRes);
          track.relateGoods = relateGoods;
          logger.info('PlayerStore', 'Preloaded privilege lite relateGoods', {
            track: summarizeSong(track),
            count: relateGoods.length,
            qualities: relateGoods.map((item) => item.quality ?? item.level ?? 'unknown'),
          });
          return relateGoods;
        } catch (error) {
          logger.warn('PlayerStore', 'Preload privilege lite failed:', error, summarizeSong(track));
          return existing;
        } finally {
          privilegeLiteRequests.delete(requestKey);
        }
      })();

      privilegeLiteRequests.set(requestKey, request);
      return request;
    },

    setAudioEffect(effect: AudioEffectValue) {
      const nextEffect = normalizeEffect(effect);
      if (this.audioEffect === nextEffect) return;
      this.audioEffect = nextEffect;
      logger.info('PlayerStore', 'Current audio effect updated', {
        audioEffect: this.audioEffect,
      });
      if (!this.currentTrackId) return;
      if (this.isLoading || this.pendingSettingRefresh) {
        this.pendingSettingRefresh = true;
        return;
      }
      void this.refreshCurrentTrack();
    },

    setCurrentAudioQualityOverride(
      quality: AudioQualityValue | null,
      options?: { refresh?: boolean },
    ) {
      const nextQuality = quality ? normalizeQuality(quality) : null;
      if (this.currentAudioQualityOverride === nextQuality) return;
      this.currentAudioQualityOverride = nextQuality;
      logger.info('PlayerStore', 'Current track audio quality override updated', {
        override: this.currentAudioQualityOverride,
        effectiveAudioQuality: this.getEffectiveAudioQuality(),
        refresh: options?.refresh ?? true,
      });
      if (options?.refresh === false) return;
      if (!this.currentTrackId) return;
      if (this.isLoading || this.pendingSettingRefresh) {
        this.pendingSettingRefresh = true;
        return;
      }
      void this.refreshCurrentTrack();
    },

    resetCurrentAudioQualityOverride() {
      this.setCurrentAudioQualityOverride(null, { refresh: false });
    },

    stop() {
      const playlistStore = usePlaylistStore();
      logger.info('PlayerStore', 'Stopping playback and resetting player state', {
        currentTrackId: this.currentTrackId,
        currentTime: this.currentTime,
      });
      this.clearAutoNextTimer();
      this.autoNextAttempts = 0;
      this.autoNextSourceTrackId = null;
      this.currentTrackSnapshot = null;
      this.historyUploadCommitted = false;
      this.historyUploadTrackId = null;
      this.historyUploadPlayCount = 0;
      engine.reset();
      this.currentTime = 0;
      this.duration = 0;
      this.isPlaying = false;
      this.currentTrackId = null;
      this.currentSourceQueueId = null;
      this.currentAudioUrl = '';
      this.currentResolvedAudioQuality = null;
      this.currentResolvedAudioEffect = 'none';
      this.currentAudioQualityOverride = null;
      this.audioEffect = 'none';
      this.playbackRequestSeq += 1;
      this.climaxRequestSeq += 1;
      this.isLoading = false;
      this.unregisterOutputDeviceWatcher();
      playlistStore.updateQueueCurrentTrack(null);
      useLyricStore().clear('', '暂无歌词');
      engine.updateMediaPlaybackState(
        buildMediaState({
          isPlaying: false,
          duration: 0,
          currentTime: 0,
          playbackRate: this.playbackRate,
        }),
      );
    },

    async next() {
      const playlistStore = usePlaylistStore();
      playlistStore.syncQueuedNextTrackIds();
      logger.info('PlayerStore', 'Skip to next requested', {
        currentTrackId: this.currentTrackId,
        playMode: this.playMode,
      });
      const list =
        (playlistStore.activeQueue?.songs?.length ?? 0) > 0
          ? (playlistStore.activeQueue?.songs ?? [])
          : (this.currentPlaylist ?? []);
      if (list.length === 0) return;

      this.clearAutoNextTimer();

      const queuedNextId = playlistStore.peekQueuedNextTrackId();
      if (queuedNextId) {
        logger.info('PlayerStore', 'Found queued next track', {
          queuedNextId,
        });
        const queuedSong = list.find((song) => String(song.id) === queuedNextId);
        if (queuedSong && isPlayableSong(queuedSong)) {
          playlistStore.consumeQueuedNextTrackId(queuedNextId);
          void this.playTrack(String(queuedSong.id), list, {
            sourceQueueId: this.currentSourceQueueId,
          });
          return;
        }
        playlistStore.consumeQueuedNextTrackId(queuedNextId);
      }

      let nextIndex = 0;
      const currentIndex = list.findIndex((s) => String(s.id) === String(this.currentTrackId));

      if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
        void playlistStore.ensurePersonalFmQueue({
          track:
            list[currentIndex] ??
            findTrackById(this.currentTrackId, this.currentPlaylist, playlistStore) ??
            this.currentTrackSnapshot,
          playtime: this.currentTime,
          isOverplay:
            this.duration > 0 ? this.currentTime >= Math.max(0, this.duration - 2) : false,
        });
        const fmNextSong =
          currentIndex >= 0 && currentIndex < list.length - 1
            ? list[currentIndex + 1]
            : await playlistStore.consumeNextPersonalFmTrack({
                track:
                  list[currentIndex] ??
                  findTrackById(this.currentTrackId, this.currentPlaylist, playlistStore) ??
                  this.currentTrackSnapshot,
                playtime: this.currentTime,
                isOverplay:
                  this.duration > 0 ? this.currentTime >= Math.max(0, this.duration - 2) : false,
              });
        if (fmNextSong) {
          const fmList = playlistStore.activeQueue?.songs ?? list;
          await this.playTrack(String(fmNextSong.id), fmList, {
            sourceQueueId: PERSONAL_FM_QUEUE_ID,
          });
        }
        return;
      }

      if (this.playMode === 'random') {
        nextIndex = this.pickRandomIndex(list.length, currentIndex);
      } else if (this.playMode === 'sequential') {
        // 顺序播放：到末尾就停止
        if (currentIndex >= list.length - 1) {
          logger.info('PlayerStore', 'Sequential mode reached end of list, stopping playback');
          this.isPlaying = false;
          engine.pause();
          return;
        }
        nextIndex = currentIndex + 1;
      } else {
        nextIndex = (currentIndex + 1) % list.length;
      }

      if (this.playMode !== 'random') {
        nextIndex = findPlayableIndex(list, nextIndex, true, true);
      } else if (!isPlayableSong(list[nextIndex])) {
        nextIndex = findPlayableIndex(list, nextIndex, true, false);
      }

      // 顺序播放模式下，如果找到的可播放歌曲索引回绕到了当前歌曲之前，说明已到末尾
      if (this.playMode === 'sequential' && nextIndex <= currentIndex) {
        logger.info(
          'PlayerStore',
          'Sequential mode: no more playable tracks after current, stopping',
        );
        this.isPlaying = false;
        engine.pause();
        return;
      }

      const nextSong = list[nextIndex];
      if (!nextSong) {
        logger.warn('PlayerStore', 'No playable next track found', {
          listLength: list.length,
          currentTrackId: this.currentTrackId,
        });
        return;
      }
      logger.info('PlayerStore', 'Next track resolved', {
        nextIndex,
        track: summarizeSong(nextSong),
      });
      await this.playTrack(String(nextSong.id), list, {
        sourceQueueId: this.currentSourceQueueId,
      });
    },

    prev() {
      const playlistStore = usePlaylistStore();
      const list =
        (playlistStore.activeQueue?.songs?.length ?? 0) > 0
          ? (playlistStore.activeQueue?.songs ?? [])
          : (this.currentPlaylist ?? []);
      logger.info('PlayerStore', 'Skip to previous requested', {
        currentTrackId: this.currentTrackId,
        playMode: this.playMode,
      });
      if (list.length === 0) return;

      const currentIndex = list.findIndex((s) => String(s.id) === String(this.currentTrackId));
      let prevIndex = (currentIndex - 1 + list.length) % list.length;

      prevIndex = findPlayableIndex(list, prevIndex, false, true);
      const prevSong = list[prevIndex];
      if (!prevSong) {
        logger.warn('PlayerStore', 'No playable previous track found', {
          listLength: list.length,
          currentTrackId: this.currentTrackId,
        });
        return;
      }
      logger.info('PlayerStore', 'Previous track resolved', {
        prevIndex,
        track: summarizeSong(prevSong),
      });
      this.clearAutoNextTimer();
      void this.playTrack(prevSong.id, list, {
        sourceQueueId: this.currentSourceQueueId,
      });
    },

    registerOutputDeviceWatcher(settingStore: ReturnType<typeof useSettingStore>) {
      if (this.outputDeviceWatcherRegistered) return;
      this.outputDeviceWatcherRegistered = true;

      if (!window.electron?.mpv?.onAudioDeviceListChanged) {
        logger.info(
          'PlayerStore',
          'Output device watcher unavailable: electron.mpv.onAudioDeviceListChanged not supported',
        );
        return;
      }

      logger.info('PlayerStore', 'Output device watcher registered (via mpv)');
      outputDeviceChangeHandler = () => {
        logger.info('PlayerStore', 'Detected mpv audio device list change, scheduling refresh');
        this.clearOutputDeviceRefreshTimer();
        this.outputDeviceRefreshTimer = window.setTimeout(() => {
          this.outputDeviceRefreshTimer = null;
          void this.refreshOutputDevices(undefined, settingStore);
        }, 800);
      };
      window.electron.mpv.onAudioDeviceListChanged(outputDeviceChangeHandler);
    },

    async refreshOutputDevices(
      mpvDevicesArg?: Array<{ name: string; description: string }>,
      settingStoreArg?: ReturnType<typeof useSettingStore>,
    ) {
      const settingStore = settingStoreArg ?? useSettingStore();
      const fallbackOptions = [{ label: '系统默认', value: 'default' }];
      try {
        let mpvDevices: Array<{ name: string; description: string }>;

        if (mpvDevicesArg) {
          mpvDevices = mpvDevicesArg;
        } else {
          logger.info('PlayerStore', 'Refreshing output devices from mpv');
          try {
            mpvDevices = (await window.electron?.mpv?.getAudioDevices()) ?? [];
          } catch {
            mpvDevices = [];
          }
        }

        if (!Array.isArray(mpvDevices) || mpvDevices.length === 0) {
          logger.warn('PlayerStore', 'mpv returned no audio devices');
          settingStore.outputDevices = fallbackOptions;
          settingStore.setOutputDeviceStatus('ready', '当前仅检测到系统默认输出设备。');
          return;
        }

        // mpv 设备格式：{ name: "wasapi/{GUID}", description: "扬声器 (Realtek)" }
        // auto 是 mpv 的默认设备，映射为 default
        const outputOptions = mpvDevices
          .filter(
            (d: { name: string; description: string }) =>
              d.name && d.name !== 'auto' && d.name !== 'null',
          )
          .map((d: { name: string; description: string }) => ({
            label: d.description || d.name,
            value: d.name,
          }))
          .filter(
            (
              item: { label: string; value: string },
              index: number,
              arr: { label: string; value: string }[],
            ) => arr.findIndex((other) => other.label === item.label) === index,
          );

        settingStore.outputDevices = [...fallbackOptions, ...outputOptions];

        logger.info('PlayerStore', 'mpv audio devices enumerated', {
          count: outputOptions.length,
          devices: outputOptions.map((d: { label: string; value: string }) => ({
            label: d.label,
            value: d.value,
          })),
        });

        if (outputOptions.length === 0) {
          settingStore.setOutputDeviceStatus('ready', '当前仅检测到系统默认输出设备。');
        } else {
          settingStore.setOutputDeviceStatus('ready', '已检测到可用输出设备。');
        }

        const currentOutput = settingStore.outputDevice;
        const hasCurrentDevice =
          currentOutput === 'default' ||
          outputOptions.some((item: { value: string }) => item.value === currentOutput);
        const shouldRestorePreferredOutput =
          currentOutput !== 'default' &&
          hasCurrentDevice &&
          this.appliedOutputDeviceId === 'default';

        if (!hasCurrentDevice) {
          const disconnectBehavior =
            settingStore.outputDeviceDisconnectBehavior as OutputDeviceDisconnectBehavior;
          const shouldPause = disconnectBehavior === 'pause' && this.isPlaying;
          logger.warn('PlayerStore', 'Current output device missing, fallback to default', {
            currentOutput,
            shouldPause,
            disconnectBehavior,
          });

          if (disconnectBehavior === 'fallback') {
            await this.applyOutputDevice('default', settingStore, { persistSelection: false });
            settingStore.setOutputDeviceStatus(
              'fallback',
              '所选输出设备已不可用，已临时切回系统默认输出，原选择会保留。',
            );
            return;
          }

          if (shouldPause) {
            engine.pause();
          }
          settingStore.setOutputDeviceStatus(
            'fallback',
            '所选输出设备已不可用，播放已暂停，请重新连接设备或手动切换输出。',
          );
          return;
        }

        await this.applyOutputDevice(currentOutput, settingStore);
        if (shouldRestorePreferredOutput) {
          const matched = settingStore.outputDevices.find((item) => item.value === currentOutput);
          settingStore.setOutputDeviceStatus(
            'ready',
            `已恢复到首选输出设备：${matched?.label || '所选输出设备'}。`,
          );
        }
      } catch (error) {
        logger.warn('PlayerStore', 'Refresh output devices failed:', error);
        settingStore.outputDevices = fallbackOptions;
        settingStore.setOutputDeviceStatus('error', '获取输出设备失败，请稍后重试。');
      }
    },

    async requestOutputDevicePermission(settingStore = useSettingStore()) {
      // mpv 直接获取系统设备列表，不需要浏览器权限
      await this.refreshOutputDevices(undefined, settingStore);
      return true;
    },

    async applyOutputDevice(
      deviceId: string,
      settingStore = useSettingStore(),
      options?: { persistSelection?: boolean },
    ) {
      const persistSelection = options?.persistSelection ?? true;
      const mpvDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
      const exclusive = settingStore.exclusiveAudioDevice;
      logger.info('PlayerStore', 'Applying output device', {
        requestedDeviceId: deviceId,
        mpvDevice,
        exclusive,
        persistSelection,
      });

      // 独占模式：只在状态真正变化时才 stop + 重设，避免设备刷新时打断播放
      const mpv = window.electron?.mpv;
      const exclusiveChanged = exclusive !== (this._lastAppliedExclusive ?? false);
      let applied = false;
      if (exclusiveChanged) {
        const wasPlaying = this.isPlaying;
        try {
          await mpv?.setExclusive(exclusive);
        } catch {
          // 旧版 mpv 可能不支持
        }
        this._lastAppliedExclusive = exclusive;

        applied = await engine.setOutputDevice(mpvDevice);
        if (applied) {
          this.appliedOutputDeviceId = deviceId;
        }

        // 独占切换后恢复播放：先清除 sourceUrl 让 setSource 能重新加载
        if (wasPlaying && this.currentTrackId && this.currentAudioUrl) {
          const savedUrl = this.currentAudioUrl;
          const savedTime = this.currentTime;
          engine.reset();
          engine.setSource(savedUrl);
          await engine.play();
          if (savedTime > 0) {
            engine.seek(savedTime);
          }
        }
      } else {
        applied = await engine.setOutputDevice(mpvDevice);
        if (applied) {
          this.appliedOutputDeviceId = deviceId;
        }
      }
      if (!applied && deviceId !== 'default') {
        logger.warn('PlayerStore', 'Apply output device failed, falling back to default', {
          requestedDeviceId: deviceId,
        });
        await engine.setOutputDevice('auto');
        this.appliedOutputDeviceId = 'default';
        if (persistSelection) {
          settingStore.outputDevice = 'default';
        }
        settingStore.setOutputDeviceStatus(
          'fallback',
          persistSelection
            ? '当前设备不支持切换到所选输出，已回退到系统默认输出。'
            : '当前设备不支持切换到所选输出，已临时回退到系统默认输出。',
        );
      } else if (!applied) {
        logger.warn('PlayerStore', 'Apply output device unsupported', {
          requestedDeviceId: deviceId,
        });
        settingStore.setOutputDeviceStatus(
          'unsupported',
          '当前系统暂不支持在应用内切换输出设备，请使用系统声音设置切换。',
        );
      } else if (deviceId === 'default') {
        logger.info('PlayerStore', 'Output device switched to system default');
        settingStore.setOutputDeviceStatus(
          'ready',
          persistSelection ? '当前使用系统默认输出设备。' : '当前临时使用系统默认输出设备。',
        );
      } else {
        const matched = settingStore.outputDevices.find((item) => item.value === deviceId);
        const deviceLabel = matched?.label || deviceId;
        logger.info('PlayerStore', 'Output device switched successfully', {
          requestedDeviceId: deviceId,
          label: deviceLabel,
          exclusive,
        });
        settingStore.setOutputDeviceStatus('ready', `已切换到 ${deviceLabel}。`);
      }
    },

    /**
     * 如果音效是人声/伴奏且 URL 指向 MKV 文件，通过自定义协议提取对应音轨。
     * 否则原样返回 URL。
     */
    async resolveVocalExtractUrl(
      url: string,
      effect: AudioEffectValue,
      hash: string,
    ): Promise<string> {
      if (effect !== 'vocal' && effect !== 'accompaniment') return url;
      if (!url.toLowerCase().includes('.mkv')) return url;

      // 人声=音轨2，伴奏=音轨1
      const trackNum = effect === 'vocal' ? 2 : 1;

      const proxyUrl = `mpv-mkv://track=${trackNum}&url=${encodeURIComponent(url)}`;
      logger.info('PlayerStore', 'Resolved MKV extract url', { effect, trackNum, hash });
      return proxyUrl;
    },

    async resolveAudioUrl(
      track: Song,
      options?: { forceReload?: boolean },
    ): Promise<ResolvedAudioSource> {
      if (!track.hash) {
        logger.warn(
          'PlayerStore',
          'Resolve audio url skipped because track hash is missing',
          summarizeSong(track),
        );
        return { url: '', quality: null, effect: 'none', loudness: null };
      }
      const canReuseCurrentSource =
        !!track.audioUrl &&
        !options?.forceReload &&
        !!this.currentTrackId &&
        String(track.id) === String(this.currentTrackId) &&
        track.audioUrl === this.currentAudioUrl;

      if (canReuseCurrentSource) {
        logger.debug('PlayerStore', 'Reuse current audio url', {
          track: summarizeSong(track),
          forceReload: !!options?.forceReload,
          resolvedQuality: this.currentResolvedAudioQuality,
        });
        return {
          url: track.audioUrl!,
          quality: this.currentResolvedAudioQuality,
          effect: this.currentResolvedAudioEffect,
          loudness: null,
        };
      }

      const settingStore = useSettingStore();
      const audioQuality = this.getEffectiveAudioQuality(settingStore);
      const audioEffect = normalizeEffect(this.audioEffect);
      const compatibilityMode = settingStore.compatibilityMode ?? true;

      if (track.source === 'cloud') {
        logger.info('PlayerStore', 'Resolving cloud track audio url', summarizeSong(track));
        let cloudUrl: string | null = null;
        try {
          cloudUrl = await getCloudSongUrl(track.hash);
        } catch (error) {
          logger.error('PlayerStore', 'Fetch cloud track audio url error:', error);
        }

        if (cloudUrl) {
          logger.info(
            'PlayerStore',
            'Resolved cloud track audio url successfully',
            summarizeSong(track),
          );
        } else {
          logger.warn(
            'PlayerStore',
            'Resolved cloud track audio url is empty',
            summarizeSong(track),
          );
        }
        return { url: cloudUrl ?? '', quality: null, effect: 'none', loudness: null };
      }

      const relateGoods = await this.ensureTrackRelateGoods(track, { forceRefresh: true });

      if (audioEffect !== 'none') {
        // 人声/伴奏需要特殊处理：用 acappella 请求 MKV，再通过本地代理提取音轨
        const isVocalEffect = audioEffect === 'vocal' || audioEffect === 'accompaniment';
        const apiEffect = isVocalEffect ? 'acappella' : audioEffect;

        const matchedEffect = relateGoods.find((item) => item.quality === apiEffect && item.hash);
        const effectHashes = [matchedEffect?.hash, track.hash].filter(
          (value, index, list): value is string => !!value && list.indexOf(value) === index,
        );

        for (const effectHash of effectHashes) {
          try {
            logger.debug('PlayerStore', 'Trying effect audio url', {
              track: summarizeSong(track),
              audioEffect,
              apiEffect,
              hash: effectHash,
              source: effectHash === matchedEffect?.hash ? 'relateGoods' : 'track',
            });
            const effectRes = await getSongUrl(effectHash, apiEffect);
            let effectUrl = resolveUrlFromResponse(effectRes);
            if (effectUrl) {
              effectUrl = await this.resolveVocalExtractUrl(effectUrl, audioEffect, effectHash);
              logger.info('PlayerStore', 'Resolved effect audio url successfully', {
                track: summarizeSong(track),
                audioEffect,
                hash: effectHash,
              });
              return {
                url: effectUrl,
                quality: audioQuality,
                effect: audioEffect,
                loudness: resolveTrackLoudness(effectRes),
              };
            }
          } catch (error) {
            logger.warn('PlayerStore', 'Fetch effect url failed:', error, {
              track: summarizeSong(track),
              audioEffect,
              hash: effectHash,
            });
          }
        }
      }

      const candidates = getSongQualityCandidates(audioQuality, compatibilityMode);

      for (const quality of candidates) {
        const matched = relateGoods.find(
          (item) => doesRelateGoodMatchQuality(item, quality) && item.hash,
        );
        if (!matched?.hash) {
          logger.debug(
            'PlayerStore',
            'Skip quality candidate because relateGoods hash is missing',
            {
              track: summarizeSong(track),
              quality,
            },
          );
          continue;
        }
        try {
          logger.debug('PlayerStore', 'Trying quality audio url', {
            track: summarizeSong(track),
            quality,
            hash: matched.hash,
          });
          const res = await getSongUrl(matched.hash, quality);
          const url = resolveUrlFromResponse(res);
          if (url) {
            logger.info('PlayerStore', 'Resolved quality audio url successfully', {
              track: summarizeSong(track),
              quality,
            });
            return { url, quality, effect: 'none', loudness: resolveTrackLoudness(res) };
          }
        } catch (error) {
          logger.warn('PlayerStore', 'Fetch quality url failed:', error);
        }
      }

      if (compatibilityMode) {
        try {
          logger.debug(
            'PlayerStore',
            'Trying fallback audio url with original hash',
            summarizeSong(track),
          );
          const res = await getSongUrl(track.hash);
          const url = resolveUrlFromResponse(res);
          if (url) {
            logger.info(
              'PlayerStore',
              'Resolved fallback audio url successfully',
              summarizeSong(track),
            );
            return {
              url,
              quality: this.getResolvedAudioQuality(track, settingStore),
              effect: 'none',
              loudness: resolveTrackLoudness(res),
            };
          }
        } catch (error) {
          logger.warn('PlayerStore', 'Fetch fallback url failed:', error);
        }
      }

      // 带 ppage_id 再尝试一次，应该能获取到收藏的无版权歌曲地址
      try {
        logger.debug('PlayerStore', 'Trying fallback with ppage_id', summarizeSong(track));
        const res = await getSongUrl(track.hash, '', 356753938);
        const url = resolveUrlFromResponse(res);
        if (url) {
          logger.info(
            'PlayerStore',
            'Resolved fallback with ppage_id successfully',
            summarizeSong(track),
          );
          return {
            url,
            quality: this.getResolvedAudioQuality(track, settingStore),
            effect: 'none',
            loudness: resolveTrackLoudness(res),
          };
        }
      } catch (error) {
        logger.warn('PlayerStore', 'Fetch fallback with ppage_id failed:', error);
      }

      logger.error('PlayerStore', 'All audio url attempts failed', {
        track: summarizeSong(track),
        effectiveAudioQuality: audioQuality,
        audioEffect,
        compatibilityMode,
      });
      return { url: '', quality: null, effect: 'none', loudness: null };
    },

    async refreshCurrentTrack() {
      if (!this.currentTrackId) return;
      if (this.isLoading) {
        logger.info('PlayerStore', 'Refresh current track deferred because player is loading', {
          currentTrackId: this.currentTrackId,
        });
        this.pendingSettingRefresh = true;
        return;
      }
      const playlistStore = usePlaylistStore();
      const requestSeq = ++this.playbackRequestSeq;
      const track = findTrackById(this.currentTrackId, this.currentPlaylist, playlistStore);
      if (!track) {
        logger.warn('PlayerStore', 'Refresh current track failed because active track is missing', {
          currentTrackId: this.currentTrackId,
        });
        return;
      }

      logger.info('PlayerStore', 'Refreshing current track source', {
        track: summarizeSong(track),
        wasPlaying: this.isPlaying,
        currentTime: this.currentTime,
      });
      this.pendingSettingRefresh = false;

      const wasPlaying = this.isPlaying;
      const previousTime = this.currentTime;
      this.isLoading = true;

      const resolved = await this.resolveAudioUrl(track, { forceReload: true });
      if (requestSeq !== this.playbackRequestSeq) {
        logger.info('PlayerStore', 'Ignore stale refreshCurrentTrack result', {
          requestSeq,
          latestRequestSeq: this.playbackRequestSeq,
          track: summarizeSong(track),
        });
        return;
      }
      if (!resolved.url) {
        logger.error(
          'PlayerStore',
          'Refresh current track failed because resolved url is empty',
          summarizeSong(track),
        );
        this.isLoading = false;
        this.lastError = 'audio-url-unavailable';
        this.showPlaybackNotice('audio-url-unavailable', track);
        return;
      }

      engine.setVolume(this.volume);

      if (requestSeq !== this.playbackRequestSeq) {
        logger.info('PlayerStore', 'Ignore stale refreshCurrentTrack before apply source', {
          requestSeq,
          latestRequestSeq: this.playbackRequestSeq,
          track: summarizeSong(track),
        });
        return;
      }

      this.currentAudioUrl = resolved.url;
      this.currentResolvedAudioQuality = resolved.quality;
      this.currentResolvedAudioEffect = resolved.effect;
      track.audioUrl = resolved.url;
      const savedDuration = this.duration;
      engine.setSource(resolved.url);
      // mpv 推送的 duration 优先；savedDuration 仅在 mpv 尚未推送时临时填充，防止进度条闪烁
      if (!this.duration && !engine.duration && savedDuration) {
        this.duration = savedDuration;
      }
      engine.applyTrackLoudness(resolved.loudness);
      engine.setPlaybackRate(this.playbackRate);
      void this.fetchClimaxMarks(track);

      // 音效切换后新文件时长可能比原文件短，需要 clamp 防止 seek 越界触发 EOF
      if (previousTime > 0) {
        // 设置标志，防止 seek 越界时触发的 EOF 被误处理为正常播放结束
        this.recentSeekIgnoreEnd = true;
        window.setTimeout(() => {
          this.recentSeekIgnoreEnd = false;
        }, 1500);

        // 等待 mpv 推送新文件的 duration（轮询，最多等 500ms）
        let actualDuration = engine.duration;
        if (actualDuration <= 0) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => window.setTimeout(r, 50));
            actualDuration = engine.duration;
            if (actualDuration > 0) break;
          }
        }

        // clamp：如果新文件时长已知且 previousTime 超出，回到开头
        let safeTime = previousTime;
        if (actualDuration > 0 && previousTime >= actualDuration - 0.5) {
          logger.warn('PlayerStore', 'Seek position exceeds new source duration, reset to 0', {
            previousTime,
            actualDuration,
            track: summarizeSong(track),
          });
          safeTime = 0;
        }

        engine.seek(safeTime);
        this.currentTime = safeTime;
      }

      if (wasPlaying) {
        try {
          await engine.play();
          if (requestSeq !== this.playbackRequestSeq) {
            logger.info('PlayerStore', 'Ignore stale refreshCurrentTrack after engine.play', {
              requestSeq,
              latestRequestSeq: this.playbackRequestSeq,
              track: summarizeSong(track),
            });
            return;
          }
          logger.info('PlayerStore', 'Refresh current track replay succeeded', {
            track: summarizeSong(track),
            restoredTime: previousTime,
          });
        } catch (error) {
          logger.error('PlayerStore', 'Reload track failed:', error);
        }
      }

      // mpv 未推送 duration 时用 track 元数据兜底（流式音频场景）
      if (!this.duration && !engine.duration && track.duration) {
        this.duration = track.duration;
      }

      if (wasPlaying) {
        engine.setVolume(this.volume);
      }

      this.isLoading = false;

      if (this.pendingSettingRefresh) {
        this.pendingSettingRefresh = false;
        void this.refreshCurrentTrack();
      }
    },

    handlePlaybackEnded() {
      logger.info('PlayerStore', 'Handling playback ended', {
        currentTrackId: this.currentTrackId,
        playMode: this.playMode,
      });
      // 上报听歌时长
      // const userStore = useUserStore();
      // if (userStore.isLoggedIn) {
      //   reportListenTime().catch(() => {});
      // }
      const playlistStore = usePlaylistStore();
      if (playlistStore.activeQueue?.id === PERSONAL_FM_QUEUE_ID) {
        const currentTrack =
          findTrackById(this.currentTrackId, this.currentPlaylist, playlistStore) ??
          this.currentTrackSnapshot;
        void playlistStore.ensurePersonalFmQueue({
          track: currentTrack,
          playtime: this.duration,
          isOverplay: true,
        });
      }
      if (this.playMode === 'single') {
        // 正常情况下 mpv 的 loop-file=inf 会自动循环，不触发 end-file
        // 这里作为兜底：如果意外收到 end-file，重新加载文件
        logger.info('PlayerStore', 'Single repeat mode active, replay current track');
        if (this.currentAudioUrl) {
          engine.setSource(this.currentAudioUrl);
          void engine.play();
        }
        return;
      }
      this.next();
    },

    async fetchClimaxMarks(track: Song) {
      if (!track.hash) {
        this.climaxMarks = [];
        return;
      }
      const requestSeq = ++this.climaxRequestSeq;
      logger.debug('PlayerStore', 'Fetching climax marks', summarizeSong(track));
      try {
        const res = await getSongClimax(track.hash);
        if (
          requestSeq !== this.climaxRequestSeq ||
          String(track.id) !== String(this.currentTrackId)
        ) {
          logger.debug('PlayerStore', 'Ignore stale climax marks result', {
            requestSeq,
            latestRequestSeq: this.climaxRequestSeq,
            track: summarizeSong(track),
            currentTrackId: this.currentTrackId,
          });
          return;
        }
        const data = res && typeof res === 'object' ? (res as { data?: unknown }).data : undefined;
        const list = Array.isArray(data) ? data : [];
        const marks: ClimaxMark[] = [];
        const duration = track.duration || this.duration || 0;
        if (!(duration > 0) || list.length === 0) {
          this.climaxMarks = [];
          return;
        }
        const total = duration;

        list.forEach((item) => {
          if (!item || typeof item !== 'object') return;
          const record = item as Record<string, unknown>;
          const startRaw = record.start_time ?? record.starttime ?? record.start;
          const endRaw = record.end_time ?? record.endtime ?? record.end;
          const startMs = Number(startRaw);
          const endMs = Number(endRaw);
          if (!Number.isFinite(startMs) || startMs <= 0 || startMs >= total * 1000) return;

          const start = startMs / 1000;
          const end =
            Number.isFinite(endMs) && endMs > startMs ? Math.min(total, endMs / 1000) : start;
          const normalizedStart = start / total;
          const normalizedEnd = end / total;

          if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return;
          if (normalizedStart <= 0 || normalizedStart >= 1) return;
          if (normalizedEnd <= 0) return;

          marks.push({
            start: normalizedStart,
            end: Math.min(1, Math.max(normalizedStart, normalizedEnd)),
          });
        });

        this.climaxMarks = marks
          .sort((a, b) => a.start - b.start)
          .filter(
            (mark, index, arr) =>
              index === 0 || Math.abs(mark.start - arr[index - 1].start) > 0.002,
          );
        logger.debug('PlayerStore', 'Fetched climax marks', {
          track: summarizeSong(track),
          count: marks.length,
        });
      } catch (error) {
        if (requestSeq === this.climaxRequestSeq) {
          this.climaxMarks = [];
        }
        logger.warn('PlayerStore', 'Fetch climax marks failed:', error);
      }
    },

    fadeVolume(
      target: number,
      options?: { durationMs?: number; respectUserVolume?: boolean },
    ): Promise<void> {
      const durationMs = Math.max(0, options?.durationMs ?? 1000);
      logger.debug('PlayerStore', 'Fade volume requested', {
        targetVolume: target,
        durationMs,
        respectUserVolume: options?.respectUserVolume ?? false,
      });
      const respectUserVolume = options?.respectUserVolume ?? false;
      const targetValue = respectUserVolume ? Math.min(target, this.volume) : target;
      return engine.fadeTo(targetValue, durationMs).then(() => {
        if (!respectUserVolume) {
          this.volume = engine.volume;
        }
      });
    },

    pickRandomIndex(length: number, currentIndex: number) {
      if (length <= 1) return currentIndex;

      // 标记当前歌曲为已播放
      this.shufflePlayed.add(currentIndex);

      if (!this.shuffleQueue || this.shuffleQueueLength !== length) {
        if (this.shuffleQueue && this.shuffleQueueLength !== length) {
          // 列表长度变化：保留剩余队列中仍有效的索引，追加新增索引
          const remaining = new Set(this.shuffleQueue.filter((i) => i < length));
          const newIndices: number[] = [];
          for (let i = 0; i < length; i++) {
            if (i !== currentIndex && !this.shufflePlayed.has(i) && !remaining.has(i)) {
              newIndices.push(i);
            }
          }
          // 清理已播放集合中超出范围的索引
          for (const idx of this.shufflePlayed) {
            if (idx >= length) this.shufflePlayed.delete(idx);
          }
          // 洗牌新增索引并追加到剩余队列末尾
          this.shuffleInsert(newIndices);
          const validRemaining = this.shuffleQueue.filter((i) => i < length && i !== currentIndex);
          this.shuffleQueue = [...validRemaining, ...newIndices];
        } else {
          // 首次构建
          this.shufflePlayed = new Set([currentIndex]);
          this.shuffleQueue = this.buildShuffleQueue(length, currentIndex);
        }
        this.shuffleQueueLength = length;
      }

      // 队列耗尽：所有歌曲都播放过，开始新一轮
      if (this.shuffleQueue.length === 0) {
        this.shufflePlayed = new Set([currentIndex]);
        this.shuffleQueue = this.buildShuffleQueue(length, currentIndex);
      }

      const nextIndex = this.shuffleQueue.shift()!;
      this.shufflePlayed.add(nextIndex);

      logger.debug('PlayerStore', 'Picking random next index (shuffle)', {
        length,
        currentIndex,
        nextIndex,
        remaining: this.shuffleQueue.length,
        played: this.shufflePlayed.size,
      });
      return nextIndex;
    },

    // 原地 Fisher-Yates 洗牌
    shuffleInsert(arr: number[]) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    },

    buildShuffleQueue(length: number, excludeIndex: number): number[] {
      const indices = Array.from({ length }, (_, i) => i).filter((i) => i !== excludeIndex);
      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      return indices;
    },
  },
  persist: {
    pick: [
      'volume',
      'playMode',
      'currentTrackId',
      'playbackRate',
      'audioEffect',
      'historyPlayCountMap',
    ],
  },
});
