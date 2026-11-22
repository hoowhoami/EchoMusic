export type StorageSong = {
  id: string;
  songId?: string | number;
  title: string;
  name?: string;
  artist: string;
  language?: string;
  albumName?: string;
  artists?: Array<{ id?: string | number; name: string }>;
  singers?: Array<{ id?: string | number; name: string }>;
  album?: string;
  albumId?: string | number;
  duration: number;
  coverUrl: string;
  cover?: string;
  audioUrl: string;
  hash: string;
  mvHash?: string;
  albumAudioId?: string | number;
  mixSongId: string | number;
  fileId?: string | number;
  source?: string;
  lyric?: string;
  lyricSnippet?: string;
  privilege?: number;
  payType?: number;
  oldCpy?: number;
  relateGoods?: Array<{ hash?: string; quality?: string; level?: number }>;
  isOriginal?: boolean;
  recDesc?: string;
  similarDesc?: string;
  playCount?: number;
  lastPlayedAt?: number;
  historyKey?: string;
};

export type StoragePlaybackQueueType =
  | 'default'
  | 'daily-recommend'
  | 'home-discover'
  | 'style-recommend'
  | 'playlist'
  | 'ranking'
  | 'album'
  | 'artist'
  | 'search'
  | 'history'
  | 'cloud'
  | 'fm'
  | 'listen-together'
  | 'manual'
  | 'purchased'
  | 'free-listen';

export interface StoragePlaybackQueueMetaValueMap {
  [key: string]: string | number | boolean | null | undefined;
}

export interface StoragePlaybackQueueState {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  type: StoragePlaybackQueueType;
  songs: StorageSong[];
  songCount?: number;
  filteredInvalidCount: number;
  queuedNextTrackIds: string[];
  currentTrackId: string | null;
  createdAt: number;
  updatedAt: number;
  dynamic: boolean;
  meta: StoragePlaybackQueueMetaValueMap;
}

export interface StoragePlaybackSnapshot {
  queues: StoragePlaybackQueueState[];
  activeQueueId: string;
  lastNonFmQueueId: string;
}

export interface StorageSetQueueCurrentTrackPayload {
  queueId?: string | null;
  trackId?: string | number | null;
}

export interface StorageQueueIdPayload {
  queueId: string;
}

export interface StorageReplaceQueuePayload {
  queue: StoragePlaybackQueueState;
  activeQueueId: string;
  lastNonFmQueueId: string;
}

export interface StorageAppendQueueItemsPayload {
  queue: Omit<StoragePlaybackQueueState, 'songs'> & { songs?: StorageSong[] };
  songs: StorageSong[];
  activeQueueId: string;
  lastNonFmQueueId: string;
}

export interface StorageRemoveQueueItemPayload {
  queueId: string;
  songId: string | number;
  queuedNextTrackIds?: string[];
  currentTrackId?: string | null;
  updatedAt?: number;
}

export interface StorageReorderQueueItemsPayload {
  queueId: string;
  songs: StorageSong[];
  updatedAt?: number;
}

export interface StorageUpdateQueueMetaPayload {
  queue: Omit<StoragePlaybackQueueState, 'songs'> & { songs?: StorageSong[] };
  activeQueueId: string;
  lastNonFmQueueId: string;
}

export interface StorageHistoryEntry {
  song: StorageSong;
  lastPlayedAt: number;
  playCount: number;
  historyKey: string;
  /** 本地累计实听毫秒（老库/老 IPC 可能缺省，按 0 处理） */
  listenedMs?: number;
}

export interface StorageHistoryGetEntriesPayload {
  offset?: number;
  limit?: number;
}

export interface StorageHistoryRecordPlayPayload {
  song: StorageSong;
  playedAt?: number;
  maxEntries?: number;
}

export interface StorageHistoryAddListenTimePayload {
  song: StorageSong;
  listenedMs: number;
}

export interface StorageHistoryAddListenTimeResult {
  ok: boolean;
  /** 受影响的条目数：0 表示该歌曲已不在历史中（不重建条目） */
  updated: number;
  /** 条目维度的权威总时长（ms）；updated 为 0 时为 0 */
  listenedMs?: number;
  /** 终身累计实听毫秒（独立于条目，不受裁剪/删除/清空影响） */
  totalListenedMs?: number;
}

export interface StorageHistoryListenTotalResult {
  ok: boolean;
  /** 终身累计实听毫秒 */
  listenedMs: number;
}

export interface StorageHistoryRemoveEntriesPayload {
  historyKeys: string[];
}

export interface StorageResetResult {
  ok: true;
}

export type StorageWriteResult = StorageResetResult;
