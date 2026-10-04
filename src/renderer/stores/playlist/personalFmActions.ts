import { getPersonalFm, type PersonalFmParams } from '@/api/music';
import type { Song } from '@/models/song';
import { extractList } from '@/utils/extractors';
import logger from '@/utils/logger';
import { captureUserSession } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import { isPlayableSong } from '@/utils/song';
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
import type {
  PersonalFmAction,
  PersonalFmMode,
  PersonalFmSongPoolId,
  PlaybackQueueState,
} from './types';

let personalFmSessionResetPending = true;

export type PersonalFmCandidate = {
  sessionEpoch: number;
  occurrence: string;
  key: string;
  track: Song;
  origin: 'buffer' | 'history';
};

const fmRequests = new WeakMap<
  object,
  { epoch: number; isCurrent: () => boolean; promise: Promise<number> }
>();
const fmStarts = new WeakMap<object, { isCurrent: () => boolean; promise: Promise<boolean> }>();
const fmRefillAfter = new WeakMap<
  object,
  { epoch: number; isCurrent: () => boolean; time: number }
>();
const fmCommits = new WeakMap<object, Set<string>>();
const fmFeedback = new WeakMap<object, Set<string>>();
const rememberOnce = (ledger: WeakMap<object, Set<string>>, store: object, key: string) => {
  let keys = ledger.get(store);
  if (!keys) ledger.set(store, (keys = new Set()));
  if (keys.has(key)) return false;
  keys.add(key);
  if (keys.size > 128) keys.delete(keys.values().next().value!);
  return true;
};

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
  personalFmSessionEpoch: number;
  personalFmMode: PersonalFmMode;
  personalFmSongPoolId: PersonalFmSongPoolId;
  playbackQueues: PlaybackQueueState[];
  persistPersonalFmPreferences: () => void;
  persistQueueAppendToStorage: (queue: PlaybackQueueState, songs: Song[]) => void;
  removePersonalFmQueue: (options?: { preserveBuffer?: boolean }) => void;
  reportPersonalFmFeedback: (action: PersonalFmAction, track?: Song | null) => Promise<number>;
  syncLegacyPlaybackState: () => void;
  ensurePersonalFmQueue: (options?: {
    track?: Song | null;
    playtime?: number;
    action?: PersonalFmAction;
    isOverplay?: boolean;
  }) => Promise<number>;
  updatePersonalFmMode: (mode: PersonalFmMode) => void;
};

const captureFmRequest = (store: PersonalFmStoreShape) => {
  const epoch = store.personalFmSessionEpoch;
  const isSessionCurrent = captureUserSession(useUserStore());
  return () => epoch === store.personalFmSessionEpoch && isSessionCurrent();
};

const ensurePersonalFmPlaybackQueue = (store: PersonalFmStoreShape) => {
  const existing = store.playbackQueues.find((queue) => queue.id === PERSONAL_FM_QUEUE_ID);
  if (existing) return existing;
  const presentation = getPersonalFmModePresentation(store.personalFmMode);
  const songPoolPresentation = getPersonalFmSongPoolPresentation(store.personalFmSongPoolId);
  store.ensurePlaybackQueue(PERSONAL_FM_QUEUE_ID, {
    queueId: PERSONAL_FM_QUEUE_ID,
    title: presentation.title,
    subtitle: '',
    type: 'fm',
    dynamic: true,
    meta: {
      mode: presentation.mode,
      song_pool_id: songPoolPresentation.songPoolId,
    },
  });
  // 创建时 ensurePlaybackQueue 返回原对象；后续读写使用 store 中的响应式实例。
  return store.playbackQueues.find((queue) => queue.id === PERSONAL_FM_QUEUE_ID)!;
};

const resolvePersonalFmCurMark = (track: Song | null | undefined): string => {
  const mark = String(track?.curMark ?? '').trim();
  return mark;
};

const isCurrentPersonalFmTrack = (queue: PlaybackQueueState | undefined, track: Song | null) => {
  if (!queue || !track) return false;
  const currentId = String(queue.currentTrackId ?? '');
  if (currentId && String(track.id) === currentId) return true;
  const current = queue.songs.find((song) => String(song.id) === currentId);
  return current ? resolveSongQueueKey(current) === resolveSongQueueKey(track) : false;
};

const buildPersonalFmParams = (
  queue: Pick<PlaybackQueueState, 'meta'>,
  track: Song | null,
  remainSongcnt: number,
  options?: {
    playtime?: number;
    action?: PersonalFmAction;
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
    const curMark = resolvePersonalFmCurMark(track);
    if (curMark) params.cur_mark = curMark;
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
  peekNextPersonalFmCandidate(
    this: PersonalFmStoreShape,
    currentTrackId: string | null,
    occurrence: string,
    selected?: Song,
  ): PersonalFmCandidate | null {
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    const index = queue?.songs.findIndex((song) => String(song.id) === currentTrackId) ?? -1;
    const history = index >= 0 ? queue!.songs.slice(index + 1).find(isPlayableSong) : undefined;
    const track =
      selected ??
      history ??
      this.personalFmBuffer.find(
        (song) => String(song.id) !== currentTrackId && isPlayableSong(song),
      );
    if (!track || !isPlayableSong(track)) return null;
    const key = resolveSongQueueKey(track);
    const inBuffer = this.personalFmBuffer.some((song) => resolveSongQueueKey(song) === key);
    const inHistory = queue?.songs.some((song) => resolveSongQueueKey(song) === key);
    if (!inBuffer && !inHistory) return null;
    return {
      sessionEpoch: this.personalFmSessionEpoch,
      occurrence,
      key,
      track,
      origin: (selected ? inHistory : track === history) ? 'history' : 'buffer',
    };
  },
  commitPersonalFmCandidate(this: PersonalFmStoreShape, candidate: PersonalFmCandidate) {
    if (candidate.sessionEpoch !== this.personalFmSessionEpoch) return null;
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    if (!queue) return null;
    const source = candidate.origin === 'buffer' ? this.personalFmBuffer : queue.songs;
    if (!source.some((song) => resolveSongQueueKey(song) === candidate.key)) return null;
    if (
      !rememberOnce(
        fmCommits,
        this,
        `${candidate.sessionEpoch}|${candidate.occurrence}|${candidate.key}`,
      )
    )
      return null;
    if (candidate.origin === 'buffer') {
      this.personalFmBuffer = toRawSongList(
        this.personalFmBuffer.filter((song) => resolveSongQueueKey(song) !== candidate.key),
      );
    }
    const appended = appendQueueSong(queue, candidate.track);
    this.activeQueueId = queue.id;
    queue.currentTrackId = String(candidate.track.id);
    queue.songCount = queue.songs.length;
    queue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    if (appended) this.persistQueueAppendToStorage(queue, [candidate.track]);
    return queue.songs.slice();
  },
  skipFailedPersonalFmCandidate(this: PersonalFmStoreShape, candidate: PersonalFmCandidate) {
    if (candidate.sessionEpoch !== this.personalFmSessionEpoch) return;
    this.personalFmBuffer = toRawSongList(
      this.personalFmBuffer.filter((song) => resolveSongQueueKey(song) !== candidate.key),
    );
    if (candidate.origin !== 'history') return;
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    if (!queue) return;
    const currentId = String(queue.currentTrackId ?? '');
    queue.songs = toRawSongList(
      queue.songs.filter(
        (song) => resolveSongQueueKey(song) !== candidate.key || String(song.id) === currentId,
      ),
    );
    queue.songCount = queue.songs.length;
    queue.updatedAt = Date.now();
  },
  replenishPersonalFmBuffer(this: PersonalFmStoreShape): Promise<number> {
    if (this.personalFmBuffer.filter(isPlayableSong).length > 4) return Promise.resolve(0);
    const epoch = this.personalFmSessionEpoch;
    const pending = fmRequests.get(this);
    if (pending?.epoch === epoch && pending.isCurrent()) return pending.promise;
    const retry = fmRefillAfter.get(this);
    if (retry?.epoch === epoch && retry.isCurrent() && Date.now() < retry.time)
      return Promise.resolve(0);
    const isCurrent = captureFmRequest(this);
    const promise = this.fetchPersonalFmSongs({
      mode: this.personalFmMode,
      song_pool_id: this.personalFmSongPoolId,
    })
      .then((songs) => {
        if (!isCurrent()) return 0;
        this.personalFmBuffer = toRawSongList(mergeQueueSongs(this.personalFmBuffer, songs));
        return songs.length;
      })
      .catch((error) => {
        logger.warn('PlaylistStore', 'Replenish personal fm failed:', error);
        return 0;
      })
      .finally(() => {
        if (fmRequests.get(this)?.promise === promise) {
          fmRequests.delete(this);
          if (isCurrent()) fmRefillAfter.set(this, { epoch, isCurrent, time: Date.now() + 5_000 });
        }
      });
    fmRequests.set(this, { epoch, isCurrent, promise });
    return promise;
  },
  reportPersonalFmAdvance(
    this: PersonalFmStoreShape,
    occurrence: string,
    options: {
      track: Song | null;
      playtime: number;
      action?: PersonalFmAction;
      isOverplay: boolean;
    },
  ): Promise<number> {
    const epoch = this.personalFmSessionEpoch;
    const isCurrent = captureFmRequest(this);
    if (!rememberOnce(fmFeedback, this, `${epoch}|${occurrence}`)) return Promise.resolve(0);
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    if (!queue) return Promise.resolve(0);
    return this.fetchPersonalFmSongs(
      buildPersonalFmParams(queue, options.track, this.personalFmBuffer.length, options),
    )
      .then((songs) => {
        if (!isCurrent()) return 0;
        this.personalFmBuffer = toRawSongList(mergeQueueSongs(this.personalFmBuffer, songs));
        return songs.length;
      })
      .catch((error) => {
        logger.warn('PlaylistStore', 'Report personal fm advance failed:', error);
        return 0;
      });
  },
  reportPersonalFmFeedback(
    this: PersonalFmStoreShape,
    action: PersonalFmAction,
    track?: Song | null,
  ): Promise<number> {
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    const target =
      track ??
      queue?.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
      null;
    if (!queue || !target || !isCurrentPersonalFmTrack(queue, target)) return Promise.resolve(0);
    const current =
      queue.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ?? target;
    const marked = resolvePersonalFmCurMark(target)
      ? target
      : { ...target, curMark: current.curMark };
    const isCurrent = captureFmRequest(this);
    return this.fetchPersonalFmSongs(
      buildPersonalFmParams(queue, marked, this.personalFmBuffer.length, { action }),
    )
      .then((songs) => {
        if (!isCurrent()) return 0;
        if (songs.length === 0) return 0;
        this.personalFmBuffer = toRawSongList(mergeQueueSongs(this.personalFmBuffer, songs));
        return songs.length;
      })
      .catch((error) => {
        logger.warn('PlaylistStore', 'Report personal fm feedback failed:', error);
        return 0;
      });
  },
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
    if (this.personalFmMode !== presentation.mode) this.personalFmSessionEpoch++;
    this.personalFmMode = presentation.mode;
    this.persistPersonalFmPreferences();
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID);
    if (queue) {
      queue.title = presentation.title;
      queue.subtitle = '';
      queue.meta = {
        ...queue.meta,
        mode: presentation.mode,
      };
      queue.updatedAt = Date.now();
    }
  },
  updatePersonalFmSongPool(this: PersonalFmStoreShape, songPoolId?: PersonalFmSongPoolId | number) {
    const presentation = getPersonalFmSongPoolPresentation(songPoolId);
    if (this.personalFmSongPoolId !== presentation.songPoolId) this.personalFmSessionEpoch++;
    this.personalFmSongPoolId = presentation.songPoolId;
    this.persistPersonalFmPreferences();
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
      action?: PersonalFmAction;
    },
  ) {
    const previousMode = this.personalFmMode;
    const previousPool = this.personalFmSongPoolId;
    const presentation = getPersonalFmModePresentation(options?.mode ?? previousMode);
    const songPoolPresentation = getPersonalFmSongPoolPresentation(
      options?.songPoolId ?? previousPool,
    );
    this.personalFmSessionEpoch++;
    this.personalFmMode = presentation.mode;
    this.personalFmSongPoolId = songPoolPresentation.songPoolId;
    this.persistPersonalFmPreferences();
    const isRequestCurrent = captureFmRequest(this);
    const queue = this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID) ?? null;
    const isCurrent = () =>
      isRequestCurrent() &&
      (this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID) ?? null) === queue;
    const action = options?.action ?? 'login';
    const currentTrack =
      action === 'change_song_pool'
        ? (queue?.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
          this.personalFmBuffer[0] ??
          null)
        : null;
    try {
      const songs = await this.fetchPersonalFmSongs(
        buildPersonalFmParams(
          {
            meta: {
              mode: presentation.mode,
              song_pool_id: songPoolPresentation.songPoolId,
            },
          },
          currentTrack,
          0,
          { action },
        ),
      );
      if (!isCurrent()) return null;
      if (queue && !options?.preserveQueue) {
        queue.title = presentation.title;
        queue.subtitle = '';
        queue.songs = toRawSongList([]);
        queue.songCount = 0;
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
      this.personalFmBuffer = toRawSongList(dedupeSongs(songs));
      if (!options?.preserveQueue) personalFmSessionResetPending = false;
      if (queue && this.activeQueueId === queue.id) this.syncLegacyPlaybackState();
      return this.personalFmBuffer[0] ?? null;
    } catch (error) {
      if (isCurrent()) {
        this.personalFmMode = previousMode;
        this.personalFmSongPoolId = previousPool;
        this.persistPersonalFmPreferences();
        logger.warn('PlaylistStore', 'Reset personal fm preview failed:', error);
      }
      return null;
    }
  },

  async refreshPersonalFmPreview(this: PersonalFmStoreShape, mode?: PersonalFmMode) {
    const presentation = getPersonalFmModePresentation(mode ?? this.personalFmMode);
    this.updatePersonalFmMode(presentation.mode);
    this.personalFmSessionEpoch++;
    const isCurrent = captureFmRequest(this);
    try {
      const songs = await this.fetchPersonalFmSongs({
        mode: presentation.mode,
        song_pool_id: this.personalFmSongPoolId,
        action: 'login',
        remain_songcnt: 0,
      });
      if (!isCurrent()) return [];
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
    const isCurrent = captureFmRequest(this);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      getPersonalFm(params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Personal FM request timed out')), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!isCurrent()) return [];

    return extractList(response).map((item) => mapTopSong(item));
  },
  async startPersonalFm(
    this: PersonalFmStoreShape,
    options?: {
      fresh?: boolean;
      mode?: PersonalFmMode;
      recreate?: boolean;
      retainBuffer?: boolean;
      isCurrent?: () => boolean;
    },
  ) {
    if (options?.isCurrent && !options.isCurrent()) return false;
    const presentation = getPersonalFmModePresentation(options?.mode ?? this.personalFmMode);
    const songPoolPresentation = getPersonalFmSongPoolPresentation(this.personalFmSongPoolId);
    this.updatePersonalFmMode(presentation.mode);
    if (options?.recreate) {
      this.removePersonalFmQueue({ preserveBuffer: options.retainBuffer });
    }
    const queue = ensurePersonalFmPlaybackQueue(this);
    if (options?.fresh) {
      this.personalFmSessionEpoch++;
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
    const activeQueueId = this.activeQueueId;
    const isRequestCurrent = captureFmRequest(this);
    const isCurrent = () =>
      isRequestCurrent() &&
      (!options?.isCurrent || options.isCurrent()) &&
      this.activeQueueId === activeQueueId &&
      this.playbackQueues.find((item) => item.id === PERSONAL_FM_QUEUE_ID) === queue;
    const pending = fmStarts.get(this);
    if (pending?.isCurrent()) return pending.promise;
    const promise = (async () => {
      const songs = await this.fetchPersonalFmSongs({
        mode: presentation.mode,
        song_pool_id: songPoolPresentation.songPoolId,
        action: 'login',
        remain_songcnt: 0,
      });
      if (!isCurrent() || songs.length === 0) return false;
      queue.songs = toRawSongList([]);
      queue.songCount = 0;
      queue.currentTrackId = null;
      queue.updatedAt = Date.now();
      this.personalFmBuffer = toRawSongList(dedupeSongs(songs));
      this.activeQueueId = queue.id;
      this.syncLegacyPlaybackState();
      personalFmSessionResetPending = false;
      return true;
    })().finally(() => {
      if (fmStarts.get(this)?.promise === promise) fmStarts.delete(this);
    });
    fmStarts.set(this, { isCurrent, promise });
    return promise;
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
      action?: PersonalFmAction;
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
    const isCurrent = captureFmRequest(this);

    try {
      const nextSongs = await this.fetchPersonalFmSongs(params);
      if (!isCurrent()) return 0;
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
      action?: PersonalFmAction;
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
