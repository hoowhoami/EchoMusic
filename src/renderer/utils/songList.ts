import type { Song } from '@/models/song';

export type SongListSortField = 'index' | 'title' | 'album' | 'duration';
export type SongListSortOrder = 'asc' | 'desc' | null;

const compareText = (a: string, b: string) =>
  a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });

export const normalizeSongSearchQuery = (query: string): string => query.trim().toLowerCase();

export const songMatchesQuery = (song: Song, normalizedQuery: string): boolean => {
  if (!normalizedQuery) return true;
  return (
    (song.name ?? song.title ?? '').toLowerCase().includes(normalizedQuery) ||
    song.artist.toLowerCase().includes(normalizedQuery) ||
    Boolean(song.album?.toLowerCase().includes(normalizedQuery))
  );
};

export const filterSongsByQuery = (songs: Song[], query: string): Song[] => {
  const normalizedQuery = normalizeSongSearchQuery(query);
  if (!normalizedQuery) return songs;
  return songs.filter((song) => songMatchesQuery(song, normalizedQuery));
};

export const sortSongs = (
  songs: Song[],
  sortField: SongListSortField | null,
  sortOrder: SongListSortOrder,
  options?: {
    indexSource?: Song[];
    albumAccessor?: (song: Song) => string;
  },
): Song[] => {
  const base = songs.slice();
  if (!sortField || !sortOrder) return base;

  const direction = sortOrder === 'asc' ? 1 : -1;
  const indexSource = options?.indexSource ?? songs;
  const albumAccessor = options?.albumAccessor ?? ((song: Song) => song.album ?? '');

  let indexMap: Map<string, number> | null = null;
  if (sortField === 'index') {
    indexMap = new Map<string, number>();
    indexSource.forEach((song, index) => {
      indexMap!.set(song.id, index);
    });
  }

  return base.sort((a, b) => {
    switch (sortField) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(albumAccessor(a), albumAccessor(b)) * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap?.get(a.id) ?? 0) - (indexMap?.get(b.id) ?? 0) || 0) * direction;
      default:
        return 0;
    }
  });
};
