import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';
import {
  DEFAULT_PLAYBACK_QUEUE_ID,
  MANUAL_PLAYBACK_QUEUE_ID,
  MAX_PLAYBACK_QUEUE_COUNT,
  PERSONAL_FM_QUEUE_ID,
} from './constants';
import { buildPlaybackQueueState, normalizePlaybackQueueRuntime, toRawSongList } from './helpers';
import type { PlaybackQueueState, SetPlaybackQueueOptions } from './types';

type QueueStoreShape = {
  activeQueueId: string;
  defaultList: Song[];
  ensurePlaybackQueue: (queueId?: string, options?: SetPlaybackQueueOptions) => PlaybackQueueState;
  hydratePlaybackQueues: () => void;
  lastNonFmQueueId: string;
  markLastNonFmQueue: (queueId: string | number | null | undefined) => void;
  personalFmBuffer: Song[];
  playbackQueues: PlaybackQueueState[];
  queueFilteredInvalidCount: number;
  queuedNextTrackIds: string[];
  persistQueueAppendToStorage: (queue: PlaybackQueueState, songs: Song[]) => void;
  persistQueueClearToStorage: (queue: PlaybackQueueState) => void;
  removePersonalFmQueue: (options?: { preserveBuffer?: boolean }) => void;
  persistQueueItemRemovalToStorage: (queue: PlaybackQueueState, songId: string | number) => void;
  persistQueueMetaToStorage: (queue: PlaybackQueueState) => void;
  persistQueueRemovalToStorage: (queueId: string) => void;
  persistQueueReorderToStorage: (queue: PlaybackQueueState) => void;
  persistQueueToStorage: (queue: PlaybackQueueState) => void;
  persistQueueCurrentTrackToStorage: (queueId: string, trackId: string | null) => void;
  setPlaybackQueueWithOptions: (
    songs: Song[],
    filteredInvalidCount?: number,
    options?: SetPlaybackQueueOptions,
  ) => void;
  syncLegacyPlaybackState: () => void;
  trimPlaybackQueues: (limit?: number) => void;
};

export const queueActions = {
  getPreferredManualQueueOptions(this: QueueStoreShape, options: SetPlaybackQueueOptions = {}) {
    if (options.queueId) return { ...options };

    const activeQueue =
      this.playbackQueues.find((queue) => queue.id === this.activeQueueId) ??
      this.playbackQueues.find((queue) => queue.id === this.activeQueueId) ??
      null;

    if (activeQueue && activeQueue.id !== PERSONAL_FM_QUEUE_ID) {
      this.markLastNonFmQueue(activeQueue.id);
      return { ...options, queueId: activeQueue.id };
    }

    const fallbackQueue =
      this.playbackQueues.find((queue) => queue.id === this.lastNonFmQueueId) ??
      this.playbackQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID) ??
      null;

    if (!fallbackQueue) {
      return { ...options, queueId: DEFAULT_PLAYBACK_QUEUE_ID };
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
  getPlaybackQueueSongs(this: QueueStoreShape, queueId?: string | number | null) {
    const resolvedId = String(queueId ?? '');
    if (!resolvedId) return [];
    const queue = this.playbackQueues.find((item) => item.id === resolvedId);
    return queue?.songs.slice() ?? [];
  },
  syncLegacyPlaybackState(this: QueueStoreShape) {
    const activeQueue =
      this.playbackQueues.find((queue) => queue.id === this.activeQueueId) ??
      this.playbackQueues[0] ??
      null;

    if (!activeQueue) {
      if (this.defaultList.length > 0) this.defaultList = toRawSongList([]);
      this.queueFilteredInvalidCount = 0;
      if (this.queuedNextTrackIds.length > 0) this.queuedNextTrackIds = [];
      return;
    }

    if (this.defaultList !== activeQueue.songs) {
      this.defaultList = activeQueue.songs;
    }
    activeQueue.songCount = Math.max(activeQueue.songCount ?? 0, activeQueue.songs.length);
    this.queueFilteredInvalidCount = Math.max(0, activeQueue.filteredInvalidCount);
    if (this.queuedNextTrackIds !== activeQueue.queuedNextTrackIds) {
      this.queuedNextTrackIds = activeQueue.queuedNextTrackIds;
    }
    this.markLastNonFmQueue(activeQueue.id);
  },
  trimPlaybackQueues(this: QueueStoreShape, limit = MAX_PLAYBACK_QUEUE_COUNT) {
    if (this.playbackQueues.length <= limit) return;
    const protectedIds = new Set<string>([this.activeQueueId, DEFAULT_PLAYBACK_QUEUE_ID]);
    const removable = this.playbackQueues
      .filter((queue) => !protectedIds.has(queue.id))
      .sort((left, right) => left.createdAt - right.createdAt || left.updatedAt - right.updatedAt);

    const nextQueues = this.playbackQueues.slice();
    const removedIds: string[] = [];
    while (nextQueues.length > limit && removable.length > 0) {
      const target = removable.shift();
      if (!target) break;
      const index = nextQueues.findIndex((queue) => queue.id === target.id);
      if (index >= 0) {
        nextQueues.splice(index, 1);
        removedIds.push(target.id);
      }
    }

    this.playbackQueues = nextQueues.map(normalizePlaybackQueueRuntime);
    removedIds.forEach((id) => this.persistQueueRemovalToStorage(id));
  },
  hydratePlaybackQueues(this: QueueStoreShape) {
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
          toRawSongList(this.defaultList),
          this.queueFilteredInvalidCount,
        ),
        queuedNextTrackIds: this.queuedNextTrackIds.slice(),
      },
    ];
    this.activeQueueId = this.playbackQueues[0].id;
    this.syncLegacyPlaybackState();
  },
  ensurePlaybackQueue(
    this: QueueStoreShape,
    queueId?: string,
    options: SetPlaybackQueueOptions = {},
  ) {
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
    this.playbackQueues.unshift(normalizePlaybackQueueRuntime(created));
    this.trimPlaybackQueues();
    this.persistQueueMetaToStorage(created);
    return created;
  },
  setActiveQueue(this: QueueStoreShape, queueId: string | number) {
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
    this.persistQueueMetaToStorage(matched);
  },
  removePersonalFmQueue(this: QueueStoreShape, options?: { preserveBuffer?: boolean }) {
    const nextQueues = this.playbackQueues.filter((queue) => queue.id !== PERSONAL_FM_QUEUE_ID);
    this.playbackQueues = nextQueues.map(normalizePlaybackQueueRuntime);
    if (this.activeQueueId === PERSONAL_FM_QUEUE_ID) {
      const fallbackQueue =
        nextQueues.find((queue) => queue.id === this.lastNonFmQueueId) ??
        nextQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID) ??
        nextQueues[0] ??
        null;
      this.activeQueueId = fallbackQueue?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
    }
    if (!options?.preserveBuffer) {
      this.personalFmBuffer = toRawSongList([]);
    }
    this.syncLegacyPlaybackState();
    const activeQueue = this.playbackQueues.find((queue) => queue.id === this.activeQueueId);
    if (activeQueue) this.persistQueueMetaToStorage(activeQueue);
    this.persistQueueRemovalToStorage(PERSONAL_FM_QUEUE_ID);
  },
  getQueueById(this: QueueStoreShape, queueId?: string | number | null) {
    const resolvedId = String(queueId ?? '');
    if (!resolvedId) return null;
    return this.playbackQueues.find((item) => item.id === resolvedId) ?? null;
  },
  updateQueueCurrentTrack(
    this: QueueStoreShape,
    songId: string | number | null | undefined,
    queueId?: string,
  ) {
    const targetQueue = this.ensurePlaybackQueue(queueId);
    targetQueue.currentTrackId =
      songId === undefined || songId === null || String(songId) === '' ? null : String(songId);
    targetQueue.updatedAt = Date.now();
    if (targetQueue.id === this.activeQueueId) {
      this.syncLegacyPlaybackState();
    }
    this.persistQueueCurrentTrackToStorage(targetQueue.id, targetQueue.currentTrackId);
  },
  getQueueRemainingSongCount(this: QueueStoreShape, queueId?: string, trackId?: string | null) {
    const targetQueue = this.ensurePlaybackQueue(queueId);
    const currentTrackId = String(trackId ?? targetQueue.currentTrackId ?? '');
    if (!currentTrackId) return targetQueue.songs.length;
    const currentIndex = targetQueue.songs.findIndex((song) => String(song.id) === currentTrackId);
    if (currentIndex === -1) return targetQueue.songs.length;
    return Math.max(0, targetQueue.songs.length - currentIndex - 1);
  },
  setPlaybackQueueWithOptions(
    this: QueueStoreShape,
    songs: Song[],
    filteredInvalidCount = 0,
    options: SetPlaybackQueueOptions = {},
  ) {
    const previousActiveQueueId = this.activeQueueId;
    const targetQueue = this.ensurePlaybackQueue(options.queueId, options);
    const previousSongs = targetQueue.songs;
    targetQueue.songs = toRawSongList(songs);
    targetQueue.songCount = targetQueue.songs.length;
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
    const shouldActivate = options.activate !== false;
    if (shouldActivate) {
      this.activeQueueId = targetQueue.id;
      this.markLastNonFmQueue(targetQueue.id);
    }
    if (
      shouldActivate &&
      previousActiveQueueId === PERSONAL_FM_QUEUE_ID &&
      targetQueue.id !== PERSONAL_FM_QUEUE_ID
    ) {
      this.removePersonalFmQueue();
      return;
    }
    this.trimPlaybackQueues();
    this.syncLegacyPlaybackState();
    const canAppend =
      previousSongs.length > 0 &&
      songs.length > previousSongs.length &&
      previousSongs.every((song, index) => String(song.id) === String(songs[index]?.id));
    if (canAppend) this.persistQueueAppendToStorage(targetQueue, songs.slice(previousSongs.length));
    else this.persistQueueToStorage(targetQueue);
  },
  setPlaybackQueue(this: QueueStoreShape, songs: Song[], filteredInvalidCount = 0) {
    this.setPlaybackQueueWithOptions(songs, filteredInvalidCount);
  },
  clearPlaybackQueue(this: QueueStoreShape, queueId?: string | number) {
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    targetQueue.songs = toRawSongList([]);
    targetQueue.songCount = 0;
    targetQueue.filteredInvalidCount = 0;
    targetQueue.queuedNextTrackIds = [];
    targetQueue.currentTrackId = null;
    if (targetQueue.id === PERSONAL_FM_QUEUE_ID) {
      this.personalFmBuffer = toRawSongList([]);
    }
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueClearToStorage(targetQueue);
  },
  appendToPlaybackQueue(
    this: QueueStoreShape,
    songs: Song[],
    options: SetPlaybackQueueOptions = {},
  ) {
    if (songs.length === 0) return 0;
    const previousActiveQueueId = this.activeQueueId;
    const targetQueue = this.ensurePlaybackQueue(options.queueId, options);
    const shouldActivate =
      options.activate !== false &&
      (options.activate === true ||
        previousActiveQueueId !== PERSONAL_FM_QUEUE_ID ||
        targetQueue.id === PERSONAL_FM_QUEUE_ID);
    if (targetQueue.songs.length === 0 && (targetQueue.songCount ?? 0) > 0) {
      const incoming = songs.filter(
        (song, index, list) => list.findIndex((item) => isSameSong(item, song)) === index,
      );
      if (incoming.length === 0) return 0;
      targetQueue.songCount = Math.max(0, targetQueue.songCount ?? 0) + incoming.length;
      targetQueue.title = options.title?.trim() || targetQueue.title || '播放列表';
      targetQueue.subtitle = options.subtitle?.trim() ?? targetQueue.subtitle;
      targetQueue.coverUrl = options.coverUrl?.trim() ?? targetQueue.coverUrl;
      targetQueue.type = options.type ?? targetQueue.type;
      targetQueue.dynamic = options.dynamic ?? targetQueue.dynamic;
      targetQueue.meta = options.meta ? { ...targetQueue.meta, ...options.meta } : targetQueue.meta;
      targetQueue.updatedAt = Date.now();
      if (shouldActivate) {
        this.activeQueueId = targetQueue.id;
        this.markLastNonFmQueue(targetQueue.id);
      }
      if (
        shouldActivate &&
        previousActiveQueueId === PERSONAL_FM_QUEUE_ID &&
        targetQueue.id !== PERSONAL_FM_QUEUE_ID
      ) {
        this.removePersonalFmQueue();
        return incoming.length;
      }
      this.syncLegacyPlaybackState();
      this.persistQueueAppendToStorage(targetQueue, incoming);
      return incoming.length;
    }
    const nextList = targetQueue.songs.slice();
    const addedSongs: Song[] = [];
    let addedCount = 0;
    songs.forEach((song) => {
      if (nextList.some((item) => isSameSong(item, song) || String(item.id) === String(song.id))) {
        return;
      }
      nextList.push(song);
      addedSongs.push(song);
      addedCount += 1;
    });
    if (addedCount === 0) return 0;
    targetQueue.songs = toRawSongList(nextList);
    targetQueue.songCount = nextList.length;
    targetQueue.title = options.title?.trim() || targetQueue.title || '播放列表';
    targetQueue.subtitle = options.subtitle?.trim() ?? targetQueue.subtitle;
    targetQueue.coverUrl = options.coverUrl?.trim() ?? targetQueue.coverUrl;
    targetQueue.type = options.type ?? targetQueue.type;
    targetQueue.dynamic = options.dynamic ?? targetQueue.dynamic;
    targetQueue.meta = options.meta ? { ...targetQueue.meta, ...options.meta } : targetQueue.meta;
    targetQueue.updatedAt = Date.now();
    if (shouldActivate) {
      this.activeQueueId = targetQueue.id;
      this.markLastNonFmQueue(targetQueue.id);
    }
    if (
      shouldActivate &&
      previousActiveQueueId === PERSONAL_FM_QUEUE_ID &&
      targetQueue.id !== PERSONAL_FM_QUEUE_ID
    ) {
      this.removePersonalFmQueue();
      return addedCount;
    }
    this.trimPlaybackQueues();
    this.syncLegacyPlaybackState();
    this.persistQueueAppendToStorage(targetQueue, addedSongs);
    return addedCount;
  },
  removePlaybackQueue(this: QueueStoreShape, queueId: string | number) {
    this.hydratePlaybackQueues();
    const targetId = String(queueId ?? '');
    if (!targetId || targetId === MANUAL_PLAYBACK_QUEUE_ID) return;
    const nextQueues = this.playbackQueues.filter((queue) => queue.id !== targetId);
    if (nextQueues.length === this.playbackQueues.length) return;
    this.playbackQueues = nextQueues.map(normalizePlaybackQueueRuntime);
    if (this.activeQueueId === targetId) {
      this.activeQueueId = nextQueues[0]?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
    }
    if (this.lastNonFmQueueId === targetId) {
      const fallbackQueue = nextQueues.find((queue) => queue.id !== PERSONAL_FM_QUEUE_ID);
      this.lastNonFmQueueId = fallbackQueue?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
    }
    this.syncLegacyPlaybackState();
    this.persistQueueRemovalToStorage(targetId);
  },
  enqueuePlayNext(this: QueueStoreShape, songId: string | number, queueId?: string | number) {
    const id = String(songId ?? '');
    if (!id) return;
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    targetQueue.queuedNextTrackIds.unshift(id);
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueMetaToStorage(targetQueue);
  },
  enqueuePlayNextSequential(
    this: QueueStoreShape,
    songId: string | number,
    queueId?: string | number,
  ) {
    const id = String(songId ?? '');
    if (!id) return;
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    targetQueue.queuedNextTrackIds.push(id);
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueMetaToStorage(targetQueue);
  },
  consumeQueuedNextTrackId(
    this: QueueStoreShape,
    songId: string | number,
    queueId?: string | number,
  ) {
    const id = String(songId ?? '');
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    if (!id || targetQueue.queuedNextTrackIds.length === 0) return;
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueMetaToStorage(targetQueue);
  },
  peekQueuedNextTrackId(this: QueueStoreShape, queueId?: string | number): string | null {
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    return targetQueue.queuedNextTrackIds[0] ?? null;
  },
  syncQueuedNextTrackIds(this: QueueStoreShape, queueId?: string | number) {
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    if (targetQueue.queuedNextTrackIds.length === 0) return;
    const validIds = new Set(targetQueue.songs.map((song) => String(song.id)));
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((id) =>
      validIds.has(id),
    );
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueMetaToStorage(targetQueue);
  },
  removeFromQueue(this: QueueStoreShape, songId: string | number, queueId?: string | number) {
    const id = String(songId ?? '');
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    targetQueue.songs = toRawSongList(targetQueue.songs.filter((song) => String(song.id) !== id));
    targetQueue.songCount = targetQueue.songs.length;
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    if (targetQueue.currentTrackId === id) {
      targetQueue.currentTrackId = null;
    }
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueItemRemovalToStorage(targetQueue, id);
  },
  reorderPlaybackQueue(
    this: QueueStoreShape,
    fromIndex: number,
    toIndex: number,
    queueId?: string | number,
  ) {
    if (fromIndex === toIndex) return;
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
    if (fromIndex < 0 || fromIndex >= targetQueue.songs.length) return;

    const nextList = targetQueue.songs.slice();
    const [movedSong] = nextList.splice(fromIndex, 1);
    if (!movedSong) return;

    const normalizedTarget = Math.max(0, Math.min(toIndex, nextList.length));
    nextList.splice(normalizedTarget, 0, movedSong);
    targetQueue.songs = toRawSongList(nextList);
    targetQueue.songCount = nextList.length;
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
    this.persistQueueReorderToStorage(targetQueue);
  },
};
