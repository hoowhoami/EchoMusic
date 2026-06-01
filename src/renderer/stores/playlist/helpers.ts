import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';
import { DEFAULT_PLAYBACK_QUEUE_ID, PERSONAL_FM_MODE } from './constants';
import type {
  PersonalFmMode,
  PersonalFmSongPoolId,
  PlaybackQueueState,
  PlaylistSortOrder,
  SetPlaybackQueueOptions,
} from './types';

export const getPersonalFmModePresentation = (mode?: PersonalFmMode | string) => {
  const resolvedMode: PersonalFmMode =
    mode === 'small' ? 'small' : mode === 'peak' ? 'peak' : PERSONAL_FM_MODE;
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

export const getPlaylistIdentityValues = (playlist: PlaylistMeta): string[] =>
  [
    playlist.id,
    playlist.listid,
    playlist.listCreateGid,
    playlist.globalCollectionId,
    playlist.listCreateListid,
  ]
    .filter((value) => value !== undefined && value !== null && String(value) !== '')
    .map((value) => String(value));

export const findLikedPlaylist = (playlists: PlaylistMeta[]): PlaylistMeta | undefined => {
  let index = playlists.findIndex(
    (playlist) => normalizePlaylistName(playlist.name) === '我喜欢的音乐',
  );
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

export const resolveSongQueueKey = (song: Song): string => {
  if (String(song.mixSongId ?? '0') !== '0') return `mx:${String(song.mixSongId)}`;
  if (song.hash) return `hash:${song.hash.toLowerCase()}`;
  return `id:${String(song.id)}`;
};

export const dedupeSongs = (songs: Song[]): Song[] => {
  const seen = new Set<string>();
  return songs.filter((song) => {
    const key = resolveSongQueueKey(song);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const includesPlaylistIdentity = (playlist: PlaylistMeta, id: string): boolean =>
  getPlaylistIdentityValues(playlist).includes(id);

export const buildPlaybackQueueState = (
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

export const resolveSongNumericId = (song: Song | null | undefined): string => {
  if (!song) return '';
  const candidates = [song.songId, song.mixSongId, song.fileId, song.id];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(String(candidate ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  }
  return String(song.id ?? '');
};

export const resolveFavoriteSongKey = (song: Song | null | undefined): string => {
  if (!song) return '';
  const queueKey = resolveSongQueueKey(song);
  if (queueKey) return queueKey;
  return `id:${String(song.id ?? '')}`;
};

export const buildPlaylistTrackPayload = (song: Song): string =>
  `${song.title}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;

export const removeSongsFromKnownList = (existing: Song[], songs: Song[]): Song[] => {
  if (existing.length === 0 || songs.length === 0) return existing.slice();
  return existing.filter(
    (item) => !songs.some((song) => isSameSong(item, song) || String(item.id) === String(song.id)),
  );
};

export const mergeQueueSongs = (existing: Song[], incoming: Song[]): Song[] => {
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

export const appendQueueSong = (queue: PlaybackQueueState, song: Song): boolean => {
  const key = resolveSongQueueKey(song);
  const exists = queue.songs.some((item) => resolveSongQueueKey(item) === key);
  if (exists) return false;
  queue.songs.push(song);
  return true;
};

export const sortPlaylists = (
  playlists: PlaylistMeta[],
  order: PlaylistSortOrder,
): PlaylistMeta[] => {
  if (order === 'default' || !order) return playlists;
  const sorted = playlists.slice();
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  switch (order) {
    case 'time-desc':
      sorted.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
      break;
    case 'time-asc':
      sorted.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
      break;
    case 'name-asc':
      sorted.sort((a, b) => compareText(a.name || '', b.name || ''));
      break;
    case 'name-desc':
      sorted.sort((a, b) => compareText(b.name || '', a.name || ''));
      break;
  }
  return sorted;
};
