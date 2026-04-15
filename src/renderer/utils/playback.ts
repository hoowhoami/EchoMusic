import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { MANUAL_PLAYBACK_QUEUE_ID } from '@/stores/playlist';
import { isPlayableSong, isSameSong, splitValidSongs } from '@/utils/song';

export interface PlaybackQueueStoreLike {
  setPlaybackQueue: (songs: Song[], filteredInvalidCount?: number) => void;
  setPlaybackQueueWithOptions?: (
    songs: Song[],
    filteredInvalidCount?: number,
    options?: SetPlaybackQueueOptions,
  ) => void;
  setActiveQueue?: (queueId: string | number) => void;
  appendToPlaybackQueue?: (songs: Song[], options?: SetPlaybackQueueOptions) => number;
  defaultList?: Song[];
  getPreferredManualQueueOptions?: (options?: SetPlaybackQueueOptions) => SetPlaybackQueueOptions;
  getPlaybackQueueSongs?: (queueId?: string | number | null) => Song[];
  enqueuePlayNext?: (songId: string | number) => void;
  syncQueuedNextTrackIds?: () => void;
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
  await playerStore.playTrack(String(resolved.firstPlayable.id), resolved.queue, {
    sourceQueueId: options?.queueId ? String(options.queueId) : null,
  });
  return true;
};

export const playSongInContext = async (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  _contextSongs: Song[],
  _filteredInvalidCount = 0,
  _options?: SetPlaybackQueueOptions,
): Promise<boolean> => {
  void _contextSongs;
  void _filteredInvalidCount;
  void _options;
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
  const preferredList = queueId ? (playlistStore.getPlaybackQueueSongs?.(queueId) ?? []) : [];
  const activeList = preferredList.length > 0 ? preferredList : (playlistStore.defaultList ?? []);
  const resolvedSong = resolvePlayableSongForRequest(song, [song]);
  if (!resolvedSong) return false;
  const nextList = activeList.slice();
  const exists = nextList.some((item) => isSameSong(item, resolvedSong));
  const sourceList = exists ? activeList : [...nextList, resolvedSong];

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

export const addSongToPlayNext = (
  playlistStore: PlaybackQueueStoreLike,
  playerStore: PlaybackPlayerLike,
  song: Song,
  options?: SetPlaybackQueueOptions,
): boolean => {
  const manualQueueOptions = playlistStore.getPreferredManualQueueOptions?.(options) ?? options;
  const resolvedSong = resolvePlayableSongForRequest(song, [song]);
  if (!resolvedSong) return false;

  const queueId = manualQueueOptions?.queueId;
  const preferredList = queueId ? (playlistStore.getPlaybackQueueSongs?.(queueId) ?? []) : [];
  const list = (
    preferredList.length > 0 ? preferredList : (playlistStore.defaultList ?? [])
  ).slice();
  const currentTrackId = String(playerStore.currentTrackId ?? '');
  const currentIndex = list.findIndex((item) => String(item.id) === currentTrackId);
  const currentSong = currentIndex >= 0 ? list[currentIndex] : null;

  if (currentSong && isSameSong(currentSong, resolvedSong)) {
    return true;
  }

  let insertIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const existingIndex = list.findIndex((item) => isSameSong(item, resolvedSong));
  const item = existingIndex >= 0 ? list.splice(existingIndex, 1)[0] : resolvedSong;

  if (existingIndex !== -1 && currentIndex > existingIndex) {
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
  playlistStore.enqueuePlayNext?.(item.id);
  playlistStore.syncQueuedNextTrackIds?.();
  return true;
};
