import { markRaw, toRaw } from 'vue';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';
import { DEFAULT_PLAYBACK_QUEUE_ID, PERSONAL_FM_MODE } from './constants';
import type {
  PersonalFmMode,
  PersonalFmSongPoolId,
  PlaybackQueueState,
  SetPlaybackQueueOptions,
} from './types';

const PERSONAL_FM_MODE_PRESENTATION: Record<
  PersonalFmMode,
  { title: string; subtitle: string; label: string }
> = {
  normal: { title: '红心 Radio', subtitle: '猜你喜欢', label: '红心 Radio' },
  small: { title: '小众 Radio', subtitle: '小众推荐', label: '小众 Radio' },
  peak: { title: '速览 Radio', subtitle: '速览推荐', label: '速览 Radio' },
  radio: { title: '电台 Radio', subtitle: '电台推荐', label: '电台 Radio' },
};

export const getPersonalFmModePresentation = (mode?: PersonalFmMode | string) => {
  const resolvedMode: PersonalFmMode =
    mode === 'small' || mode === 'peak' || mode === 'radio' ? mode : PERSONAL_FM_MODE;
  return {
    mode: resolvedMode,
    ...PERSONAL_FM_MODE_PRESENTATION[resolvedMode],
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

export const toRawSong = (song: Song): Song => markRaw(toRaw(song));

export const toRawSongList = (songs: Song[] = []): Song[] => {
  if ((songs as { __v_skip?: boolean }).__v_skip === true) return songs;
  return markRaw(songs.map(toRawSong));
};

export const normalizePlaybackQueueRuntime = (queue: PlaybackQueueState): PlaybackQueueState => {
  queue.songs = toRawSongList(queue.songs ?? []);
  const playbackRevision = Number(queue.playbackRevision);
  queue.playbackRevision = Number.isSafeInteger(playbackRevision)
    ? Math.max(0, playbackRevision)
    : 0;
  return queue;
};

export const bumpPlaybackQueueRevision = (queue: PlaybackQueueState): number => {
  const playbackRevision = Number(queue.playbackRevision);
  const current = Number.isSafeInteger(playbackRevision) ? Math.max(0, playbackRevision) : 0;
  queue.playbackRevision = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  return queue.playbackRevision;
};

export const normalizePlaybackQueuesRuntime = (
  queues: PlaybackQueueState[] = [],
): PlaybackQueueState[] => queues.map(normalizePlaybackQueueRuntime);

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
    songs: toRawSongList(songs),
    filteredInvalidCount: Math.max(0, filteredInvalidCount),
    queuedNextTrackIds: [],
    currentTrackId: null,
    playbackRevision: 0,
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
  `${song.name}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;

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
  queue.songs = toRawSongList([...queue.songs, song]);
  return true;
};
