import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import {
  getUserPlaylists,
  getPlaylistTracks,
  addPlaylistTrack,
  deletePlaylistTrack,
  addPlaylist,
  deletePlaylist,
} from '@/api/playlist';
import { getPersonalFm, type PersonalFmParams } from '@/api/music';
import logger from '@/utils/logger';
import { mapPlaylistMeta, mapTopSong } from '@/utils/mappers';
import { parsePlaylistTracks } from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';
import { extractList } from '@/utils/extractors';
import { PagedSongLoader } from '@/utils/PagedSongLoader';

export type { Song, SongRelateGood, SongArtist } from '@/models/song';
export type { PlaylistInfo } from '@/models/playlist';
export type PlaybackQueueType =
  | 'default'
  | 'daily-recommend'
  | 'playlist'
  | 'ranking'
  | 'album'
  | 'artist'
  | 'search'
  | 'history'
  | 'cloud'
  | 'fm'
  | 'manual';
export type PersonalFmMode = 'normal' | 'small' | 'peak';

export interface PlaybackQueueMetaValueMap {
  [key: string]: string | number | boolean | null | undefined;
}

export interface PlaybackQueueState {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  type: PlaybackQueueType;
  songs: Song[];
  filteredInvalidCount: number;
  queuedNextTrackIds: string[];
  currentTrackId: string | null;
  createdAt: number;
  updatedAt: number;
  dynamic: boolean;
  meta: PlaybackQueueMetaValueMap;
}

export interface SetPlaybackQueueOptions {
  queueId?: string;
  title?: string;
  subtitle?: string;
  coverUrl?: string;
  type?: PlaybackQueueType;
  dynamic?: boolean;
  meta?: PlaybackQueueMetaValueMap;
  activate?: boolean;
}

export const DEFAULT_PLAYBACK_QUEUE_ID = 'queue:default';
export const MANUAL_PLAYBACK_QUEUE_ID = 'queue:manual';
export const PERSONAL_FM_QUEUE_ID = 'queue:personal-fm';
export type PersonalFmSongPoolId = 0 | 1 | 2;

export const getPersonalFmModePresentation = (mode?: PersonalFmMode | string) => {
  const resolvedMode: PersonalFmMode =
    mode === 'small' ? 'small' : mode === 'peak' ? 'peak' : 'normal';
  return {
    mode: resolvedMode,
    title:
      resolvedMode === 'small'
        ? '小众 Radio'
        : resolvedMode === 'peak'
          ? '速览 Radio'
          : '红心 Radio',
    subtitle:
      resolvedMode === 'small' ? '小众推荐' : resolvedMode === 'peak' ? '速览推荐' : '猜你喜欢',
    label:
      resolvedMode === 'small'
        ? '小众 Radio'
        : resolvedMode === 'peak'
          ? '速览 Radio'
          : '红心 Radio',
  };
};

export const getPersonalFmSongPoolPresentation = (songPoolId?: number | string) => {
  const resolvedSongPoolId: PersonalFmSongPoolId =
    Number(songPoolId) === 1 ? 1 : Number(songPoolId) === 2 ? 2 : 0;
  return {
    songPoolId: resolvedSongPoolId,
    label: resolvedSongPoolId === 1 ? '根据风格' : resolvedSongPoolId === 2 ? '探索' : '根据口味',
  };
};

const normalizePlaylistName = (value: string | undefined): string => String(value ?? '').trim();

const getPlaylistIdentityValues = (playlist: PlaylistMeta): string[] => {
  return [
    playlist.id,
    playlist.listid,
    playlist.listCreateGid,
    playlist.globalCollectionId,
    playlist.listCreateListid,
  ]
    .filter((value) => value !== undefined && value !== null && String(value) !== '')
    .map((value) => String(value));
};

const findLikedPlaylist = (playlists: PlaylistMeta[]): PlaylistMeta | undefined => {
  let index = playlists.findIndex((playlist) => {
    const name = normalizePlaylistName(playlist.name);
    return name === '我喜欢的音乐';
  });

  if (index === -1) {
    index = playlists.findIndex((playlist) =>
      normalizePlaylistName(playlist.name).includes('喜欢'),
    );
  }

  if (index === -1) {
    index = playlists.findIndex((playlist) => playlist.type === 1 || playlist.isDefault === true);
  }

  if (index === -1) {
    index = playlists.findIndex((playlist) => normalizePlaylistName(playlist.name) === '默认收藏');
  }

  return index === -1 ? undefined : playlists[index];
};

const dedupeSongs = (songs: Song[]): Song[] => {
  const seen = new Set<string>();
  return songs.filter((song) => {
    const key =
      String(song.mixSongId ?? '0') !== '0'
        ? `mx:${String(song.mixSongId)}`
        : song.hash
          ? `hash:${song.hash.toLowerCase()}`
          : `id:${String(song.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const includesPlaylistIdentity = (playlist: PlaylistMeta, id: string): boolean => {
  return getPlaylistIdentityValues(playlist).includes(id);
};

const FAVORITES_PAGE_SIZE = 200;
const MAX_PLAYBACK_QUEUE_COUNT = 4;
const PERSONAL_FM_MODE = 'normal';
let personalFmSessionResetPending = true;

// 收藏歌曲加载器（模块级，非响应式）
let favoritesLoader: PagedSongLoader<Song> | null = null;

const buildPlaybackQueueState = (
  options: SetPlaybackQueueOptions = {},
  songs: Song[] = [],
  filteredInvalidCount = 0,
): PlaybackQueueState => {
  const now = Date.now();
  return {
    id: String(options.queueId ?? DEFAULT_PLAYBACK_QUEUE_ID),
    title: options.title?.trim() || '播放列表',
    subtitle: options.subtitle?.trim() || '',
    coverUrl: options.coverUrl?.trim() || '',
    type: options.type ?? 'default',
    songs: songs.slice(),
    filteredInvalidCount: Math.max(0, filteredInvalidCount),
    queuedNextTrackIds: [],
    currentTrackId: null,
    createdAt: now,
    updatedAt: now,
    dynamic: options.dynamic ?? false,
    meta: { ...(options.meta ?? {}) },
  };
};

const resolveSongQueueKey = (song: Song): string => {
  if (String(song.mixSongId ?? '0') !== '0') return `mx:${String(song.mixSongId)}`;
  if (song.hash) return `hash:${song.hash.toLowerCase()}`;
  return `id:${String(song.id)}`;
};

const resolveSongNumericId = (song: Song | null | undefined): string => {
  if (!song) return '';
  const candidates = [song.songId, song.mixSongId, song.fileId, song.id];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  }
  return String(song.id ?? '');
};

const mergeQueueSongs = (existing: Song[], incoming: Song[]): Song[] => {
  if (incoming.length === 0) return existing.slice();
  const seen = new Set(existing.map((song) => resolveSongQueueKey(song)));
  const next = existing.slice();
  incoming.forEach((song) => {
    const key = resolveSongQueueKey(song);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(song);
  });
  return next;
};

const appendQueueSong = (queue: PlaybackQueueState, song: Song): boolean => {
  const key = resolveSongQueueKey(song);
  const exists = queue.songs.some((item) => resolveSongQueueKey(item) === key);
  if (exists) return false;
  queue.songs.push(song);
  return true;
};

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    defaultList: [] as Song[],
    favorites: shallowRef<Song[]>([]),
    userPlaylists: [] as PlaylistMeta[],
    queueFilteredInvalidCount: 0,
    queuedNextTrackIds: [] as string[],
    playbackQueues: [] as PlaybackQueueState[],
    activeQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    lastNonFmQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    personalFmMode: PERSONAL_FM_MODE as PersonalFmMode,
    personalFmSongPoolId: 0 as PersonalFmSongPoolId,
    personalFmBuffer: [] as Song[],
  }),
  getters: {
    likedPlaylist(state) {
      return findLikedPlaylist(state.userPlaylists);
    },
    activeQueue(state): PlaybackQueueState | null {
      return state.playbackQueues.find((queue) => queue.id === state.activeQueueId) ?? null;
    },
    playbackQueueList(state): PlaybackQueueState[] {
      return state.playbackQueues
        .slice()
        .sort(
          (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
        );
    },
    historyPlaybackQueues(): PlaybackQueueState[] {
      return this.playbackQueueList.filter(
        (queue) =>
          queue.id !== this.activeQueueId &&
          queue.id !== MANUAL_PLAYBACK_QUEUE_ID &&
          queue.id !== PERSONAL_FM_QUEUE_ID &&
          queue.songs.length > 0,
      );
    },
    recentPlaybackQueues(): PlaybackQueueState[] {
      return this.playbackQueueList.filter(
        (queue) =>
          queue.id !== this.activeQueueId &&
          queue.id !== MANUAL_PLAYBACK_QUEUE_ID &&
          queue.id !== PERSONAL_FM_QUEUE_ID &&
          queue.songs.length > 0,
      );
    },
    customPlaybackQueue(): PlaybackQueueState | null {
      return (
        this.playbackQueues.find(
          (queue) => queue.id === MANUAL_PLAYBACK_QUEUE_ID && queue.songs.length > 0,
        ) ?? null
      );
    },
    likedPlaylistQueryId(): string | number | null {
      const playlist = this.likedPlaylist;
      if (!playlist) return null;
      return (
        playlist.listCreateGid || playlist.globalCollectionId || playlist.listid || playlist.id
      );
    },
    likedPlaylistListId(): number | null {
      const playlist = this.likedPlaylist;
      if (!playlist?.listid) return null;
      return playlist.listid;
    },
  },
  actions: {
    markLastNonFmQueue(queueId: string | number | null | undefined) {
      const resolvedId = String(queueId ?? '');
      if (
        !resolvedId ||
        resolvedId === PERSONAL_FM_QUEUE_ID ||
        resolvedId === MANUAL_PLAYBACK_QUEUE_ID
      )
        return;
      this.lastNonFmQueueId = resolvedId;
    },
    getPreferredManualQueueOptions(options: SetPlaybackQueueOptions = {}) {
      if (options.queueId) return { ...options };

      const activeQueue =
        this.playbackQueues.find((queue) => queue.id === this.activeQueueId) ?? this.activeQueue;

      if (activeQueue && activeQueue.id !== PERSONAL_FM_QUEUE_ID) {
        this.markLastNonFmQueue(activeQueue.id);
        return {
          ...options,
          queueId: activeQueue.id,
        };
      }

      const fallbackQueue =
        this.playbackQueues.find((queue) => queue.id === this.lastNonFmQueueId) ??
        this.playbackQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID) ??
        null;

      if (!fallbackQueue) {
        return {
          ...options,
          queueId: DEFAULT_PLAYBACK_QUEUE_ID,
        };
      }

      this.markLastNonFmQueue(fallbackQueue.id);
      return {
        ...options,
        queueId: fallbackQueue.id,
        title: options.title ?? fallbackQueue.title,
        subtitle: options.subtitle ?? fallbackQueue.subtitle,
        coverUrl: options.coverUrl ?? fallbackQueue.coverUrl,
        type: options.type ?? fallbackQueue.type,
        dynamic: options.dynamic ?? fallbackQueue.dynamic,
        meta: options.meta ? { ...fallbackQueue.meta, ...options.meta } : { ...fallbackQueue.meta },
      };
    },
    getPlaybackQueueSongs(queueId?: string | number | null) {
      const resolvedId = String(queueId ?? '');
      if (!resolvedId) return [];
      const queue = this.playbackQueues.find((item) => item.id === resolvedId);
      return queue?.songs.slice() ?? [];
    },
    syncLegacyPlaybackState() {
      const activeQueue =
        this.playbackQueues.find((queue) => queue.id === this.activeQueueId) ??
        this.playbackQueues[0] ??
        null;

      if (!activeQueue) {
        this.defaultList = [];
        this.queueFilteredInvalidCount = 0;
        this.queuedNextTrackIds = [];
        return;
      }

      this.defaultList = activeQueue.songs.slice();
      this.queueFilteredInvalidCount = Math.max(0, activeQueue.filteredInvalidCount);
      this.queuedNextTrackIds = activeQueue.queuedNextTrackIds.slice();
      this.markLastNonFmQueue(activeQueue.id);
    },
    trimPlaybackQueues(limit = MAX_PLAYBACK_QUEUE_COUNT) {
      if (this.playbackQueues.length <= limit) return;
      const protectedIds = new Set<string>([this.activeQueueId, DEFAULT_PLAYBACK_QUEUE_ID]);
      const removable = this.playbackQueues
        .filter((queue) => !protectedIds.has(queue.id))
        .sort(
          (left, right) => left.createdAt - right.createdAt || left.updatedAt - right.updatedAt,
        );

      const nextQueues = this.playbackQueues.slice();
      while (nextQueues.length > limit && removable.length > 0) {
        const target = removable.shift();
        if (!target) break;
        const index = nextQueues.findIndex((queue) => queue.id === target.id);
        if (index >= 0) nextQueues.splice(index, 1);
      }

      this.playbackQueues = nextQueues;
    },
    hydratePlaybackQueues() {
      if (this.playbackQueues.length > 0) {
        if (!this.playbackQueues.some((queue) => queue.id === this.activeQueueId)) {
          this.activeQueueId = this.playbackQueues[0]?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
        }
        this.syncLegacyPlaybackState();
        return;
      }

      if (
        this.defaultList.length === 0 &&
        this.queueFilteredInvalidCount === 0 &&
        this.queuedNextTrackIds.length === 0
      ) {
        return;
      }

      this.playbackQueues = [
        {
          ...buildPlaybackQueueState(
            {
              queueId: this.activeQueueId || DEFAULT_PLAYBACK_QUEUE_ID,
              title: '播放列表',
              type: 'default',
            },
            this.defaultList,
            this.queueFilteredInvalidCount,
          ),
          queuedNextTrackIds: this.queuedNextTrackIds.slice(),
        },
      ];
      this.activeQueueId = this.playbackQueues[0].id;
      this.syncLegacyPlaybackState();
    },
    ensurePlaybackQueue(queueId?: string, options: SetPlaybackQueueOptions = {}) {
      this.hydratePlaybackQueues();
      const resolvedId = String(
        queueId ?? options.queueId ?? this.activeQueueId ?? DEFAULT_PLAYBACK_QUEUE_ID,
      );
      const matched = this.playbackQueues.find((queue) => queue.id === resolvedId);
      if (matched) return matched;

      const created = buildPlaybackQueueState({
        queueId: resolvedId,
        title: options.title,
        subtitle: options.subtitle,
        coverUrl: options.coverUrl,
        type: options.type,
        dynamic: options.dynamic,
        meta: options.meta,
      });
      this.playbackQueues.unshift(created);
      this.trimPlaybackQueues();
      return created;
    },
    setActiveQueue(queueId: string | number) {
      const previousActiveQueueId = this.activeQueueId;
      const matched = this.ensurePlaybackQueue(String(queueId));
      this.activeQueueId = matched.id;
      matched.updatedAt = Date.now();
      this.markLastNonFmQueue(matched.id);
      if (previousActiveQueueId === PERSONAL_FM_QUEUE_ID && matched.id !== PERSONAL_FM_QUEUE_ID) {
        this.removePersonalFmQueue();
        return;
      }
      this.syncLegacyPlaybackState();
    },
    removePersonalFmQueue(options?: { preserveBuffer?: boolean }) {
      const nextQueues = this.playbackQueues.filter((queue) => queue.id !== PERSONAL_FM_QUEUE_ID);
      this.playbackQueues = nextQueues;
      if (this.activeQueueId === PERSONAL_FM_QUEUE_ID) {
        const fallbackQueue =
          nextQueues.find((queue) => queue.id === this.lastNonFmQueueId) ??
          nextQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID) ??
          nextQueues[0] ??
          null;
        this.activeQueueId = fallbackQueue?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
      }
      if (!options?.preserveBuffer) {
        this.personalFmBuffer = [];
      }
      this.syncLegacyPlaybackState();
    },
    getQueueById(queueId?: string | number | null) {
      const resolvedId = String(queueId ?? '');
      if (!resolvedId) return null;
      return this.playbackQueues.find((item) => item.id === resolvedId) ?? null;
    },
    updateQueueCurrentTrack(songId: string | number | null | undefined, queueId?: string) {
      const targetQueue = this.ensurePlaybackQueue(queueId);
      targetQueue.currentTrackId =
        songId === undefined || songId === null || String(songId) === '' ? null : String(songId);
      targetQueue.updatedAt = Date.now();
      if (targetQueue.id === this.activeQueueId) {
        this.syncLegacyPlaybackState();
      }
    },
    getQueueRemainingSongCount(queueId?: string, trackId?: string | null) {
      const targetQueue = this.ensurePlaybackQueue(queueId);
      const currentTrackId = String(trackId ?? targetQueue.currentTrackId ?? '');
      if (!currentTrackId) return targetQueue.songs.length;
      const currentIndex = targetQueue.songs.findIndex(
        (song) => String(song.id) === currentTrackId,
      );
      if (currentIndex === -1) return targetQueue.songs.length;
      return Math.max(0, targetQueue.songs.length - currentIndex - 1);
    },
    getPersonalFmPreviewTrack() {
      const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
      if (personalFmSessionResetPending && this.personalFmBuffer.length > 0) {
        return this.personalFmBuffer[0] ?? null;
      }
      const currentTrack =
        queue?.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ?? null;
      if (currentTrack) return currentTrack;
      if (queue && queue.songs.length > 0) return queue.songs[queue.songs.length - 1];
      return this.personalFmBuffer[0] ?? null;
    },
    getPersonalFmDisplayTracks(limit = 5) {
      const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
      if (personalFmSessionResetPending && this.personalFmBuffer.length > 0) {
        return dedupeSongs(this.personalFmBuffer).slice(0, limit);
      }
      const currentId = String(queue?.currentTrackId ?? '');
      const source = [
        ...this.personalFmBuffer,
        ...(queue?.songs.filter((song) => String(song.id) !== currentId).reverse() ?? []),
      ];
      const seen = new Set<string>();
      const result: Song[] = [];

      for (const song of source) {
        const key = resolveSongQueueKey(song);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(song);
        if (result.length >= limit) break;
      }

      return result;
    },
    updatePersonalFmMode(mode: PersonalFmMode) {
      const presentation = getPersonalFmModePresentation(mode);
      this.personalFmMode = presentation.mode;
      const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
      if (queue) {
        queue.title = presentation.title;
        queue.subtitle = presentation.subtitle;
        queue.meta = {
          ...queue.meta,
          mode: presentation.mode,
        };
        queue.updatedAt = Date.now();
      }
    },
    updatePersonalFmSongPool(songPoolId?: PersonalFmSongPoolId | number) {
      const presentation = getPersonalFmSongPoolPresentation(songPoolId);
      this.personalFmSongPoolId = presentation.songPoolId;
      const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
      if (queue) {
        queue.meta = {
          ...queue.meta,
          song_pool_id: presentation.songPoolId,
        };
        queue.updatedAt = Date.now();
      }
    },
    isPersonalFmSessionResetPending() {
      return personalFmSessionResetPending;
    },
    async resetPersonalFmPreview(options?: {
      mode?: PersonalFmMode;
      songPoolId?: PersonalFmSongPoolId | number;
      preserveQueue?: boolean;
    }) {
      const presentation = getPersonalFmModePresentation(options?.mode ?? this.personalFmMode);
      const songPoolPresentation = getPersonalFmSongPoolPresentation(
        options?.songPoolId ?? this.personalFmSongPoolId,
      );
      this.personalFmMode = presentation.mode;
      this.personalFmSongPoolId = songPoolPresentation.songPoolId;

      const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID) ?? null;
      if (queue && !options?.preserveQueue) {
        queue.title = presentation.title;
        queue.subtitle = presentation.subtitle;
        queue.songs = [];
        queue.filteredInvalidCount = 0;
        queue.queuedNextTrackIds = [];
        queue.currentTrackId = null;
        queue.dynamic = true;
        queue.meta = {
          ...queue.meta,
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        };
        queue.createdAt = Date.now();
        queue.updatedAt = queue.createdAt;
      }

      this.personalFmBuffer = [];

      try {
        const songs = await this.fetchPersonalFmSongs({
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        });
        this.personalFmBuffer = dedupeSongs(songs);
        if (!options?.preserveQueue) {
          personalFmSessionResetPending = false;
        }
        if (queue && this.activeQueueId === queue.id) {
          this.syncLegacyPlaybackState();
        }
        return this.personalFmBuffer[0] ?? null;
      } catch (error) {
        logger.warn('PlaylistStore', 'Reset personal fm preview failed:', error);
        if (queue && this.activeQueueId === queue.id) {
          this.syncLegacyPlaybackState();
        }
        return null;
      }
    },
    async refreshPersonalFmPreview(mode?: PersonalFmMode) {
      const presentation = getPersonalFmModePresentation(mode ?? this.personalFmMode);
      this.updatePersonalFmMode(presentation.mode);
      try {
        const songs = await this.fetchPersonalFmSongs({
          mode: presentation.mode,
          song_pool_id: this.personalFmSongPoolId,
        });
        if (songs.length > 0) {
          this.personalFmBuffer = dedupeSongs(songs);
        }
        return songs;
      } catch (error) {
        logger.warn('PlaylistStore', 'Refresh personal fm preview failed:', error);
        return [] as Song[];
      }
    },
    async fetchPersonalFmSongs(params: PersonalFmParams = {}) {
      const response = await getPersonalFm(params);
      return extractList(response).map((item) => mapTopSong(item));
    },
    async startPersonalFm(options?: {
      fresh?: boolean;
      mode?: PersonalFmMode;
      recreate?: boolean;
      retainBuffer?: boolean;
    }) {
      const presentation = getPersonalFmModePresentation(options?.mode ?? this.personalFmMode);
      const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
      this.updatePersonalFmMode(presentation.mode);
      if (options?.recreate) {
        this.removePersonalFmQueue({ preserveBuffer: options.retainBuffer });
      }
      const queue = this.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
        queueId: PERSONAL_FM_QUEUE_ID,
        title: presentation.title,
        subtitle: presentation.subtitle,
        type: 'fm',
        dynamic: true,
        meta: {
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        },
      });
      if (options?.fresh) {
        queue.songs = [];
        queue.queuedNextTrackIds = [];
        queue.currentTrackId = null;
        queue.filteredInvalidCount = 0;
        queue.createdAt = Date.now();
        queue.updatedAt = queue.createdAt;
        if (!options.retainBuffer) {
          this.personalFmBuffer = [];
        }
      }
      if (queue.songs.length > 0 || this.personalFmBuffer.length > 0) {
        this.activeQueueId = queue.id;
        this.syncLegacyPlaybackState();
        personalFmSessionResetPending = false;
        return true;
      }
      const songs = await this.fetchPersonalFmSongs({
        mode: presentation.mode,
        song_pool_id: songPoolPresentation.songPoolId,
      });
      if (songs.length === 0) return false;
      queue.songs = [];
      queue.currentTrackId = null;
      queue.updatedAt = Date.now();
      this.personalFmBuffer = dedupeSongs(songs);
      this.activeQueueId = queue.id;
      this.syncLegacyPlaybackState();
      personalFmSessionResetPending = false;
      return true;
    },
    activatePersonalFmTrack(song: Song) {
      const presentation = getPersonalFmModePresentation(this.personalFmMode);
      const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
      const queue = this.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
        queueId: PERSONAL_FM_QUEUE_ID,
        title: presentation.title,
        subtitle: presentation.subtitle,
        type: 'fm',
        dynamic: true,
        meta: {
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        },
      });
      const targetKey = resolveSongQueueKey(song);
      this.personalFmBuffer = this.personalFmBuffer.filter(
        (item) => resolveSongQueueKey(item) !== targetKey,
      );
      if (!queue.songs.some((item) => resolveSongQueueKey(item) === targetKey)) {
        queue.songs.push(song);
      }
      this.activeQueueId = queue.id;
      queue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
      return queue.songs.slice();
    },
    async ensurePersonalFmQueue(options?: {
      track?: Song | null;
      playtime?: number;
      action?: 'play' | 'garbage';
      isOverplay?: boolean;
    }) {
      const presentation = getPersonalFmModePresentation(this.personalFmMode);
      const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
      const queue = this.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
        queueId: PERSONAL_FM_QUEUE_ID,
        title: presentation.title,
        subtitle: presentation.subtitle,
        type: 'fm',
        dynamic: true,
        meta: {
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        },
      });
      const track =
        options?.track ??
        queue.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
        null;
      const remainSongcnt = this.personalFmBuffer.length;
      if (remainSongcnt > 4) return 0;

      const params: PersonalFmParams = {
        mode: String(queue.meta.mode ?? PERSONAL_FM_MODE),
        action: options?.action ?? 'play',
        song_pool_id: Number(queue.meta.song_pool_id ?? 0),
        remain_songcnt: remainSongcnt,
      };

      if (track) {
        if (track.hash) params.hash = track.hash;
        const songid = resolveSongNumericId(track);
        if (songid) params.songid = songid;
        if (options?.playtime !== undefined) {
          params.playtime = Math.max(0, Math.floor(options.playtime));
        }
        if (options?.isOverplay !== undefined) {
          params.is_overplay = options.isOverplay ? 1 : 0;
        }
      }

      try {
        const nextSongs = await this.fetchPersonalFmSongs(params);
        if (nextSongs.length === 0) return 0;
        this.personalFmBuffer = mergeQueueSongs(this.personalFmBuffer, nextSongs);
        return nextSongs.length;
      } catch (error) {
        logger.warn('PlaylistStore', 'Fetch personal fm songs failed:', error);
        return 0;
      }
    },
    async consumeNextPersonalFmTrack(options?: {
      track?: Song | null;
      playtime?: number;
      action?: 'play' | 'garbage';
      isOverplay?: boolean;
    }) {
      const presentation = getPersonalFmModePresentation(this.personalFmMode);
      const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
      const queue = this.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
        queueId: PERSONAL_FM_QUEUE_ID,
        title: presentation.title,
        subtitle: presentation.subtitle,
        type: 'fm',
        dynamic: true,
        meta: {
          mode: presentation.mode,
          song_pool_id: songPoolPresentation.songPoolId,
        },
      });

      if (this.personalFmBuffer.length === 0) {
        await this.ensurePersonalFmQueue(options);
      }

      while (this.personalFmBuffer.length > 0) {
        const nextSong = this.personalFmBuffer.shift();
        if (!nextSong) break;
        appendQueueSong(queue, nextSong);
        queue.updatedAt = Date.now();
        this.syncLegacyPlaybackState();
        return nextSong;
      }

      return null;
    },
    async ensureLikedPlaylistReady() {
      if (this.likedPlaylistQueryId || this.likedPlaylistListId) {
        return {
          queryId: this.likedPlaylistQueryId,
          listId: this.likedPlaylistListId,
        };
      }
      if (this.userPlaylists.length === 0) {
        await this.fetchUserPlaylists();
      }
      return {
        queryId: this.likedPlaylistQueryId,
        listId: this.likedPlaylistListId,
      };
    },
    isFavoriteSong(song: Song) {
      return this.favorites.some(
        (item) => isSameSong(item, song) || String(item.id) === String(song.id),
      );
    },
    findPlaylistByIdentity(id: string | number | null | undefined) {
      if (id === undefined || id === null || String(id) === '') return undefined;
      const target = String(id);
      return this.userPlaylists.find((playlist) => includesPlaylistIdentity(playlist, target));
    },
    isFavoriteAlbum(albumId: string | number | null | undefined) {
      if (albumId === undefined || albumId === null || String(albumId) === '') return false;
      const target = String(albumId);
      return this.userPlaylists.some(
        (playlist) => playlist.source === 2 && includesPlaylistIdentity(playlist, target),
      );
    },
    isOwnedPlaylist(listId: string | number | null | undefined, currentUserId?: number) {
      if (!currentUserId) return false;
      const matched = this.findPlaylistByIdentity(listId);
      return !!matched && matched.listCreateUserid === currentUserId && matched.source !== 2;
    },
    getCreatedPlaylists(currentUserId?: number) {
      if (!currentUserId) return [] as PlaylistMeta[];
      return this.userPlaylists.filter(
        (playlist) => playlist.listCreateUserid === currentUserId && playlist.source !== 2,
      );
    },
    resolveNumericListId(id: string | number | null | undefined): string | number | null {
      if (id === undefined || id === null || String(id) === '') return null;
      const target = String(id);
      const matched = this.findPlaylistByIdentity(target);
      if (!matched) return id;
      return matched.listid || matched.id || id;
    },
    syncCloudFavorites(songs: Song[]) {
      this.favorites = dedupeSongs(songs);
    },
    async fetchLikedPlaylistSongs() {
      const likedPlaylist = this.likedPlaylist;
      const likedQueryId = this.likedPlaylistQueryId;
      if (!likedPlaylist || !likedQueryId) {
        this.favorites = [];
        return false;
      }

      // 中止上一次加载
      if (favoritesLoader) {
        favoritesLoader.abort();
      }

      const queryId = String(likedQueryId);
      const updateFavorites = (items: readonly Song[]) => {
        this.favorites = dedupeSongs(items.slice());
      };

      const loader = new PagedSongLoader<Song>(
        async (page, pageSize) => {
          const response = await getPlaylistTracks(queryId, page, pageSize);
          const { songs: pageSongs, filteredCount } = parsePlaylistTracks(response);
          const hasMore = pageSongs.length + filteredCount >= pageSize;
          return { items: pageSongs, hasMore };
        },
        {
          pageSize: FAVORITES_PAGE_SIZE,
          concurrency: 3,
          dedupeKey: (song) => String(song.id),
          logTag: 'FavoritesLoader',
          maxPages: 50,
          onPageLoaded: (allItems) => updateFavorites(allItems),
          onComplete: (allItems) => updateFavorites(allItems),
        },
      );

      favoritesLoader = loader;

      // 首页加载完立即渲染，剩余页后台并发
      await loader.loadFirstPage();
      if (!loader.fullyLoaded) {
        void loader.loadRemaining();
      }

      return loader.count > 0;
    },
    /**
     * 等待收藏歌曲全部加载完成
     */
    async waitForFavoritesLoaded(): Promise<readonly Song[]> {
      if (favoritesLoader) {
        return favoritesLoader.waitForAll();
      }
      return this.favorites;
    },
    setPlaybackQueue(songs: Song[], filteredInvalidCount = 0) {
      this.setPlaybackQueueWithOptions(songs, filteredInvalidCount);
    },
    setPlaybackQueueWithOptions(
      songs: Song[],
      filteredInvalidCount = 0,
      options: SetPlaybackQueueOptions = {},
    ) {
      const previousActiveQueueId = this.activeQueueId;
      const targetQueue = this.ensurePlaybackQueue(options.queueId, options);
      targetQueue.songs = songs.slice();
      targetQueue.filteredInvalidCount = Math.max(0, filteredInvalidCount);
      if (
        songs.length !== targetQueue.songs.length ||
        songs.some((song, index) => String(song.id) !== String(targetQueue.songs[index]?.id))
      ) {
        targetQueue.queuedNextTrackIds = [];
      }
      targetQueue.title = options.title?.trim() || targetQueue.title || '播放列表';
      targetQueue.subtitle = options.subtitle?.trim() ?? targetQueue.subtitle;
      targetQueue.coverUrl = options.coverUrl?.trim() ?? targetQueue.coverUrl;
      targetQueue.type = options.type ?? targetQueue.type;
      targetQueue.dynamic = options.dynamic ?? targetQueue.dynamic;
      targetQueue.meta = options.meta ? { ...targetQueue.meta, ...options.meta } : targetQueue.meta;
      if (
        targetQueue.currentTrackId &&
        !targetQueue.songs.some((song) => String(song.id) === String(targetQueue.currentTrackId))
      ) {
        targetQueue.currentTrackId = null;
      }
      targetQueue.updatedAt = Date.now();
      if (options.activate !== false) {
        this.activeQueueId = targetQueue.id;
        this.markLastNonFmQueue(targetQueue.id);
      }
      if (
        previousActiveQueueId === PERSONAL_FM_QUEUE_ID &&
        targetQueue.id !== PERSONAL_FM_QUEUE_ID
      ) {
        this.removePersonalFmQueue();
        return;
      }
      this.trimPlaybackQueues();
      this.syncLegacyPlaybackState();
    },
    clearPlaybackQueue() {
      const targetQueue = this.ensurePlaybackQueue();
      targetQueue.songs = [];
      targetQueue.filteredInvalidCount = 0;
      targetQueue.queuedNextTrackIds = [];
      targetQueue.currentTrackId = null;
      if (targetQueue.id === PERSONAL_FM_QUEUE_ID) {
        this.personalFmBuffer = [];
      }
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    appendToPlaybackQueue(songs: Song[], options: SetPlaybackQueueOptions = {}) {
      if (songs.length === 0) return 0;
      const previousActiveQueueId = this.activeQueueId;
      const targetQueue = this.ensurePlaybackQueue(options.queueId, options);
      const nextList = targetQueue.songs.slice();
      let addedCount = 0;
      songs.forEach((song) => {
        if (
          nextList.some((item) => isSameSong(item, song) || String(item.id) === String(song.id))
        ) {
          return;
        }
        nextList.push(song);
        addedCount += 1;
      });
      if (addedCount === 0) return 0;
      targetQueue.songs = nextList;
      targetQueue.title = options.title?.trim() || targetQueue.title || '播放列表';
      targetQueue.subtitle = options.subtitle?.trim() ?? targetQueue.subtitle;
      targetQueue.coverUrl = options.coverUrl?.trim() ?? targetQueue.coverUrl;
      targetQueue.type = options.type ?? targetQueue.type;
      targetQueue.dynamic = options.dynamic ?? targetQueue.dynamic;
      targetQueue.meta = options.meta ? { ...targetQueue.meta, ...options.meta } : targetQueue.meta;
      targetQueue.updatedAt = Date.now();
      if (options.activate !== false) {
        this.activeQueueId = targetQueue.id;
        this.markLastNonFmQueue(targetQueue.id);
      }
      if (
        previousActiveQueueId === PERSONAL_FM_QUEUE_ID &&
        targetQueue.id !== PERSONAL_FM_QUEUE_ID
      ) {
        this.removePersonalFmQueue();
        return addedCount;
      }
      this.trimPlaybackQueues();
      this.syncLegacyPlaybackState();
      return addedCount;
    },
    removePlaybackQueue(queueId: string | number) {
      this.hydratePlaybackQueues();
      const targetId = String(queueId ?? '');
      if (!targetId) return;
      if (targetId === MANUAL_PLAYBACK_QUEUE_ID) return;
      const nextQueues = this.playbackQueues.filter((queue) => queue.id !== targetId);
      if (nextQueues.length === this.playbackQueues.length) return;
      this.playbackQueues = nextQueues;
      if (this.activeQueueId === targetId) {
        this.activeQueueId = nextQueues[0]?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
      }
      if (this.lastNonFmQueueId === targetId) {
        const fallbackQueue = nextQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID);
        this.lastNonFmQueueId = fallbackQueue?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
      }
      this.syncLegacyPlaybackState();
    },
    enqueuePlayNext(songId: string | number) {
      const id = String(songId ?? '');
      if (!id) return;
      const targetQueue = this.ensurePlaybackQueue();
      targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
      targetQueue.queuedNextTrackIds.unshift(id);
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    consumeQueuedNextTrackId(songId: string | number) {
      const id = String(songId ?? '');
      const targetQueue = this.ensurePlaybackQueue();
      if (!id || targetQueue.queuedNextTrackIds.length === 0) return;
      targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    peekQueuedNextTrackId(): string | null {
      const targetQueue = this.ensurePlaybackQueue();
      return targetQueue.queuedNextTrackIds[0] ?? null;
    },
    syncQueuedNextTrackIds() {
      const targetQueue = this.ensurePlaybackQueue();
      if (targetQueue.queuedNextTrackIds.length === 0) return;
      const validIds = new Set(targetQueue.songs.map((song) => String(song.id)));
      targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((id) =>
        validIds.has(id),
      );
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    removeFromQueue(songId: string | number, queueId?: string | number) {
      const id = String(songId ?? '');
      const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
      targetQueue.songs = targetQueue.songs.filter((song) => String(song.id) !== id);
      targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
      if (targetQueue.currentTrackId === id) {
        targetQueue.currentTrackId = null;
      }
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    reorderPlaybackQueue(fromIndex: number, toIndex: number, queueId?: string | number) {
      if (fromIndex === toIndex) return;
      const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
      if (fromIndex < 0 || fromIndex >= targetQueue.songs.length) return;

      const nextList = targetQueue.songs.slice();
      const [movedSong] = nextList.splice(fromIndex, 1);
      if (!movedSong) return;

      const normalizedTarget = Math.max(0, Math.min(toIndex, nextList.length));
      nextList.splice(normalizedTarget, 0, movedSong);
      targetQueue.songs = nextList;
      targetQueue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
    },
    async addToPlaylist(listId: string | number, song: Song) {
      const targetId = String(listId ?? '');
      if (!targetId) return false;

      try {
        const songData = `${song.title}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
        const res = await addPlaylistTrack(targetId, songData);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          logger.info('PlaylistStore', `Song ${song.title} added to playlist ${targetId}`);
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Add to playlist error:', e);
      }
      return false;
    },
    async removeFromPlaylist(listId: string | number, song: Song) {
      const targetId = String(listId ?? '');
      if (!targetId) return false;

      try {
        const fileId = String(song.fileId ?? song.mixSongId ?? '');
        const res = await deletePlaylistTrack(targetId, fileId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          logger.info('PlaylistStore', `Song ${song.title} removed from playlist ${targetId}`);
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Remove from playlist error:', e);
      }
      return false;
    },
    async addToFavorites(song: Song) {
      const likedPlaylist = await this.ensureLikedPlaylistReady();
      const listId = likedPlaylist.listId;
      const alreadyFavorited = this.isFavoriteSong(song);
      if (!alreadyFavorited) {
        this.favorites = [song, ...this.favorites];
      }

      if (listId) {
        try {
          const songData = `${song.title}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
          const res = await addPlaylistTrack(listId, songData);
          if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
            logger.info('PlaylistStore', `Song ${song.title} added to favorites on cloud`);
            return true;
          }
          if (!alreadyFavorited) {
            this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
          }
          logger.warn('PlaylistStore', 'Add to favorites sync failed:', res);
          return false;
        } catch (e) {
          if (!alreadyFavorited) {
            this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
          }
          logger.error('PlaylistStore', 'Add to favorites sync error:', e);
          return false;
        }
      }

      if (!alreadyFavorited) {
        this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
      }
      return false;
    },
    async removeFromFavorites(id: string) {
      const song = this.favorites.find((item) => String(item.id) === String(id));
      if (!song) return;

      const previousFavorites = this.favorites.slice();
      this.favorites = this.favorites.filter(
        (item) => !isSameSong(item, song) && String(item.id) !== String(id),
      );

      const likedPlaylist = await this.ensureLikedPlaylistReady();
      const listId = likedPlaylist.listId;
      if (listId) {
        try {
          const fileId = String(song.fileId ?? song.mixSongId ?? '');
          const res = await deletePlaylistTrack(listId, fileId);
          if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
            logger.info('PlaylistStore', `Song ${song.title} removed from favorites on cloud`);
            return true;
          }
          this.favorites = previousFavorites;
          logger.warn('PlaylistStore', 'Remove from favorites sync failed:', res);
          return false;
        } catch (e) {
          this.favorites = previousFavorites;
          logger.error('PlaylistStore', 'Remove from favorites sync error:', e);
          return false;
        }
      }
      this.favorites = previousFavorites;
      return false;
    },
    async removeFavoriteSong(song: Song) {
      const matched = this.favorites.find(
        (item) => isSameSong(item, song) || String(item.id) === String(song.id),
      );

      // 优先使用传入 song 的 fileId（来自歌单详情页 API，值更准确），
      // 其次使用 favorites 中匹配项的 fileId
      const effectiveFileId = String(
        song.fileId ?? matched?.fileId ?? song.mixSongId ?? matched?.mixSongId ?? '',
      );

      const previousFavorites = this.favorites.slice();
      if (matched) {
        this.favorites = this.favorites.filter(
          (item) => !isSameSong(item, matched) && String(item.id) !== String(matched.id),
        );
      } else {
        this.favorites = this.favorites.filter(
          (item) => !isSameSong(item, song) && String(item.id) !== String(song.id),
        );
      }

      const likedPlaylist = await this.ensureLikedPlaylistReady();
      const listId = likedPlaylist.listId;
      if (!listId) {
        this.favorites = previousFavorites;
        return false;
      }

      try {
        const res = await deletePlaylistTrack(listId, effectiveFileId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          logger.info('PlaylistStore', `Song ${song.title} removed from favorites on cloud`);
          return true;
        }
        this.favorites = previousFavorites;
        logger.warn('PlaylistStore', 'Remove from favorites sync failed:', res);
        return false;
      } catch (e) {
        this.favorites = previousFavorites;
        logger.error('PlaylistStore', 'Remove from favorites sync error:', e);
        return false;
      }
    },
    async fetchUserPlaylists() {
      try {
        const PAGE_SIZE = 30;
        let page = 1;
        let allPlaylists: PlaylistMeta[] = [];
        // 分页获取所有歌单
        while (true) {
          const res = await getUserPlaylists(page, PAGE_SIZE);
          if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) break;
          const data = 'data' in res ? (res as { data?: { info?: unknown } }).data : undefined;
          const info = 'info' in res ? (res as { info?: unknown }).info : undefined;
          const raw = data?.info ?? info ?? [];
          if (!Array.isArray(raw) || raw.length === 0) break;
          allPlaylists = allPlaylists.concat(raw.map((item) => mapPlaylistMeta(item)));
          // 不足一页说明已经是最后一页
          if (raw.length < PAGE_SIZE) break;
          page++;
        }
        this.userPlaylists = allPlaylists;
        await this.fetchLikedPlaylistSongs();
      } catch (e) {
        logger.error('PlaylistStore', 'Fetch user playlists error:', e);
      }
    },
    async createPlaylist(name: string, isPrivate = false, currentUserId?: number) {
      if (!currentUserId) return false;
      try {
        const res = await addPlaylist(name, {
          is_pri: isPrivate ? 1 : 0,
          type: 0,
          list_create_userid: currentUserId,
          source: 1,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Create playlist error:', e);
      }
      return false;
    },
    async createPlaylistAndReturnId(
      name: string,
      isPrivate = false,
      currentUserId?: number,
    ): Promise<number | null> {
      if (!currentUserId) return null;
      try {
        const res = await addPlaylist(name, {
          is_pri: isPrivate ? 1 : 0,
          type: 0,
          list_create_userid: currentUserId,
          source: 1,
        });
        if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) {
          return null;
        }
        const data = (res as { data?: unknown }).data;
        const directId =
          data && typeof data === 'object' && 'listid' in data
            ? Number((data as { listid?: unknown }).listid)
            : NaN;
        await this.fetchUserPlaylists();
        if (Number.isFinite(directId) && directId > 0) {
          return directId;
        }
        // 兜底：从用户歌单中按 name + userId 反查最新创建的项
        const candidates = this.userPlaylists.filter(
          (p) =>
            p.name === name &&
            (p.listCreateUserid === currentUserId || p.listCreateUserid === undefined) &&
            p.source !== 2,
        );
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
        const found = candidates[0];
        return found.listid ?? (typeof found.id === 'number' ? found.id : null);
      } catch (e) {
        logger.error('PlaylistStore', 'Create playlist (returnId) error:', e);
        return null;
      }
    },
    async deleteOwnedPlaylist(listId: string | number | null | undefined) {
      if (listId === undefined || listId === null || String(listId) === '') return false;
      try {
        const targetId = this.resolveNumericListId(listId);
        if (targetId === null) return false;
        const res = await deletePlaylist(targetId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Delete owned playlist error:', e);
      }
      return false;
    },
    async favoritePlaylist(meta: PlaylistMeta, currentUserId?: number) {
      if (currentUserId && meta.listCreateUserid === currentUserId) return false;
      try {
        const res = await addPlaylist(meta.name, {
          type: 1,
          list_create_userid: meta.listCreateUserid,
          list_create_listid: meta.listCreateListid ?? meta.id,
          list_create_gid: meta.listCreateGid ?? meta.globalCollectionId,
          source: meta.source ?? 1,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Favorite playlist error:', e);
      }
      return false;
    },
    async favoriteAlbum(meta: { id: string | number; name: string; singerId?: number }) {
      try {
        const res = await addPlaylist(meta.name, {
          type: 1,
          list_create_userid: meta.singerId,
          list_create_listid: Number(meta.id),
          source: 2,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Favorite album error:', e);
      }
      return false;
    },
    async unfavoriteAlbum(albumId: string | number) {
      try {
        const targetId = String(albumId);
        const target = this.userPlaylists.find(
          (playlist) => playlist.source === 2 && includesPlaylistIdentity(playlist, targetId),
        );
        const listId = target?.listid ?? target?.id;
        if (!listId) return false;
        const res = await deletePlaylist(listId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Unfavorite album error:', e);
      }
      return false;
    },
    async unfavoritePlaylist(meta: PlaylistMeta, currentUserId?: number) {
      try {
        const target = this.userPlaylists.find((playlist) => {
          if (playlist.source === 2) return false;
          if (currentUserId && playlist.listCreateUserid === currentUserId) return false;
          const localId = String(playlist.listid ?? playlist.id);
          const originalId = String(playlist.listCreateGid ?? playlist.globalCollectionId ?? '');
          const originalListId = String(playlist.listCreateListid ?? '');
          const currentIds = [
            String(meta.id),
            String(meta.listid ?? ''),
            String(meta.listCreateListid ?? ''),
            String(meta.listCreateGid ?? ''),
            String(meta.globalCollectionId ?? ''),
          ];
          return (
            currentIds.includes(localId) ||
            (originalId && currentIds.includes(originalId)) ||
            (originalListId && currentIds.includes(originalListId))
          );
        });

        const listId = target?.listid ?? target?.id;
        if (!listId) return false;
        const res = await deletePlaylist(listId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Unfavorite playlist error:', e);
      }
      return false;
    },
  },
  persist: true,
});
