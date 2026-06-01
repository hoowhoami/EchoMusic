import type { Song } from '@/models/song';

export type PlaybackQueueType =
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

export type PersonalFmMode = 'normal' | 'small' | 'peak';
export type PersonalFmSongPoolId = 0 | 1 | 2;
export type PlaylistSortOrder = 'default' | 'time-desc' | 'time-asc' | 'name-asc' | 'name-desc';

export interface PlaybackQueueMetaValueMap {
  [key: string]: string | number | boolean | null | undefined;
}

export interface PlaybackQueueState {
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string;
  type: PlaybackQueueType;
  songs: Song[];
  filteredInvalidCount: number;
  queuedNextTrackIds: string[];
  currentTrackId: string | null;
  createdAt: number;
  updatedAt: number;
  dynamic: boolean;
  meta: PlaybackQueueMetaValueMap;
}

export interface SetPlaybackQueueOptions {
  queueId?: string;
  title?: string;
  subtitle?: string;
  coverUrl?: string;
  type?: PlaybackQueueType;
  dynamic?: boolean;
  meta?: PlaybackQueueMetaValueMap;
  activate?: boolean;
}
