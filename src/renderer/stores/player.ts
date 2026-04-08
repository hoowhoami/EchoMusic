import { defineStore } from 'pinia';
import { usePlaylistStore } from './playlist';
import { useLyricStore } from './lyric';
import { useSettingStore } from './setting';
import type { OutputDeviceDisconnectBehavior } from './setting';
import logger from '@/utils/logger';
import { getCloudSongUrl, getSongClimax, getSongPrivilegeLite, getSongUrl } from '@/api/music';
import { getServerNow, uploadPlayHistory } from '@/api/user';
import {
  PlayerEngine,
  type MediaSessionMeta,
  type MediaSessionState,
  type PlayerEngineEvents,
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

export type AudioQualityValue = '128' | '320' | 'flac' | 'high';
export type AudioEffectValue =
  | 'none'
  | 'piano'
  | 'acappella'
  | 'subwoofer'
  | 'ancient'
  | 'surnay'
  | 'dj'
  | 'viper_tape'
  | 'viper_atmos'
  | 'viper_clear';

const QUALITY_PRIORITY: AudioQualityValue[] = ['high', 'flac', '320', '128'];

const normalizeQuality = (value: string | undefined): AudioQualityValue => {
  if (value === '128' || value === '320' || value === 'flac' || value === 'high') return value;
  return 'high';
};

const normalizeEffect = (value: string | undefined): AudioEffectValue => {
  const options: AudioEffectValue[] = [
    'none',
    'piano',
    'acappella',
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

const buildAudioOutputDeviceSignature = (devices: MediaDeviceInfo[]): string | null => {
  const outputs = devices
    .filter((device) => device.kind === 'audiooutput')
    .map((device) => ({
      deviceId: device.deviceId || 'default',
      groupId: device.groupId || '',
      label: device.label || '',
    }))
    .sort((left, right) => {
      const leftKey = `${left.deviceId}|${left.groupId}|${left.label}`;
      const rightKey = `${right.deviceId}|${right.groupId}|${right.label}`;
      return leftKey.localeCompare(rightKey);
    });

  if (outputs.length === 0) return null;
  return outputs.map((device) => `${device.deviceId}|${device.groupId}|${device.label}`).join('::');
};

const findTrackById = (
  id: string | null,
  list: Song[] | null | undefined,
  playlistStore: ReturnType<typeof usePlaylistStore>,
): Song | undefined => {
  if (!id) return undefined;
  const targetId = String(id);
  const pool = [list ?? [], playlistStore.defaultList, playlistStore.favorites];
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
};

type ClimaxMark = { start: number; end: number };

export type PlaybackNotice = {
  code: string;
  title: string;
  reason: string;
  detail: string;
  trackId: string | null;
};

export type PlayMode = 'sequential' | 'list' | 'single' | 'random';

// 保持一个全局 PlayerEngine 实例
const engine = new PlayerEngine();

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
    volume: 0.8,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    playMode: 'list' as PlayMode,
    currentTrackId: null as string | null,
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
    lastAudioOutputDeviceSignature: null as string | null,
    outputDeviceRefreshTimer: null as number | null,
    appliedOutputDeviceId: 'default' as string,
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
  }),
  actions: {
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
        playlistStore.defaultList.length > 0
          ? playlistStore.defaultList
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
      const list =
        playlistStore.defaultList.length > 0
          ? playlistStore.defaultList
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

      return this.playTrack(String(nextSong.id), list, { preserveFailureChain: true });
    },

    init() {
      const lyricStore = useLyricStore();
      const settingStore = useSettingStore();
      logger.info('PlayerStore', 'Initializing player store', {
        volume: this.volume,
        playbackRate: this.playbackRate,
        playMode: this.playMode,
      });
      // 恢复持久化的音量与倍速
      engine.setVolume(this.volume);
      engine.setPlaybackRate(this.playbackRate);
      this.registerSettingWatchers(settingStore);
      this.registerOutputDeviceWatcher(settingStore);
      void this.refreshOutputDevices(settingStore);

      const events: PlayerEngineEvents = {
        timeUpdate: (currentTime) => {
          this.currentTime = currentTime;
          lyricStore.updateCurrentIndex(currentTime);
          this.maybeCommitListeningHistory();
          engine.updateMediaPlaybackState(
            buildMediaState({
              isPlaying: this.isPlaying,
              duration: this.duration,
              currentTime,
              playbackRate: this.playbackRate,
            }),
          );
        },
        durationChange: (duration) => {
          this.duration = duration;
          engine.updateMediaPlaybackState(
            buildMediaState({
              isPlaying: this.isPlaying,
              duration,
              currentTime: this.currentTime,
              playbackRate: this.playbackRate,
            }),
          );
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
        play: () => this.togglePlay(),
        pause: () => this.togglePlay(),
        previoustrack: () => this.prev(),
        nexttrack: () => this.next(),
        seekto: (time) => this.seek(time),
        seekbackward: (offset) => this.seek(Math.max(0, this.currentTime - offset)),
        seekforward: (offset) => this.seek(Math.min(this.duration, this.currentTime + offset)),
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
        const shouldUpdateOutputDevice = state.outputDevice !== snapshot.outputDevice;

        snapshot = {
          defaultAudioQuality: state.defaultAudioQuality,
          compatibilityMode: state.compatibilityMode,
          volumeFade: state.volumeFade,
          volumeFadeTime: state.volumeFadeTime,
          outputDevice: state.outputDevice,
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
      });
      if (!this.currentTrackId) {
        const playlist = usePlaylistStore();
        if (playlist.defaultList.length > 0) {
          logger.info('PlayerStore', 'No active track, playing first item from default list', {
            firstTrackId: playlist.defaultList[0]?.id,
            listLength: playlist.defaultList.length,
          });
          this.playTrack(playlist.defaultList[0].id);
        }
        return;
      }

      if (this.isPlaying) {
        engine.pause();
        return;
      }

      if (!engine.source) {
        logger.info('PlayerStore', 'No active audio source, replaying current track', {
          currentTrackId: this.currentTrackId,
        });
        await this.playTrack(this.currentTrackId);
        return;
      }

      try {
        await engine.play();
      } catch (error) {
        logger.error('PlayerStore', 'Playback failed:', error);
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
      const targetTime = Math.max(0, Math.min(this.duration, time));
      logger.info('PlayerStore', 'Seek requested', {
        currentTrackId: this.currentTrackId,
        from: this.currentTime,
        to: targetTime,
        duration: this.duration,
      });
      if (this.isDraggingProgress) {
        this.isDraggingProgress = false;
      }
      engine.seek(targetTime);
      this.currentTime = targetTime;
      this.recentSeekIgnoreEnd = true;
      window.setTimeout(() => {
        this.recentSeekIgnoreEnd = false;
      }, 800);
      useLyricStore().updateCurrentIndex(targetTime);
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

    async playTrack(
      id: string,
      playlist?: Song[],
      options?: { preserveFailureChain?: boolean; autoPlay?: boolean },
    ) {
      const playlistStore = usePlaylistStore();
      const lyricStore = useLyricStore();
      const settingStore = useSettingStore();
      const requestSeq = ++this.playbackRequestSeq;
      const sourceList = playlist ?? playlistStore.defaultList;
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

      if (wasPlaying && settingStore.volumeFade) {
        const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 120, 1000);
        const transitionFadeMs = Math.min(fadeMs, 220);
        await this.fadeVolume(0, { durationMs: transitionFadeMs, respectUserVolume: true });
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
      engine.setVolume(this.volume);
      engine.setPlaybackRate(this.playbackRate);

      this.currentTrackId = resolvedId;
      this.currentTrackSnapshot = track;
      this.resetHistoryUploadState(track);
      this.currentPlaylist = sourceList;
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
      if (pendingMediaMeta) engine.updateMediaMetadata(pendingMediaMeta);
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

      try {
        if (autoPlay) {
          await engine.play();
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
        if (autoPlay && settingStore.volumeFade) {
          this.fadeIn();
        } else {
          engine.setVolume(this.volume);
        }
        if (!autoPlay) {
          this.isPlaying = false;
          engine.updateMediaPlaybackState(
            buildStoppedPlaybackState({
              playbackRate: this.playbackRate,
            }),
          );
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
        } else {
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
      this.currentAudioUrl = '';
      this.currentResolvedAudioQuality = null;
      this.currentResolvedAudioEffect = 'none';
      this.currentAudioQualityOverride = null;
      this.audioEffect = 'none';
      this.playbackRequestSeq += 1;
      this.climaxRequestSeq += 1;
      this.isLoading = false;
      this.outputDeviceWatcherRegistered = false;
      playlistStore.queuedNextTrackIds = [];
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

    next() {
      const playlistStore = usePlaylistStore();
      playlistStore.syncQueuedNextTrackIds();
      logger.info('PlayerStore', 'Skip to next requested', {
        currentTrackId: this.currentTrackId,
        playMode: this.playMode,
      });
      const list =
        playlistStore.defaultList.length > 0
          ? playlistStore.defaultList
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
          void this.playTrack(String(queuedSong.id), list);
          return;
        }
        playlistStore.consumeQueuedNextTrackId(queuedNextId);
      }

      let nextIndex = 0;
      const currentIndex = list.findIndex((s) => String(s.id) === String(this.currentTrackId));

      if (this.playMode === 'random') {
        nextIndex = this.pickRandomIndex(list.length, currentIndex);
      } else if (this.playMode === 'single') {
        nextIndex = currentIndex;
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
      void this.playTrack(String(nextSong.id), list);
    },

    prev() {
      const playlistStore = usePlaylistStore();
      const list =
        playlistStore.defaultList.length > 0
          ? playlistStore.defaultList
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
      this.playTrack(prevSong.id, list);
    },

    registerOutputDeviceWatcher(settingStore: ReturnType<typeof useSettingStore>) {
      if (this.outputDeviceWatcherRegistered) return;
      this.outputDeviceWatcherRegistered = true;
      if (!navigator.mediaDevices?.addEventListener) {
        logger.info(
          'PlayerStore',
          'Output device watcher unavailable: mediaDevices.addEventListener not supported',
        );
        return;
      }

      logger.info('PlayerStore', 'Output device watcher registered');
      navigator.mediaDevices.addEventListener('devicechange', () => {
        logger.info(
          'PlayerStore',
          'Detected media device change, scheduling output device refresh',
        );
        this.clearOutputDeviceRefreshTimer();
        this.outputDeviceRefreshTimer = window.setTimeout(() => {
          this.outputDeviceRefreshTimer = null;
          void this.refreshOutputDevices(settingStore);
        }, 800);
      });
    },

    async refreshOutputDevices(settingStore: ReturnType<typeof useSettingStore>) {
      const fallbackOptions = [{ label: '系统默认', value: 'default' }];

      logger.info('PlayerStore', 'Refreshing output devices', {
        currentOutputDevice: settingStore.outputDevice,
        hasEnumerateDevices: typeof navigator.mediaDevices?.enumerateDevices === 'function',
        hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
      });

      if (!navigator.mediaDevices?.enumerateDevices) {
        logger.warn('PlayerStore', 'Output device enumeration unsupported in current environment');
        settingStore.outputDevices = fallbackOptions;
        settingStore.outputDeviceType = 'default';
        settingStore.setOutputDeviceStatus(
          'unsupported',
          '当前系统暂不支持在应用内切换输出设备，请使用系统声音设置切换。',
        );
        return;
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((device) => device.kind === 'audiooutput');
        const nextSignature = buildAudioOutputDeviceSignature(devices);
        const previousSignature = this.lastAudioOutputDeviceSignature;
        const hasDeviceSignatureChanged =
          previousSignature !== null &&
          nextSignature !== null &&
          nextSignature !== previousSignature;
        this.lastAudioOutputDeviceSignature = nextSignature;

        const outputOptions = outputs
          .filter((device) => device.deviceId && device.deviceId !== 'default')
          .map((device, index) => ({
            label: device.label || `输出设备 ${index + 1}`,
            value: device.deviceId,
          }));

        settingStore.outputDevices = [...fallbackOptions, ...outputOptions];

        logger.info('PlayerStore', 'Output devices enumerated', {
          totalDevices: devices.length,
          outputCount: outputs.length,
          options: outputOptions.map((device) => ({
            label: device.label,
            value: device.value,
          })),
        });

        const labelsMissing = outputs.length > 0 && outputs.every((device) => !device.label);
        if (labelsMissing) {
          settingStore.setOutputDeviceStatus(
            'permission',
            '系统未返回设备名称，可能需要授予媒体设备权限后才能显示完整列表。',
          );
        } else if (outputs.length <= 1) {
          settingStore.setOutputDeviceStatus('ready', '当前仅检测到系统默认输出设备。');
        } else {
          settingStore.setOutputDeviceStatus('ready', '已检测到可用输出设备。');
        }

        const currentOutput = settingStore.outputDevice;
        const hasCurrentDevice =
          currentOutput === 'default' || outputOptions.some((item) => item.value === currentOutput);
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
            previousSignature,
            nextSignature,
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
        settingStore.outputDeviceType = 'default';
        const errorName = error instanceof DOMException ? error.name : '';
        if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
          settingStore.setOutputDeviceStatus(
            'permission',
            '尚未获得音频设备权限，请先授权后再获取完整设备列表。',
          );
        } else {
          settingStore.setOutputDeviceStatus(
            'error',
            '获取输出设备失败，请检查系统音频权限或稍后重试。',
          );
        }
      }
    },

    async requestOutputDevicePermission(settingStore = useSettingStore()) {
      logger.info('PlayerStore', 'Requesting output device permission', {
        currentOutputDevice: settingStore.outputDevice,
        hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
      });

      if (!navigator.mediaDevices?.getUserMedia) {
        settingStore.setOutputDeviceStatus(
          'unsupported',
          '当前系统暂不支持在应用内请求音频设备权限，请使用系统声音设置切换输出设备。',
        );
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        logger.info('PlayerStore', 'Output device permission granted', {
          trackCount: stream.getTracks().length,
        });
        stream.getTracks().forEach((track) => track.stop());
        await this.refreshOutputDevices(settingStore);

        if (settingStore.outputDeviceStatus === 'permission') {
          settingStore.setOutputDeviceStatus(
            'permission',
            '已发起权限请求，但系统仍未返回完整设备信息，请确认系统已允许麦克风或媒体设备访问。',
          );
          return false;
        }

        return true;
      } catch (error) {
        logger.warn('PlayerStore', 'Request output device permission failed:', error);
        const errorName = error instanceof DOMException ? error.name : '';
        if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
          settingStore.setOutputDeviceStatus(
            'permission',
            '未获得音频设备权限，请在系统设置中允许麦克风或媒体设备访问后重试。',
          );
        } else if (errorName === 'NotFoundError') {
          settingStore.setOutputDeviceStatus('error', '未检测到可用音频设备，请连接设备后重试。');
        } else {
          settingStore.setOutputDeviceStatus('error', '请求音频设备权限失败，请稍后重试。');
        }
        return false;
      }
    },

    async applyOutputDevice(
      deviceId: string,
      settingStore = useSettingStore(),
      options?: { persistSelection?: boolean },
    ) {
      const targetDeviceId = deviceId;
      const persistSelection = options?.persistSelection ?? true;
      logger.info('PlayerStore', 'Applying output device', {
        requestedDeviceId: targetDeviceId,
        currentOutputDevice: settingStore.outputDevice,
        persistSelection,
      });
      const applied = await engine.setOutputDevice(targetDeviceId);
      if (applied) {
        this.appliedOutputDeviceId = targetDeviceId;
      }
      if (!applied && targetDeviceId !== 'default') {
        logger.warn('PlayerStore', 'Apply output device failed, falling back to default', {
          requestedDeviceId: targetDeviceId,
        });
        await engine.setOutputDevice('default');
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
        logger.warn('PlayerStore', 'Apply output device unsupported in current environment', {
          requestedDeviceId: targetDeviceId,
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
        logger.info('PlayerStore', 'Output device switched successfully', {
          requestedDeviceId: targetDeviceId,
          label: matched?.label || '所选输出设备',
        });
        settingStore.setOutputDeviceStatus(
          'ready',
          `已切换到 ${matched?.label || '所选输出设备'}。`,
        );
      }
      settingStore.outputDeviceType = 'default';
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
        return { url: '', quality: null, effect: 'none' };
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
        return { url: cloudUrl ?? '', quality: null, effect: 'none' };
      }

      const relateGoods = await this.ensureTrackRelateGoods(track, { forceRefresh: true });

      if (audioEffect !== 'none') {
        const matchedEffect = relateGoods.find((item) => item.quality === audioEffect && item.hash);
        const effectHashes = [matchedEffect?.hash, track.hash].filter(
          (value, index, list): value is string => !!value && list.indexOf(value) === index,
        );

        for (const effectHash of effectHashes) {
          try {
            logger.debug('PlayerStore', 'Trying effect audio url', {
              track: summarizeSong(track),
              audioEffect,
              hash: effectHash,
              source: effectHash === matchedEffect?.hash ? 'relateGoods' : 'track',
            });
            const effectRes = await getSongUrl(effectHash, audioEffect);
            const effectUrl = resolveUrlFromResponse(effectRes);
            if (effectUrl) {
              logger.info('PlayerStore', 'Resolved effect audio url successfully', {
                track: summarizeSong(track),
                audioEffect,
                hash: effectHash,
              });
              return { url: effectUrl, quality: audioQuality, effect: audioEffect };
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
            return { url, quality, effect: 'none' };
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
            };
          }
        } catch (error) {
          logger.warn('PlayerStore', 'Fetch fallback url failed:', error);
        }
      }

      logger.error('PlayerStore', 'All audio url attempts failed', {
        track: summarizeSong(track),
        effectiveAudioQuality: audioQuality,
        audioEffect,
        compatibilityMode,
      });
      return { url: '', quality: null, effect: 'none' };
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
      const settingStore = useSettingStore();
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
      engine.setSource(resolved.url);
      engine.setPlaybackRate(this.playbackRate);
      void this.fetchClimaxMarks(track);

      if (previousTime > 0) {
        engine.seek(previousTime);
        this.currentTime = previousTime;
        useLyricStore().updateCurrentIndex(previousTime);
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
      if (this.playMode === 'single') {
        logger.info('PlayerStore', 'Single repeat mode active, replay current track');
        this.seek(0);
        void engine.play();
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

    prepareFadeOut() {
      if (!this.isPlaying) return;
      const settingStore = useSettingStore();
      if (!settingStore.volumeFade) return;
      const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 120, 1000);
      logger.debug('PlayerStore', 'Prepare fade out before stop or switch', {
        currentTrackId: this.currentTrackId,
        durationMs: fadeMs,
      });
      void this.fadeVolume(0, { durationMs: fadeMs, respectUserVolume: true });
    },

    fadeIn() {
      const settingStore = useSettingStore();
      if (!settingStore.volumeFade) return;
      const fadeMs = clampNumber(settingStore.volumeFadeTime ?? 1000, 120, 1200);
      const transitionFadeMs = Math.min(fadeMs, 220);
      logger.debug('PlayerStore', 'Fade in playback volume', {
        targetVolume: this.volume,
        durationMs: transitionFadeMs,
      });
      void this.fadeVolume(this.volume, { durationMs: transitionFadeMs, respectUserVolume: false });
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

      // Lazily build or rebuild the shuffle queue when needed
      if (
        !this.shuffleQueue ||
        this.shuffleQueue.length === 0 ||
        this.shuffleQueueLength !== length
      ) {
        this.shuffleQueue = this.buildShuffleQueue(length, currentIndex);
        this.shuffleQueueLength = length;
      }

      const nextIndex = this.shuffleQueue.shift()!;
      logger.debug('PlayerStore', 'Picking random next index (shuffle)', {
        length,
        currentIndex,
        nextIndex,
        remaining: this.shuffleQueue.length,
      });
      return nextIndex;
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
