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
  | 'playlist'
  | 'ranking'
  | 'album'
  | 'artist'
  | 'search'
  | 'history'
  | 'cloud'
  | 'fm'
  | 'manual';

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

export interface StorageHistoryRemoveEntriesPayload {
  historyKeys: string[];
}

export interface StorageResetResult {
  ok: true;
}

export type StorageWriteResult = StorageResetResult;
