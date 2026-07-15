import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { MANUAL_PLAYBACK_QUEUE_ID } from '@/stores/playlist';
import { toRawSongList } from '@/stores/playlist/helpers';
import { isPlayableSong, isSameSong, splitValidSongs } from '@/utils/song';
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
    options?: { autoPlay?: boolean; sourceQueueId?: string | null },
  ) => Promise<void> | void;
  currentTrackId?: string | null;
  currentSourceQueueId?: string | null;
  currentPlaylist?: Song[] | null;
  isPlaying?: boolean;
  togglePlay?: () => void;
  playMode?: PlayMode;
}

export interface ResolvedPlayableQueue {
  queue: Song[];
  firstPlayable: Song | null;
  filteredInvalidCount: number;
  sourceCount: number;
}

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
  if (!resolved.firstPlayable) return false;
  if (playlistStore.setPlaybackQueueWithOptions) {
    playlistStore.setPlaybackQueueWithOptions(
      resolved.queue,
      resolved.filteredInvalidCount,
      options,
    );
  } else {
    playlistStore.setPlaybackQueue(resolved.queue, resolved.filteredInvalidCount);
  }

  let songToPlay = resolved.firstPlayable;
  if (playerStore.playMode === 'random' && !requestedSong && resolved.queue.length > 0) {
    const randomIndex = Math.floor(Math.random() * resolved.queue.length);
    songToPlay = resolved.queue[randomIndex];
  }

  await playerStore.playTrack(String(songToPlay.id), resolved.queue, {
    sourceQueueId: options?.queueId ? String(options.queueId) : null,
  });
  return true;
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
    subtitle: '手动点播与整理',
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
  if (queueId) await playlistStore.ensurePlaybackQueueSongsLoaded?.(queueId);
  const preferredList = queueId ? (playlistStore.getPlaybackQueueSongs?.(queueId) ?? []) : [];
  const activeList = queueId ? preferredList : (playlistStore.defaultList ?? []);
  const resolvedSong = resolvePlayableSongForRequest(song, [song]);
  if (!resolvedSong) return false;
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
  const nextQueueOptions = { ...(options ?? {}), activate: false };
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
