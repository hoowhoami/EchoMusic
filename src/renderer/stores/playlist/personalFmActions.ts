import { getPersonalFm, type PersonalFmParams } from '@/api/music';
import type { Song } from '@/models/song';
import { extractList } from '@/utils/extractors';
import logger from '@/utils/logger';
import { mapTopSong } from '@/utils/mappers';
import { PERSONAL_FM_MODE, PERSONAL_FM_QUEUE_ID } from './constants';
import {
  appendQueueSong,
  dedupeSongs,
  getPersonalFmModePresentation,
  getPersonalFmSongPoolPresentation,
  mergeQueueSongs,
  resolveSongNumericId,
  resolveSongQueueKey,
  toRawSongList,
} from './helpers';
import type { PersonalFmMode, PersonalFmSongPoolId, PlaybackQueueState } from './types';

let personalFmSessionResetPending = true;

type PersonalFmStoreShape = {
  activeQueueId: string;
  ensurePlaybackQueue: (
    queueId?: string,
    options?: {
      queueId?: string;
      title?: string;
      subtitle?: string;
      coverUrl?: string;
      type?: 'fm';
      dynamic?: boolean;
      meta?: Record<string, string | number | boolean | null | undefined>;
      activate?: boolean;
    },
  ) => PlaybackQueueState;
  fetchPersonalFmSongs: (params?: PersonalFmParams) => Promise<Song[]>;
  personalFmBuffer: Song[];
  personalFmMode: PersonalFmMode;
  personalFmSongPoolId: PersonalFmSongPoolId;
  playbackQueues: PlaybackQueueState[];
  persistQueueAppendToStorage: (queue: PlaybackQueueState, songs: Song[]) => void;
  removePersonalFmQueue: (options?: { preserveBuffer?: boolean }) => void;
  syncLegacyPlaybackState: () => void;
  ensurePersonalFmQueue: (options?: {
    track?: Song | null;
    playtime?: number;
    action?: 'play' | 'garbage';
    isOverplay?: boolean;
  }) => Promise<number>;
  updatePersonalFmMode: (mode: PersonalFmMode) => void;
};

const ensurePersonalFmPlaybackQueue = (store: PersonalFmStoreShape) => {
  const presentation = getPersonalFmModePresentation(store.personalFmMode);
  const songPoolPresentation = getPersonalFmSongPoolPresentation(store.personalFmSongPoolId);
  return store.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
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
};

const buildPersonalFmParams = (
  queue: PlaybackQueueState,
  track: Song | null,
  remainSongcnt: number,
  options?: {
    playtime?: number;
    action?: 'play' | 'garbage';
    isOverplay?: boolean;
  },
): PersonalFmParams => {
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

  return params;
};

export const personalFmActions = {
  getPersonalFmPreviewTrack(this: PersonalFmStoreShape) {
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
  getPersonalFmDisplayTracks(this: PersonalFmStoreShape, limit = 5) {
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
  updatePersonalFmMode(this: PersonalFmStoreShape, mode: PersonalFmMode) {
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
  updatePersonalFmSongPool(this: PersonalFmStoreShape, songPoolId?: PersonalFmSongPoolId | number) {
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
  async resetPersonalFmPreview(
    this: PersonalFmStoreShape & {
      updatePersonalFmSongPool: (songPoolId?: PersonalFmSongPoolId | number) => void;
    },
    options?: {
      mode?: PersonalFmMode;
      songPoolId?: PersonalFmSongPoolId | number;
      preserveQueue?: boolean;
    },
  ) {
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
      queue.songs = toRawSongList([]);
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

    this.personalFmBuffer = toRawSongList([]);

    try {
      const songs = await this.fetchPersonalFmSongs({
        mode: presentation.mode,
        song_pool_id: songPoolPresentation.songPoolId,
      });
      this.personalFmBuffer = toRawSongList(dedupeSongs(songs));
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
  async refreshPersonalFmPreview(this: PersonalFmStoreShape, mode?: PersonalFmMode) {
    const presentation = getPersonalFmModePresentation(mode ?? this.personalFmMode);
    this.updatePersonalFmMode(presentation.mode);
    try {
      const songs = await this.fetchPersonalFmSongs({
        mode: presentation.mode,
        song_pool_id: this.personalFmSongPoolId,
      });
      if (songs.length > 0) {
        this.personalFmBuffer = toRawSongList(dedupeSongs(songs));
      }
      return songs;
    } catch (error) {
      logger.warn('PlaylistStore', 'Refresh personal fm preview failed:', error);
      return [] as Song[];
    }
  },
  async fetchPersonalFmSongs(this: PersonalFmStoreShape, params: PersonalFmParams = {}) {
    const response = await getPersonalFm(params);
    return extractList(response).map((item) => mapTopSong(item));
  },
  async startPersonalFm(
    this: PersonalFmStoreShape,
    options?: {
      fresh?: boolean;
      mode?: PersonalFmMode;
      recreate?: boolean;
      retainBuffer?: boolean;
    },
  ) {
    const presentation = getPersonalFmModePresentation(options?.mode ?? this.personalFmMode);
    const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
    this.updatePersonalFmMode(presentation.mode);
    if (options?.recreate) {
      this.removePersonalFmQueue({ preserveBuffer: options.retainBuffer });
    }
    const queue = ensurePersonalFmPlaybackQueue(this);
    if (options?.fresh) {
      queue.songs = toRawSongList([]);
      queue.queuedNextTrackIds = [];
      queue.currentTrackId = null;
      queue.filteredInvalidCount = 0;
      queue.createdAt = Date.now();
      queue.updatedAt = queue.createdAt;
      if (!options.retainBuffer) {
        this.personalFmBuffer = toRawSongList([]);
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
    queue.songs = toRawSongList([]);
    queue.currentTrackId = null;
    queue.updatedAt = Date.now();
    this.personalFmBuffer = toRawSongList(dedupeSongs(songs));
    this.activeQueueId = queue.id;
    this.syncLegacyPlaybackState();
    personalFmSessionResetPending = false;
    return true;
  },
  activatePersonalFmTrack(this: PersonalFmStoreShape, song: Song) {
    const queue = ensurePersonalFmPlaybackQueue(this);
    const targetKey = resolveSongQueueKey(song);
    this.personalFmBuffer = toRawSongList(
      this.personalFmBuffer.filter((item) => resolveSongQueueKey(item) !== targetKey),
    );
    if (!queue.songs.some((item) => resolveSongQueueKey(item) === targetKey)) {
      queue.songs = toRawSongList([...queue.songs, song]);
    }
    queue.songCount = queue.songs.length;
    this.activeQueueId = queue.id;
    queue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    return queue.songs.slice();
  },
  async ensurePersonalFmQueue(
    this: PersonalFmStoreShape,
    options?: {
      track?: Song | null;
      playtime?: number;
      action?: 'play' | 'garbage';
      isOverplay?: boolean;
    },
  ) {
    const queue = ensurePersonalFmPlaybackQueue(this);
    const track =
      options?.track ??
      queue.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
      null;
    const remainSongcnt = this.personalFmBuffer.length;
    const shouldTopUpBuffer = remainSongcnt <= 4;
    if (!shouldTopUpBuffer && options?.action !== 'garbage') return 0;

    const params = buildPersonalFmParams(queue, track, remainSongcnt, options);

    try {
      const nextSongs = await this.fetchPersonalFmSongs(params);
      if (nextSongs.length === 0 || !shouldTopUpBuffer) return 0;
      this.personalFmBuffer = toRawSongList(mergeQueueSongs(this.personalFmBuffer, nextSongs));
      return nextSongs.length;
    } catch (error) {
      logger.warn('PlaylistStore', 'Fetch personal fm songs failed:', error);
      return 0;
    }
  },
  async consumeNextPersonalFmTrack(
    this: PersonalFmStoreShape,
    options?: {
      track?: Song | null;
      playtime?: number;
      action?: 'play' | 'garbage';
      isOverplay?: boolean;
    },
  ) {
    const queue = ensurePersonalFmPlaybackQueue(this);

    if (this.personalFmBuffer.length === 0) {
      await this.ensurePersonalFmQueue(options);
    }

    while (this.personalFmBuffer.length > 0) {
      const [nextSong, ...rest] = this.personalFmBuffer;
      this.personalFmBuffer = toRawSongList(rest);
      if (!nextSong) break;
      const appended = appendQueueSong(queue, nextSong);
      queue.songCount = queue.songs.length;
      this.activeQueueId = queue.id;
      queue.updatedAt = Date.now();
      this.syncLegacyPlaybackState();
      if (appended) this.persistQueueAppendToStorage(queue, [nextSong]);
      return nextSong;
    }

    return null;
  },
};
