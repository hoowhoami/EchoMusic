import type { Song } from '@/models/song';
import type { PlaybackResumeScope, SetPlaybackQueueOptions } from '@/stores/playlist';
import { MANUAL_PLAYBACK_QUEUE_ID } from '@/stores/playlist';
import { toRawSongList } from '@/stores/playlist/helpers';
import { isPlayableSong, isSameSong, splitValidSongs } from '@/utils/song';
import { maybeShowResumeHint } from '@/utils/resumeHint';
import type { PlayMode } from '../types';

export interface PlaybackQueueStoreLike {
  setPlaybackQueue: (songs: Song[], filteredInvalidCount?: number) => void;
  setPlaybackQueueWithOptions?: (
    songs: Song[],
    filteredInvalidCount?: number,
    options?: SetPlaybackQueueOptions,
  ) => void;
  setActiveQueue?: (queueId: string | number) => void;
  ensurePlaybackQueueSongsLoaded?: (queueId: string | number) => Promise<unknown>;
  appendToPlaybackQueue?: (songs: Song[], options?: SetPlaybackQueueOptions) => number;
  defaultList?: Song[];
  getPreferredManualQueueOptions?: (options?: SetPlaybackQueueOptions) => SetPlaybackQueueOptions;
  getPlaybackQueueSongs?: (queueId?: string | number | null) => Song[];
  enqueuePlayNext?: (songId: string | number, queueId?: string | number) => void;
  enqueuePlayNextSequential?: (songId: string | number, queueId?: string | number) => void;
  syncQueuedNextTrackIds?: (queueId?: string | number) => void;
  getQueueById?: (queueId?: string | number | null) => { queuedNextTrackIds: string[] } | null;
}

export interface PlaybackPlayerLike {
  playTrack: (
    id: string,
    playlist?: Song[],
    options?: {
      autoPlay?: boolean;
      sourceQueueId?: string | null;
      /** 详情页点播带的续播认领；其它入口不带。 */
      resumeClaim?: PlaybackResumeScope | null;
    },
  ) => Promise<void> | void;
  currentTrackId?: string | null;
  currentSourceQueueId?: string | null;
  currentPlaylist?: Song[] | null;
  isPlaying?: boolean;
  togglePlay?: () => void;
  playMode?: PlayMode;
  resumeScopes?: ReadonlyArray<{
    kind?: string;
    id?: string | number | null;
    trackId?: string | number | null;
  }>;
  /** 读出某个续播桶记下的最后一条进度（有声续播卡用）。 */
  resumeRecordForScope?: (scope: {
    kind?: string;
    id?: string | number | null;
    trackId?: string | number | null;
  }) => { position?: number; title?: string } | undefined;
}

export interface ResolvedPlayableQueue {
  queue: Song[];
  firstPlayable: Song | null;
  filteredInvalidCount: number;
  sourceCount: number;
}

const pendingReplaceQueueRequests = new Map<string, Promise<boolean>>();

const hashPlaybackQueueIds = (songs: Song[]) => {
  let hash = 5381;
  for (const song of songs) {
    const id = String(song.id ?? '');
    for (let index = 0; index < id.length; index += 1) {
      hash = ((hash << 5) + hash + id.charCodeAt(index)) >>> 0;
    }
    hash = ((hash << 5) + hash + 31) >>> 0;
  }
  return hash.toString(36);
};

const buildReplaceQueueRequestKey = (
  resolved: ResolvedPlayableQueue,
  requestedSong: Song | undefined,
  options: SetPlaybackQueueOptions | undefined,
  playMode: PlayMode | undefined,
) =>
  [
    options?.queueId ? String(options.queueId) : '',
    requestedSong ? String(requestedSong.id) : '',
    String(resolved.firstPlayable?.id ?? ''),
    playMode ?? '',
    resolved.queue.length,
    resolved.filteredInvalidCount,
    hashPlaybackQueueIds(resolved.queue),
  ].join('\u001f');

export const resolvePlayableSongForRequest = (
  requestedSong: Song,
  playlist: Song[] = [],
): Song | null => {
  if (isPlayableSong(requestedSong)) return requestedSong;
  if (playlist.length === 0) return null;

  const requestedIndex = playlist.findIndex((song) => isSameSong(song, requestedSong));
  const startIndex = requestedIndex === -1 ? 0 : requestedIndex;

  for (let step = 0; step < playlist.length; step += 1) {
    const index = requestedIndex === -1 ? step : (startIndex + step) % playlist.length;
    const song = playlist[index];
    if (isPlayableSong(song)) return song;
  }

  return null;
};

export const resolvePlayableQueue = (
  songs: Song[],
  filteredInvalidCount = 0,
  requestedSong?: Song,
): ResolvedPlayableQueue => {
  const resolved = splitValidSongs(songs);
  const hiddenCount = Math.max(0, filteredInvalidCount) + resolved.filteredCount;

  return {
    queue: resolved.songs,
    firstPlayable: requestedSong
      ? resolvePlayableSongForRequest(requestedSong, resolved.songs)
      : resolvePlayableSongForRequest(resolved.songs[0] ?? songs[0], resolved.songs),
    filteredInvalidCount: hiddenCount,
    sourceCount: resolved.songs.length + hiddenCount,
  };
};

export const replaceQueueAndPlay = async (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  songs: Song[],
  filteredInvalidCount = 0,
  requestedSong?: Song,
  options?: SetPlaybackQueueOptions,
): Promise<boolean> => {
  const resolved = resolvePlayableQueue(songs, filteredInvalidCount, requestedSong);
  const firstPlayable = resolved.firstPlayable;
  if (!firstPlayable) return false;

  // 有声：这一首有播放记录时弹一张 10 秒续播卡（不拦播放）。
  // 详情页点播（带 resumeScope）不弹：用户已经在这一页里了，提示没有意义。
  if (!options?.resumeScope) {
    maybeShowResumeHint(
      requestedSong ?? firstPlayable,
      playerStore.resumeScopes ?? [],
      playerStore.resumeRecordForScope,
    );
  }

  const requestKey = buildReplaceQueueRequestKey(
    resolved,
    requestedSong,
    options,
    playerStore.playMode,
  );
  const pendingRequest = pendingReplaceQueueRequests.get(requestKey);
  if (pendingRequest) return pendingRequest;

  const request = (async () => {
    if (playlistStore.setPlaybackQueueWithOptions) {
      playlistStore.setPlaybackQueueWithOptions(
        resolved.queue,
        resolved.filteredInvalidCount,
        options,
      );
    } else {
      playlistStore.setPlaybackQueue(resolved.queue, resolved.filteredInvalidCount);
    }

    let songToPlay = firstPlayable;
    if (playerStore.playMode === 'random' && !requestedSong && resolved.queue.length > 0) {
      const randomIndex = Math.floor(Math.random() * resolved.queue.length);
      songToPlay = resolved.queue[randomIndex] ?? firstPlayable;
    }

    await playerStore.playTrack(String(songToPlay.id), resolved.queue, {
      sourceQueueId: options?.queueId ? String(options.queueId) : null,
      resumeClaim: options?.resumeScope ?? null,
    });
    return true;
  })();

  pendingReplaceQueueRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (pendingReplaceQueueRequests.get(requestKey) === request) {
      pendingReplaceQueueRequests.delete(requestKey);
    }
  }
};

export const playSongInContext = async (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  contextSongs: Song[],
  filteredInvalidCount = 0,
  options?: SetPlaybackQueueOptions,
): Promise<boolean> => {
  if (contextSongs.length > 0 && options?.queueId) {
    void filteredInvalidCount;
    return queueAndPlaySong(playlistStore, playerStore, song, options);
  }

  return queueAndPlaySong(playlistStore, playerStore, song, {
    queueId: MANUAL_PLAYBACK_QUEUE_ID,
    title: '我的队列',
    subtitle: '',
    type: 'manual',
    dynamic: true,
  });
};

export const queueAndPlaySong = async (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  options?: SetPlaybackQueueOptions,
): Promise<boolean> => {
  const manualQueueOptions = playlistStore.getPreferredManualQueueOptions?.(options) ?? options;
  const queueId = manualQueueOptions?.queueId;
  const resolvedSong = resolvePlayableSongForRequest(song, [song]);
  if (!resolvedSong) return false;

  // 同一个续播卡：命中就在搜索框右下角提示 10 秒，点不点都不影响这次播放。
  // 详情页点播（带 resumeScope）不弹。
  if (!options?.resumeScope) {
    maybeShowResumeHint(
      resolvedSong,
      playerStore.resumeScopes ?? [],
      playerStore.resumeRecordForScope,
    );
  }

  if (queueId) await playlistStore.ensurePlaybackQueueSongsLoaded?.(queueId);
  const preferredList = queueId ? (playlistStore.getPlaybackQueueSongs?.(queueId) ?? []) : [];
  const activeList = queueId ? preferredList : (playlistStore.defaultList ?? []);
  const nextList = activeList.slice();
  const exists = nextList.some((item) => isSameSong(item, resolvedSong));
  const sourceList = toRawSongList(exists ? activeList : [...nextList, resolvedSong]);

  const isCurrentSong = String(playerStore.currentTrackId ?? '') === String(resolvedSong.id);
  if (isCurrentSong) {
    if (!exists) {
      if (playlistStore.setPlaybackQueueWithOptions) {
        playlistStore.setPlaybackQueueWithOptions(sourceList, 0, manualQueueOptions);
      } else {
        playlistStore.setPlaybackQueue(sourceList, 0);
      }
    } else if (queueId) {
      playlistStore.setActiveQueue?.(queueId);
    }

    if (queueId) {
      playerStore.currentSourceQueueId = String(queueId);
    }
    playerStore.currentPlaylist = sourceList;

    if (!playerStore.isPlaying) {
      await playerStore.togglePlay?.();
    }
    return true;
  }

  if (!exists) {
    if (playlistStore.setPlaybackQueueWithOptions) {
      playlistStore.setPlaybackQueueWithOptions(sourceList, 0, manualQueueOptions);
    } else {
      playlistStore.setPlaybackQueue(sourceList, 0);
    }
  }

  await playerStore.playTrack(String(resolvedSong.id), sourceList, {
    sourceQueueId: queueId ? String(queueId) : null,
    resumeClaim: options?.resumeScope ?? null,
  });
  return true;
};

type PlayNextInsertMode = 'cut' | 'append';

const computePlayNextInsertIndex = (
  list: Song[],
  currentIndex: number,
  queuedNextIds: string[],
  mode: PlayNextInsertMode,
): number => {
  const blockStart = currentIndex >= 0 ? currentIndex + 1 : 0;
  if (mode === 'cut') return blockStart;
  // 顺序添加：跳过当前歌曲后面已排队的"下一首播放组"，插到该组末尾
  const queuedSet = new Set(queuedNextIds.map((id) => String(id)));
  let cursor = blockStart;
  while (cursor < list.length && queuedSet.has(String(list[cursor]?.id))) {
    cursor += 1;
  }
  return cursor;
};

const addSongToPlayQueueNext = (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  mode: PlayNextInsertMode,
  options?: SetPlaybackQueueOptions,
): boolean => {
  const nextQueueOptions = { ...(options ?? {}), activate: false, preserveQueuedNext: true };
  const manualQueueOptions =
    playlistStore.getPreferredManualQueueOptions?.(nextQueueOptions) ?? nextQueueOptions;
  const resolvedSong = resolvePlayableSongForRequest(song, [song]);
  if (!resolvedSong) return false;

  const queueId = manualQueueOptions?.queueId;
  if (queueId) {
    void playlistStore.ensurePlaybackQueueSongsLoaded?.(queueId);
  }
  const list = queueId
    ? (playlistStore.getPlaybackQueueSongs?.(queueId) ?? []).slice()
    : (playlistStore.defaultList ?? []).slice();
  const currentTrackId = String(playerStore.currentTrackId ?? '');
  const currentIndex = list.findIndex((item) => String(item.id) === currentTrackId);
  const currentSong = currentIndex >= 0 ? list[currentIndex] : null;

  if (currentSong && isSameSong(currentSong, resolvedSong)) {
    return true;
  }

  const queuedNextIds = playlistStore.getQueueById?.(queueId)?.queuedNextTrackIds ?? [];
  let insertIndex = computePlayNextInsertIndex(list, currentIndex, queuedNextIds, mode);

  const existingIndex = list.findIndex((item) => isSameSong(item, resolvedSong));
  const item = existingIndex >= 0 ? list.splice(existingIndex, 1)[0] : resolvedSong;

  if (existingIndex !== -1 && existingIndex < insertIndex) {
    insertIndex -= 1;
  }

  if (insertIndex < 0) insertIndex = 0;
  if (insertIndex > list.length) insertIndex = list.length;

  list.splice(insertIndex, 0, item);
  if (playlistStore.setPlaybackQueueWithOptions) {
    playlistStore.setPlaybackQueueWithOptions(list, 0, manualQueueOptions);
  } else {
    playlistStore.setPlaybackQueue(list, 0);
  }
  if (mode === 'cut') {
    playlistStore.enqueuePlayNext?.(item.id, queueId);
  } else {
    playlistStore.enqueuePlayNextSequential?.(item.id, queueId);
  }
  playlistStore.syncQueuedNextTrackIds?.(queueId);
  return true;
};

export const addSongToPlayNext = (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  options?: SetPlaybackQueueOptions,
): boolean => addSongToPlayQueueNext(playlistStore, playerStore, song, 'cut', options);

export const addSongToPlayLast = (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  options?: SetPlaybackQueueOptions,
): boolean => addSongToPlayQueueNext(playlistStore, playerStore, song, 'append', options);
