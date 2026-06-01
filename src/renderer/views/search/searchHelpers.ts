import { mapAlbumMeta, mapArtistMeta, mapPlaylistMeta, mapSearchSong } from '@/utils/mappers';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { PlaylistMeta } from '@/models/playlist';
import type {
  SearchAlbumCardProps,
  SearchArtistCardProps,
  SearchHotCategory,
  SearchMvCardProps,
  SearchPaginationState,
  SearchPlaylistCardProps,
  SearchSuggestionCategory,
} from './types';
import type { Song } from '@/models/song';

export const SEARCH_PAGE_SIZE = 30;
export const TAB_SEARCH_TYPES = ['song', 'special', 'album', 'author', 'lyric', 'mv'] as const;
export type SearchTabType = (typeof TAB_SEARCH_TYPES)[number];

export const createSearchPaginationState = (): SearchPaginationState => ({
  page: 1,
  hasMore: false,
  loadingMore: false,
  loading: false,
  loaded: false,
  total: null,
});

export const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
};

export const extractSearchLists = (payload: unknown): unknown[] => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const lists = data?.lists ?? data?.list ?? record?.lists ?? record?.list;
  return Array.isArray(lists) ? lists : [];
};

export const extractSearchTotal = (payload: unknown): number | null => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const candidates = [
    data?.total,
    data?.totalCount,
    data?.count,
    data?.counts,
    record?.total,
    record?.totalCount,
    record?.count,
    record?.counts,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
};

export const extractHotCategories = (payload: unknown): SearchHotCategory[] => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const list = Array.isArray(data?.list) ? data?.list : [];

  return list
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const rawKeywords = Array.isArray(item.keywords) ? item.keywords : [];
      return {
        name: typeof item.name === 'string' ? item.name : String(item.name ?? ''),
        keywords: rawKeywords
          .map((keywordItem) => toRecord(keywordItem))
          .filter((keywordItem): keywordItem is Record<string, unknown> => Boolean(keywordItem))
          .map((keywordItem) => ({
            keyword:
              typeof keywordItem.keyword === 'string'
                ? keywordItem.keyword
                : String(keywordItem.keyword ?? ''),
            reason:
              typeof keywordItem.reason === 'string'
                ? keywordItem.reason
                : String(keywordItem.reason ?? ''),
          }))
          .filter((keywordItem) => keywordItem.keyword.length > 0),
      };
    })
    .filter((category) => category.name.length > 0);
};

export const extractSuggestionCategories = (payload: unknown): SearchSuggestionCategory[] => {
  const record = toRecord(payload);
  const rawData = record?.data;
  const list = Array.isArray(rawData) ? rawData : [];

  return list
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const label =
        typeof item.LableName === 'string' ? item.LableName : String(item.LableName ?? '');
      const rawRecords = Array.isArray(item.RecordDatas) ? item.RecordDatas : [];
      return {
        label,
        records: rawRecords
          .map((recordItem) => toRecord(recordItem))
          .filter((recordItem): recordItem is Record<string, unknown> => Boolean(recordItem))
          .map((recordItem) => ({
            text:
              typeof recordItem.HintInfo === 'string'
                ? recordItem.HintInfo
                : String(recordItem.HintInfo ?? ''),
          }))
          .filter((recordItem) => recordItem.text.length > 0),
      };
    })
    .filter((category) => category.records.length > 0 && category.label !== 'MV');
};

export const resolvePlaylistRouteId = (entry: PlaylistMeta) => {
  return entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id;
};

export const getPlaylistCardProps = (entry: PlaylistMeta): SearchPlaylistCardProps => ({
  id: resolvePlaylistRouteId(entry),
  name: entry.name,
  coverUrl: entry.pic,
  creator: entry.nickname,
  songCount: entry.count,
});

export const getAlbumCardProps = (album: AlbumMeta): SearchAlbumCardProps => ({
  id: album.id,
  name: album.name,
  coverUrl: album.pic,
  artist: album.singerName,
  subtitle: [album.singerName, album.songCount ? `${album.songCount} 首歌曲` : '']
    .filter(Boolean)
    .join(' • '),
});

export const getArtistCardProps = (artist: ArtistMeta): SearchArtistCardProps => ({
  id: artist.id,
  name: artist.name,
  coverUrl: artist.pic,
  songCount: artist.songCount,
  albumCount: artist.albumCount,
});

export const mapMvSearchItem = (json: unknown): SearchMvCardProps => {
  const item = toRecord(json) ?? {};
  const pic = String(item.Pic ?? '');
  const coverUrl = pic ? `https://imge.kugou.com/mvhdpic/400/${pic}` : '';
  return {
    videoId: (item.MvID as string | number) ?? '',
    hash: String(item.MvHash ?? ''),
    title: String(item.MvName ?? ''),
    coverUrl,
    artist: String(item.SingerName ?? ''),
    duration: Number(item.Duration ?? 0) * 1000,
    publishDate: String(item.PublishDate ?? '').split(' ')[0],
    albumAudioId: item.AudioID as string | number | undefined,
  };
};

export const replaceResultsByType = (
  type: SearchTabType,
  lists: unknown[],
  target: {
    songResults: { value: Song[] };
    playlistResults: { value: PlaylistMeta[] };
    albumResults: { value: AlbumMeta[] };
    artistResults: { value: ArtistMeta[] };
    lyricResults: { value: Song[] };
    mvResults: { value: SearchMvCardProps[] };
  },
) => {
  if (type === 'song') {
    target.songResults.value = lists.map((item) => mapSearchSong(item));
    return;
  }
  if (type === 'special') {
    target.playlistResults.value = lists.map((item) => mapPlaylistMeta(item));
    return;
  }
  if (type === 'album') {
    target.albumResults.value = lists.map((item) => mapAlbumMeta(item));
    return;
  }
  if (type === 'lyric') {
    target.lyricResults.value = lists.map((item) => mapSearchSong(item));
    return;
  }
  if (type === 'mv') {
    target.mvResults.value = lists.map((item) => mapMvSearchItem(item));
    return;
  }
  target.artistResults.value = lists.map((item) => mapArtistMeta(item));
};

export const appendResultsByType = (
  type: SearchTabType,
  lists: unknown[],
  target: {
    songResults: { value: Song[] };
    playlistResults: { value: PlaylistMeta[] };
    albumResults: { value: AlbumMeta[] };
    artistResults: { value: ArtistMeta[] };
    lyricResults: { value: Song[] };
    mvResults: { value: SearchMvCardProps[] };
  },
) => {
  if (type === 'song') {
    target.songResults.value = target.songResults.value.concat(
      lists.map((item) => mapSearchSong(item)),
    );
    return;
  }
  if (type === 'special') {
    target.playlistResults.value = target.playlistResults.value.concat(
      lists.map((item) => mapPlaylistMeta(item)),
    );
    return;
  }
  if (type === 'album') {
    target.albumResults.value = target.albumResults.value.concat(
      lists.map((item) => mapAlbumMeta(item)),
    );
    return;
  }
  if (type === 'lyric') {
    target.lyricResults.value = target.lyricResults.value.concat(
      lists.map((item) => mapSearchSong(item)),
    );
    return;
  }
  if (type === 'mv') {
    target.mvResults.value = target.mvResults.value.concat(
      lists.map((item) => mapMvSearchItem(item)),
    );
    return;
  }
  target.artistResults.value = target.artistResults.value.concat(
    lists.map((item) => mapArtistMeta(item)),
  );
};
