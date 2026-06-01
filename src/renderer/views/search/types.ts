import type { Song } from '@/models/song';

export interface SearchHotKeyword {
  keyword: string;
  reason: string;
}

export interface SearchHotCategory {
  name: string;
  keywords: SearchHotKeyword[];
}

export interface SearchSuggestionRecord {
  text: string;
}

export interface SearchSuggestionCategory {
  label: string;
  records: SearchSuggestionRecord[];
}

export interface SearchPaginationState {
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  loaded: boolean;
  total: number | null;
}

export interface SearchPlaylistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  creator?: string;
  songCount?: number;
}

export interface SearchAlbumCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  artist?: string;
  subtitle?: string;
}

export interface SearchArtistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  songCount?: number;
  albumCount?: number;
}

export interface SearchMvCardProps {
  videoId: string | number;
  hash: string;
  title: string;
  coverUrl: string;
  artist?: string;
  duration?: number;
  publishDate?: string;
  albumAudioId?: string | number;
}

export interface SearchResultsState {
  songs: Song[];
}
