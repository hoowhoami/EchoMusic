import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';
import {
  DEFAULT_PLAYBACK_QUEUE_ID,
  MANUAL_PLAYBACK_QUEUE_ID,
  MAX_PLAYBACK_QUEUE_COUNT,
  PERSONAL_FM_QUEUE_ID,
} from './constants';
import { buildPlaybackQueueState } from './helpers';
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
  removePersonalFmQueue: (options?: { preserveBuffer?: boolean }) => void;
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
      if (this.defaultList.length > 0) this.defaultList = [];
      this.queueFilteredInvalidCount = 0;
      if (this.queuedNextTrackIds.length > 0) this.queuedNextTrackIds = [];
      return;
    }

    if (this.defaultList !== activeQueue.songs) {
      this.defaultList = activeQueue.songs;
    }
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
    while (nextQueues.length > limit && removable.length > 0) {
      const target = removable.shift();
      if (!target) break;
      const index = nextQueues.findIndex((queue) => queue.id === target.id);
      if (index >= 0) nextQueues.splice(index, 1);
    }

    this.playbackQueues = nextQueues;
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
          this.defaultList,
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
    this.playbackQueues.unshift(created);
    this.trimPlaybackQueues();
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
  },
  removePersonalFmQueue(this: QueueStoreShape, options?: { preserveBuffer?: boolean }) {
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
    if (previousActiveQueueId === PERSONAL_FM_QUEUE_ID && targetQueue.id !== PERSONAL_FM_QUEUE_ID) {
      this.removePersonalFmQueue();
      return;
    }
    this.trimPlaybackQueues();
    this.syncLegacyPlaybackState();
  },
  setPlaybackQueue(this: QueueStoreShape, songs: Song[], filteredInvalidCount = 0) {
    this.setPlaybackQueueWithOptions(songs, filteredInvalidCount);
  },
  clearPlaybackQueue(this: QueueStoreShape, queueId?: string | number) {
    const targetQueue = this.ensurePlaybackQueue(queueId != null ? String(queueId) : undefined);
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
  appendToPlaybackQueue(
    this: QueueStoreShape,
    songs: Song[],
    options: SetPlaybackQueueOptions = {},
  ) {
    if (songs.length === 0) return 0;
    const previousActiveQueueId = this.activeQueueId;
    const targetQueue = this.ensurePlaybackQueue(options.queueId, options);
    const nextList = targetQueue.songs.slice();
    let addedCount = 0;
    songs.forEach((song) => {
      if (nextList.some((item) => isSameSong(item, song) || String(item.id) === String(song.id))) {
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
    if (previousActiveQueueId === PERSONAL_FM_QUEUE_ID && targetQueue.id !== PERSONAL_FM_QUEUE_ID) {
      this.removePersonalFmQueue();
      return addedCount;
    }
    this.trimPlaybackQueues();
    this.syncLegacyPlaybackState();
    return addedCount;
  },
  removePlaybackQueue(this: QueueStoreShape, queueId: string | number) {
    this.hydratePlaybackQueues();
    const targetId = String(queueId ?? '');
    if (!targetId || targetId === MANUAL_PLAYBACK_QUEUE_ID) return;
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
  enqueuePlayNext(this: QueueStoreShape, songId: string | number) {
    const id = String(songId ?? '');
    if (!id) return;
    const targetQueue = this.ensurePlaybackQueue();
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    targetQueue.queuedNextTrackIds.unshift(id);
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
  },
  consumeQueuedNextTrackId(this: QueueStoreShape, songId: string | number) {
    const id = String(songId ?? '');
    const targetQueue = this.ensurePlaybackQueue();
    if (!id || targetQueue.queuedNextTrackIds.length === 0) return;
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((item) => item !== id);
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
  },
  peekQueuedNextTrackId(this: QueueStoreShape): string | null {
    const targetQueue = this.ensurePlaybackQueue();
    return targetQueue.queuedNextTrackIds[0] ?? null;
  },
  syncQueuedNextTrackIds(this: QueueStoreShape) {
    const targetQueue = this.ensurePlaybackQueue();
    if (targetQueue.queuedNextTrackIds.length === 0) return;
    const validIds = new Set(targetQueue.songs.map((song) => String(song.id)));
    targetQueue.queuedNextTrackIds = targetQueue.queuedNextTrackIds.filter((id) =>
      validIds.has(id),
    );
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
  },
  removeFromQueue(this: QueueStoreShape, songId: string | number, queueId?: string | number) {
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
    targetQueue.songs = nextList;
    targetQueue.updatedAt = Date.now();
    this.syncLegacyPlaybackState();
  },
};
