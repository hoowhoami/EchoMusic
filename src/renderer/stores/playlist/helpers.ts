import { markRaw, toRaw } from 'vue';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { withoutEmbeddedMetadata } from '../../../shared/embeddedMetadata';
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

// 原创建者的歌单身份键（gid 的构成成分，与 playlistCommentId 的 collection_3_ 约定一致）。
// uid + 原创建列表号组合才是全局唯一的；任一成分缺失时返回空，不参与匹配。
const originalCollectionKey = (playlist: PlaylistMeta): string => {
  const { listCreateUserid, listCreateListid } = playlist;
  if (!listCreateUserid || listCreateUserid <= 0) return '';
  if (listCreateListid === undefined || listCreateListid === null || listCreateListid <= 0) {
    return '';
  }
  return `collection_3_${listCreateUserid}_${listCreateListid}`;
};

/**
 * 判定「用户库歌单条目」与「展示侧歌单」是否为同一个收藏。
 * 仅比较全局唯一身份：gid（globalCollectionId / listCreateGid）优先；
 * 双方均无 gid 时回退到原创建者 userid+列表号组合，覆盖只有数字身份的
 * 历史 / 分享 / 本地入口数据。绝不比较 listid/listCreateListid 裸值——
 * 它们按账号分配，跨歌单必撞号，曾导致探索页误报已收藏、取消收藏误删其他歌单。
 */
export const matchesFavoriteEntry = (entry: PlaylistMeta, meta: PlaylistMeta): boolean => {
  const metaGids = [meta.globalCollectionId, meta.listCreateGid];
  const entryGids = [entry.globalCollectionId, entry.listCreateGid];
  if (entryGids.some((gid) => !!gid && metaGids.includes(gid))) {
    return true;
  }
  // 任一侧带显式 gid 时不回退组合键：gid 是更精确的身份，不一致即视为不同歌单，
  // 避免异常数据借组合键误判；只有双方都缺失 gid 才用组合键兜底。
  if (entryGids.some(Boolean) || metaGids.some(Boolean)) return false;
  const entryOrigin = originalCollectionKey(entry);
  return entryOrigin !== '' && entryOrigin === originalCollectionKey(meta);
};

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
  if (
    (songs as { __v_skip?: boolean }).__v_skip === true &&
    !songs.some((song) => song.embeddedMetadata !== undefined)
  )
    return songs;
  return markRaw(songs.map((song) => toRawSong(withoutEmbeddedMetadata(toRaw(song)))));
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

/** 收藏身份同时保留 ID 与 hash，播放补全 ID 后仍可匹配歌单中的原始记录。 */
export const resolveFavoriteSongKeys = (song: Song | null | undefined): string[] => {
  if (!song) return [];
  const keys: string[] = [];
  const mixSongId = String(song.mixSongId ?? '').trim();
  const hash = String(song.hash ?? '')
    .trim()
    .toLowerCase();
  if (mixSongId && mixSongId !== '0') keys.push(`mx:${mixSongId}`);
  if (hash) keys.push(`hash:${hash}`);
  // id 可能是列表行 ID；有歌曲身份时不以它跨来源匹配，避免误认不同歌曲。
  const id = String(song.id ?? '').trim();
  if (keys.length === 0 && id && id !== '0') keys.push(`id:${id}`);
  return keys;
};

export const buildPlaylistTrackPayload = (song: Song): string =>
  `${song.name}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;

/**
 * 生成与 isSameSong（含可选 id 兜底）匹配语义完全一致的身份键集。
 * isSameSong 匹配 = 双方 mixSongId 均非 '0' 且相等，或双方 hash 均非空且相等；
 * 键集交集判断与之等价，用于把批量场景的 O(n×m) 双重扫描降为 O(n+m)。
 */
export const addSongToMatchKeySet = (song: Song, keys: Set<string>, includeId: boolean): void => {
  const mixSongId = String(song.mixSongId ?? '0');
  if (mixSongId !== '0') keys.add(`mx:${mixSongId}`);
  const hash = String(song.hash ?? '')
    .trim()
    .toLowerCase();
  if (hash) keys.add(`hash:${hash}`);
  if (includeId) keys.add(`id:${String(song.id)}`);
};

export const buildSongMatchKeySet = (songs: Song[], includeId = false): Set<string> => {
  const keys = new Set<string>();
  for (const song of songs) addSongToMatchKeySet(song, keys, includeId);
  return keys;
};

/** 判断单曲是否命中键集（与 isSameSong 同样的身份规范化）。 */
export const songMatchesKeySet = (song: Song, keys: Set<string>): boolean => {
  const mixSongId = String(song.mixSongId ?? '0');
  if (mixSongId !== '0' && keys.has(`mx:${mixSongId}`)) return true;
  const hash = String(song.hash ?? '')
    .trim()
    .toLowerCase();
  if (hash && keys.has(`hash:${hash}`)) return true;
  const id = String(song.id);
  if (keys.has(`id:${id}`)) return true;
  return false;
};

export const removeSongsFromKnownList = (existing: Song[], songs: Song[]): Song[] => {
  if (existing.length === 0 || songs.length === 0) return existing.slice();
  const removedKeys = buildSongMatchKeySet(songs, true);
  return existing.filter((item) => !songMatchesKeySet(item, removedKeys));
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
  const rawSong = toRawSong(withoutEmbeddedMetadata(toRaw(song)));
  const existing = queue.songs as Song[] & { __v_skip?: boolean };
  // 旧队列数组已 markRaw 且歌曲不含 embeddedMetadata 时走增量 concat，
  // 避免触发 toRawSongList 对整条队列逐首重建对象（FM 逐首追加时的 O(n) 分配）；
  // 否则退回全量规整路径保持行为一致。
  if (existing.__v_skip === true && !existing.some((item) => item.embeddedMetadata !== undefined)) {
    queue.songs = markRaw(existing.concat(rawSong));
  } else {
    queue.songs = toRawSongList([...queue.songs, rawSong]);
  }
  return true;
};
