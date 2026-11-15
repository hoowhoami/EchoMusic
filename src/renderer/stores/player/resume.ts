import type { PlayerState } from './state';
import type { PlayMode } from '../../types';

/** 只有长内容（有声书、播客、讲座）才记进度，普通歌曲仍从头播放。 */
export const RESUME_MIN_DURATION_SEC = 60;
/** 接着播时往回倒几秒，免得正好卡在上一句结尾。 */
export const RESUME_REWIND_SEC = 5;
/** 距结尾这么近就当已听完。 */
export const RESUME_TAIL_MARGIN_SEC = 20;
/** 最多记住多少个歌单、多少本书，超出就淘汰最久没听的。 */
export const RESUME_MAX_PLAYLISTS = 20;
export const RESUME_MAX_BOOKS = 20;

export const RESUME_SINGLE_ENTRY = 'single';
const BOOK_ENTRY_PREFIX = 'book:';
const PLAYLIST_ENTRY_PREFIX = 'playlist:';
const PLAYLIST_QUEUE_PREFIX = 'queue:playlist:';

export type ResumeState = Pick<PlayerState, 'resumePositions' | 'resumeBooks' | 'resumePlaylists'>;

export interface ResumeEntryContext {
  queueId?: string | null;
  playMode?: PlayMode;
  albumId?: string | number | null;
}

const toKey = (value: unknown): string => String(value ?? '').trim();
const touch = (): number => Date.now();

export const isBookEntry = (entry: string): boolean => entry.startsWith(BOOK_ENTRY_PREFIX);
export const isPlaylistEntry = (entry: string): boolean => entry.startsWith(PLAYLIST_ENTRY_PREFIX);
export const bookEntryAlbumId = (entry: string): string =>
  isBookEntry(entry) ? entry.slice(BOOK_ENTRY_PREFIX.length) : '';
export const playlistEntryId = (entry: string): string =>
  isPlaylistEntry(entry) ? entry.slice(PLAYLIST_ENTRY_PREFIX.length) : '';

/** 这次播放算在哪条记录线上：某本书、某个歌单，还是单曲槽位。 */
export const resolveResumeEntry = (state: ResumeState, context: ResumeEntryContext): string => {
  const albumId = toKey(context.albumId);
  if (albumId && state.resumeBooks.some((book) => book.albumId === albumId)) {
    return `${BOOK_ENTRY_PREFIX}${albumId}`;
  }
  const queueId = toKey(context.queueId);
  if (context.playMode !== 'random' && queueId.startsWith(PLAYLIST_QUEUE_PREFIX)) {
    const playlistId = queueId.slice(PLAYLIST_QUEUE_PREFIX.length).trim();
    if (playlistId) return `${PLAYLIST_ENTRY_PREFIX}${playlistId}`;
  }
  return RESUME_SINGLE_ENTRY;
};

const dropPosition = (state: ResumeState, trackId: string): void => {
  if (trackId && state.resumePositions[trackId]) delete state.resumePositions[trackId];
};

/** 歌单和书里存的只是「当前那一首」；没人指向的位置记录顺手清掉。 */
const pruneUnreferenced = (state: ResumeState): void => {
  for (const trackId of Object.keys(state.resumePositions)) {
    const record = state.resumePositions[trackId];
    if (!record || record.entry === RESUME_SINGLE_ENTRY) continue;
    const referenced =
      state.resumeBooks.some((book) => book.trackId === trackId) ||
      state.resumePlaylists.some((playlist) => playlist.trackId === trackId);
    if (!referenced) delete state.resumePositions[trackId];
  }
};

/** 单曲槽位只有一条：换了曲目就把上一条丢掉，不管这次算在哪条记录线上。 */
const dropStaleSingle = (state: ResumeState, keepTrackId: string): void => {
  for (const trackId of Object.keys(state.resumePositions)) {
    if (trackId === keepTrackId) continue;
    if (state.resumePositions[trackId]?.entry === RESUME_SINGLE_ENTRY) {
      delete state.resumePositions[trackId];
    }
  }
};

const trimBooks = (state: ResumeState): void => {
  if (state.resumeBooks.length <= RESUME_MAX_BOOKS) return;
  const evicted = state.resumeBooks.splice(RESUME_MAX_BOOKS);
  evicted.forEach((book) => {
    if (book.trackId) dropPosition(state, book.trackId);
  });
  pruneUnreferenced(state);
};

const trimPlaylists = (state: ResumeState): void => {
  if (state.resumePlaylists.length <= RESUME_MAX_PLAYLISTS) return;
  const evicted = state.resumePlaylists.splice(RESUME_MAX_PLAYLISTS);
  evicted.forEach((playlist) => {
    if (playlist.trackId) dropPosition(state, playlist.trackId);
  });
  pruneUnreferenced(state);
};

/** 从「听书」入口打开一本书时登记；之后从任何入口进来的章节都算这本书的。 */
export const registerResumeBook = (state: ResumeState, albumId: string): void => {
  const key = toKey(albumId);
  if (!key) return;
  if (state.resumeBooks.some((book) => book.albumId === key)) return;
  state.resumeBooks.unshift({ albumId: key, trackId: '', updatedAt: touch() });
  trimBooks(state);
};

export const forgetResumeBook = (state: ResumeState, albumId: string): void => {
  const key = toKey(albumId);
  if (!key) return;
  const index = state.resumeBooks.findIndex((book) => book.albumId === key);
  if (index < 0) return;
  const [removed] = state.resumeBooks.splice(index, 1);
  if (removed?.trackId) dropPosition(state, removed.trackId);
  pruneUnreferenced(state);
};

/** 起播位置：条目对得上才接着上次的位置（往回倒几秒），对不上就当没记过。 */
export const resolveResumePosition = (
  state: ResumeState,
  trackId: string,
  duration: number,
  entry: string,
): number => {
  const key = toKey(trackId);
  if (!key) return 0;
  const record = state.resumePositions[key];
  if (!record) return 0;
  // 换了条记录线进来的（比如从搜索直接点这首歌）：从 0 开始，旧记录作废
  if (record.entry !== entry) {
    delete state.resumePositions[key];
    return 0;
  }
  const total = Number(duration) > 0 ? Number(duration) : Number(record.duration) || 0;
  if (!(total >= RESUME_MIN_DURATION_SEC)) return 0;
  const position = Number(record.position) || 0;
  if (position <= RESUME_REWIND_SEC) return 0;
  if (position >= total - 1) return 0;
  return Math.max(0, Math.round(position - RESUME_REWIND_SEC));
};

export const rememberResumePosition = (
  state: ResumeState,
  trackId: string,
  position: number,
  duration: number,
  entry: string,
): void => {
  const key = toKey(trackId);
  if (!key) return;
  dropStaleSingle(state, key);
  const total = Number(duration) || 0;
  if (!(total >= RESUME_MIN_DURATION_SEC)) {
    dropPosition(state, key);
    pruneUnreferenced(state);
    return;
  }
  const safePosition = Math.max(0, Math.min(total, Number(position) || 0));
  if (safePosition < 1) return;
  const previous = state.resumePositions[key];
  const unchanged =
    previous &&
    previous.entry === entry &&
    Math.abs(previous.position - safePosition) < 3 &&
    Math.abs(previous.duration - total) < 1;
  if (!unchanged) {
    state.resumePositions[key] = {
      position: Math.round(safePosition),
      duration: Math.round(total),
      updatedAt: touch(),
      entry,
    };
  }
  if (isBookEntry(entry)) {
    const albumId = bookEntryAlbumId(entry);
    const index = state.resumeBooks.findIndex((book) => book.albumId === albumId);
    if (index >= 0) {
      const [book] = state.resumeBooks.splice(index, 1);
      book.trackId = key;
      book.updatedAt = touch();
      state.resumeBooks.unshift(book);
    } else {
      state.resumeBooks.unshift({ albumId, trackId: key, updatedAt: touch() });
    }
    trimBooks(state);
    pruneUnreferenced(state);
    return;
  }
  if (isPlaylistEntry(entry)) {
    const playlistId = playlistEntryId(entry);
    const index = state.resumePlaylists.findIndex((playlist) => playlist.id === playlistId);
    if (index >= 0) {
      const [playlist] = state.resumePlaylists.splice(index, 1);
      playlist.trackId = key;
      playlist.updatedAt = touch();
      state.resumePlaylists.unshift(playlist);
    } else {
      state.resumePlaylists.unshift({ id: playlistId, trackId: key, updatedAt: touch() });
    }
    trimPlaylists(state);
    pruneUnreferenced(state);
    return;
  }
  pruneUnreferenced(state);
};

export const forgetResumePosition = (state: ResumeState, trackId: string): void => {
  const key = toKey(trackId);
  if (!key) return;
  dropPosition(state, key);
  state.resumeBooks.forEach((book) => {
    if (book.trackId === key) book.trackId = '';
  });
  state.resumePlaylists.forEach((playlist) => {
    if (playlist.trackId === key) playlist.trackId = '';
  });
  pruneUnreferenced(state);
};
