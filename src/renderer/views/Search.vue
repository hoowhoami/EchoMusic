<script setup lang="ts">
defineOptions({ name: 'search-page' });
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getSearchHot, getSearchSuggest, search } from '@/api/search';
import { useSettingStore } from '@/stores/setting';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import Button from '@/components/ui/Button.vue';
import { mapAlbumMeta, mapArtistMeta, mapPlaylistMeta, mapSearchSong } from '@/utils/mappers';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { PlaylistMeta } from '@/models/playlist';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader, {
  type SortField,
  type SortOrder,
} from '@/components/music/SongListHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import {
  iconChevronRight,
  iconClock,
  iconCurrentLocation,
  iconSearch,
  iconSparkles,
  iconTrash,
  iconX,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Badge from '@/components/ui/Badge.vue';

interface SearchHotKeyword {
  keyword: string;
  reason: string;
}

interface SearchHotCategory {
  name: string;
  keywords: SearchHotKeyword[];
}

interface SearchSuggestionRecord {
  text: string;
}

interface SearchSuggestionCategory {
  label: string;
  records: SearchSuggestionRecord[];
}

interface SearchPaginationState {
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  loaded: boolean;
  total: number | null;
}

interface SearchPlaylistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  creator?: string;
  songCount?: number;
}

interface SearchAlbumCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  artist?: string;
  subtitle?: string;
}

interface SearchArtistCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  songCount?: number;
  albumCount?: number;
}

interface SearchMvCardProps {
  videoId: string | number;
  hash: string;
  title: string;
  coverUrl: string;
  artist?: string;
  duration?: number;
  publishDate?: string;
  albumAudioId?: string | number;
}

const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const route = useRoute();

const searchInput = ref('');
const currentSearchKeyword = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const isLoading = ref(false);
const isLoadingHot = ref(true);
const isLoadingSuggestions = ref(false);
const hasSearched = ref(false);
const showSuggestions = ref(false);
const isIgnoringChanges = ref(false);
const showPinnedTabs = ref(false);
const activeTabIndex = ref(0);
const selectedHotCategoryIndex = ref(0);
const defaultKeyword = ref('');
const hotSearchCategories = ref<SearchHotCategory[]>([]);
const suggestionCategories = ref<SearchSuggestionCategory[]>([]);

const songResults = ref<Song[]>([]);
const playlistResults = ref<PlaylistMeta[]>([]);
const albumResults = ref<AlbumMeta[]>([]);
const artistResults = ref<ArtistMeta[]>([]);
const lyricResults = ref<Song[]>([]);
const mvResults = ref<SearchMvCardProps[]>([]);

const SEARCH_PAGE_SIZE = 30;
const SEARCH_LOAD_MORE_THRESHOLD = 240;
const TAB_SEARCH_TYPES = ['song', 'special', 'album', 'author', 'lyric', 'mv'] as const;

const createSearchPaginationState = (): SearchPaginationState => ({
  page: 1,
  hasMore: false,
  loadingMore: false,
  loading: false,
  loaded: false,
  total: null,
});

const paginationState = reactive<Record<(typeof TAB_SEARCH_TYPES)[number], SearchPaginationState>>({
  song: createSearchPaginationState(),
  special: createSearchPaginationState(),
  album: createSearchPaginationState(),
  author: createSearchPaginationState(),
  lyric: createSearchPaginationState(),
  mv: createSearchPaginationState(),
});

const songSearchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const showSongBatchDrawer = ref(false);
const songSortField = ref<SortField | null>(null);
const songSortOrder = ref<SortOrder>(null);

const showLyricBatchDrawer = ref(false);
const lyricSortField = ref<SortField | null>(null);
const lyricSortOrder = ref<SortOrder>(null);

const pinnedTabHeight = 50;
const songToolbarHeight = 52;
const songToolbarOffset = computed(() => (showPinnedTabs.value ? pinnedTabHeight : 0));
const songListHeaderOffset = computed(() => songToolbarOffset.value + songToolbarHeight);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

let debounceTimer: number | null = null;
const scrollContainerRef = useScrollContainer();
let scrollTarget: HTMLElement | null = null;

const searchHistory = computed(() => settingStore.searchHistory ?? []);
const currentHotKeywords = computed(
  () => hotSearchCategories.value[selectedHotCategoryIndex.value]?.keywords ?? [],
);
const activeSearchType = computed(() => TAB_SEARCH_TYPES[activeTabIndex.value] ?? 'song');
const currentSearchSubtitle = computed(() => currentSearchKeyword.value.trim() || '歌曲搜索');
const activePagination = computed(() => paginationState[activeSearchType.value]);

const sortedSongResults = computed(() => {
  const base = songResults.value.slice();
  if (!songSortField.value || !songSortOrder.value) return base;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  const indexMap = new Map<string, number>();
  songResults.value.forEach((song, index) => {
    indexMap.set(song.id, index);
  });
  const direction = songSortOrder.value === 'asc' ? 1 : -1;

  return base.sort((a, b) => {
    switch (songSortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.album ?? '', b.album ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)) * direction;
      default:
        return 0;
    }
  });
});

const sortedLyricResults = computed(() => {
  const base = lyricResults.value.slice();
  if (!lyricSortField.value || !lyricSortOrder.value) return base;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  const indexMap = new Map<string, number>();
  lyricResults.value.forEach((song, index) => {
    indexMap.set(song.id, index);
  });
  const direction = lyricSortOrder.value === 'asc' ? 1 : -1;

  return base.sort((a, b) => {
    switch (lyricSortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.lyricSnippet ?? '', b.lyricSnippet ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)) * direction;
      default:
        return 0;
    }
  });
});

const songFilteredCount = computed(() => {
  const query = songSearchQuery.value.trim().toLowerCase();
  if (!query) return sortedSongResults.value.length;
  return sortedSongResults.value.filter((song) => {
    return (
      song.title.toLowerCase().includes(query) ||
      song.artist.toLowerCase().includes(query) ||
      song.album?.toLowerCase().includes(query)
    );
  }).length;
});

const songCountLabel = computed(() => {
  const total = songResults.value.length;
  if (!songSearchQuery.value.trim()) return `${total}`;
  return `${songFilteredCount.value} / ${total}`;
});

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
};

const extractSearchLists = (payload: unknown): unknown[] => {
  const record = toRecord(payload);
  const data = toRecord(record?.data);
  const lists = data?.lists ?? data?.list ?? record?.lists ?? record?.list;
  return Array.isArray(lists) ? lists : [];
};

const extractSearchTotal = (payload: unknown): number | null => {
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

// const extractSearchDefaultKeyword = (payload: unknown): string => {
//   const record = toRecord(payload);
//   const data = toRecord(record?.data);
//   const raw = data?.keyword ?? data?.show_keyword ?? data?.fallback ?? '';
//   return typeof raw === 'string' ? raw : String(raw);
// };

const extractHotCategories = (payload: unknown): SearchHotCategory[] => {
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

const extractSuggestionCategories = (payload: unknown): SearchSuggestionCategory[] => {
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

const handleScroll = () => {
  const scrollTop = scrollTarget?.scrollTop ?? 0;
  showPinnedTabs.value = hasSearched.value && activeTabIndex.value !== 0 && scrollTop > 80;
  if (!scrollTarget || isLoading.value || !hasSearched.value) return;
  if (!activePagination.value.loaded || activePagination.value.loading) return;
  const distanceToBottom =
    scrollTarget.scrollHeight - scrollTarget.scrollTop - scrollTarget.clientHeight;
  if (distanceToBottom < SEARCH_LOAD_MORE_THRESHOLD) {
    void loadMoreActiveResults();
  }
};

const attachScrollTarget = async () => {
  await nextTick();
  scrollTarget = scrollContainerRef.value;
  if (scrollTarget) {
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
  }
};

const detachScrollTarget = () => {
  if (scrollTarget) {
    scrollTarget.removeEventListener('scroll', handleScroll);
    scrollTarget = null;
  }
};

const loadHotSearches = async () => {
  isLoadingHot.value = true;
  try {
    const hotRes = await getSearchHot();
    hotSearchCategories.value = extractHotCategories(hotRes);
    defaultKeyword.value = '';
    if (selectedHotCategoryIndex.value >= hotSearchCategories.value.length) {
      selectedHotCategoryIndex.value = 0;
    }
  } catch {
    hotSearchCategories.value = [];
    defaultKeyword.value = '';
  } finally {
    isLoadingHot.value = false;
  }
};

const clearSuggestions = () => {
  suggestionCategories.value = [];
  showSuggestions.value = false;
  isLoadingSuggestions.value = false;
};

const handleInputFocus = () => {
  if (searchInput.value.trim().length > 0) {
    showSuggestions.value = true;
    if (suggestionCategories.value.length === 0 && !isLoadingSuggestions.value) {
      void fetchSuggestions(searchInput.value.trim());
    }
  }
};

const handleInputBlur = () => {
  window.setTimeout(() => {
    showSuggestions.value = false;
  }, 150);
};

const handleSearchChanged = (value: string) => {
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (!value.trim()) {
    clearSuggestions();
    hasSearched.value = false;
    showPinnedTabs.value = false;
    isIgnoringChanges.value = false;
    return;
  }

  if (isIgnoringChanges.value) return;

  isLoadingSuggestions.value = true;
  debounceTimer = window.setTimeout(() => {
    void fetchSuggestions(value.trim());
  }, 300);

  if (hasSearched.value) {
    hasSearched.value = false;
    showPinnedTabs.value = false;
  }
};

const fetchSuggestions = async (keywords: string) => {
  if (!keywords.trim()) return;
  try {
    const res = await getSearchSuggest(keywords);
    if (searchInput.value.trim() !== keywords) return;
    suggestionCategories.value = extractSuggestionCategories(res);
    isLoadingSuggestions.value = false;
    if (document.activeElement === searchInputRef.value) {
      showSuggestions.value = true;
    }
  } catch {
    suggestionCategories.value = [];
    isLoadingSuggestions.value = false;
  }
};

const handleSongSort = (field: SortField) => {
  if (songSortField.value === field) {
    if (songSortOrder.value === 'asc') {
      songSortOrder.value = 'desc';
    } else if (songSortOrder.value === 'desc') {
      songSortField.value = null;
      songSortOrder.value = null;
    }
  } else {
    songSortField.value = field;
    songSortOrder.value = 'asc';
  }
};

const handleLyricSort = (field: SortField) => {
  if (lyricSortField.value === field) {
    if (lyricSortOrder.value === 'asc') {
      lyricSortOrder.value = 'desc';
    } else if (lyricSortOrder.value === 'desc') {
      lyricSortField.value = null;
      lyricSortOrder.value = null;
    }
  } else {
    lyricSortField.value = field;
    lyricSortOrder.value = 'asc';
  }
};

const playSearchSongs = async () => {
  if (songResults.value.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, songResults.value, 0, undefined, {
    queueId: `queue:search:${currentSearchKeyword.value.trim() || 'default'}`,
    title: '搜索结果',
    subtitle: currentSearchSubtitle.value,
    type: 'search',
    dynamic: false,
  });
};

const handleSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, songResults.value, 0, song, {
    queueId: `queue:search:${currentSearchKeyword.value.trim() || 'default'}`,
    title: '搜索结果',
    subtitle: currentSearchSubtitle.value,
    type: 'search',
    dynamic: false,
  });
};

const openSongBatchDrawer = () => {
  if (songResults.value.length === 0) return;
  showSongBatchDrawer.value = true;
};

const playLyricSearchSongs = async () => {
  if (lyricResults.value.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, lyricResults.value, 0, undefined, {
    queueId: `queue:search-lyric:${currentSearchKeyword.value.trim() || 'default'}`,
    title: '歌词搜索',
    subtitle: currentSearchSubtitle.value,
    type: 'search',
    dynamic: false,
  });
};

const openLyricBatchDrawer = () => {
  if (lyricResults.value.length === 0) return;
  showLyricBatchDrawer.value = true;
};

const handleSongLocate = () => songListRef.value?.scrollToActive?.();

const resetPaginationState = () => {
  TAB_SEARCH_TYPES.forEach((type) => {
    paginationState[type].page = 1;
    paginationState[type].hasMore = false;
    paginationState[type].loadingMore = false;
    paginationState[type].loading = false;
    paginationState[type].loaded = false;
    paginationState[type].total = null;
  });
};

const applyPaginationState = (
  type: (typeof TAB_SEARCH_TYPES)[number],
  page: number,
  listLength: number,
  total: number | null,
) => {
  paginationState[type].page = page;
  paginationState[type].total = total;
  paginationState[type].loaded = true;
  paginationState[type].hasMore =
    total !== null ? page * SEARCH_PAGE_SIZE < total : listLength >= SEARCH_PAGE_SIZE;
};

const fetchSearchPage = async (
  keywords: string,
  type: (typeof TAB_SEARCH_TYPES)[number],
  page = 1,
) => {
  const response = await search(keywords, type, page, SEARCH_PAGE_SIZE);
  const lists = extractSearchLists(response);
  const total = extractSearchTotal(response);
  return { lists, total };
};

let latestSearchToken = 0;

const clearSearchResults = () => {
  songResults.value = [];
  playlistResults.value = [];
  albumResults.value = [];
  artistResults.value = [];
  lyricResults.value = [];
  mvResults.value = [];
};

const replaceResultsByType = (type: (typeof TAB_SEARCH_TYPES)[number], lists: unknown[]) => {
  if (type === 'song') {
    songResults.value = lists.map((item) => mapSearchSong(item));
    return;
  }
  if (type === 'special') {
    playlistResults.value = lists.map((item) => mapPlaylistMeta(item));
    return;
  }
  if (type === 'album') {
    albumResults.value = lists.map((item) => mapAlbumMeta(item));
    return;
  }
  if (type === 'lyric') {
    lyricResults.value = lists.map((item) => mapSearchSong(item));
    return;
  }
  if (type === 'mv') {
    mvResults.value = lists.map((item) => mapMvSearchItem(item));
    return;
  }
  artistResults.value = lists.map((item) => mapArtistMeta(item));
};

const appendResultsByType = (type: (typeof TAB_SEARCH_TYPES)[number], lists: unknown[]) => {
  if (type === 'song') {
    songResults.value = songResults.value.concat(lists.map((item) => mapSearchSong(item)));
    return;
  }
  if (type === 'special') {
    playlistResults.value = playlistResults.value.concat(
      lists.map((item) => mapPlaylistMeta(item)),
    );
    return;
  }
  if (type === 'album') {
    albumResults.value = albumResults.value.concat(lists.map((item) => mapAlbumMeta(item)));
    return;
  }
  if (type === 'lyric') {
    lyricResults.value = lyricResults.value.concat(lists.map((item) => mapSearchSong(item)));
    return;
  }
  if (type === 'mv') {
    mvResults.value = mvResults.value.concat(lists.map((item) => mapMvSearchItem(item)));
    return;
  }
  artistResults.value = artistResults.value.concat(lists.map((item) => mapArtistMeta(item)));
};

const loadSearchResults = async (
  type: (typeof TAB_SEARCH_TYPES)[number],
  options?: {
    token?: number;
    keywords?: string;
    useGlobalLoading?: boolean;
  },
) => {
  const state = paginationState[type];
  const token = options?.token ?? latestSearchToken;
  const keywords = (options?.keywords ?? currentSearchKeyword.value).trim();

  if (!keywords || state.loading) return;

  state.loading = true;
  if (options?.useGlobalLoading) {
    isLoading.value = true;
  }

  try {
    const { lists, total } = await fetchSearchPage(keywords, type, 1);
    if (token !== latestSearchToken) return;

    replaceResultsByType(type, lists);
    applyPaginationState(type, 1, lists.length, total);
  } catch {
    if (token !== latestSearchToken) return;
    replaceResultsByType(type, []);
    state.page = 1;
    state.total = null;
    state.hasMore = false;
    state.loaded = true;
  } finally {
    if (token === latestSearchToken) {
      state.loading = false;
      if (options?.useGlobalLoading) {
        isLoading.value = false;
      }
      await nextTick();
      handleScroll();
    }
  }
};

const loadMoreActiveResults = async () => {
  const type = activeSearchType.value;
  const keywords = currentSearchKeyword.value.trim();
  const state = paginationState[type];

  if (!keywords || !state.loaded || state.loading || !state.hasMore || state.loadingMore) return;

  state.loadingMore = true;
  const token = latestSearchToken;
  const nextPage = state.page + 1;

  try {
    const { lists, total } = await fetchSearchPage(keywords, type, nextPage);
    if (token !== latestSearchToken) return;

    appendResultsByType(type, lists);
    applyPaginationState(type, nextPage, lists.length, total);
  } catch {
    paginationState[type].hasMore = false;
  } finally {
    if (token === latestSearchToken) {
      paginationState[type].loadingMore = false;
      await nextTick();
      handleScroll();
    }
  }
};

const runSearch = async (keyword?: string) => {
  const keywords = (keyword ?? searchInput.value).trim();
  if (!keywords && defaultKeyword.value) {
    await runSearch(defaultKeyword.value);
    return;
  }
  if (!keywords) return;

  isIgnoringChanges.value = true;
  if (keyword !== undefined) {
    searchInput.value = keyword;
  }

  currentSearchKeyword.value = keywords;
  latestSearchToken += 1;
  const searchToken = latestSearchToken;
  isLoading.value = true;
  hasSearched.value = true;
  showSuggestions.value = false;
  songSortField.value = null;
  songSortOrder.value = null;
  lyricSortField.value = null;
  lyricSortOrder.value = null;
  songSearchQuery.value = '';
  clearSearchResults();
  resetPaginationState();
  searchInputRef.value?.blur();
  settingStore.addToSearchHistory(keywords);

  try {
    await loadSearchResults(activeSearchType.value, {
      token: searchToken,
      keywords,
      useGlobalLoading: true,
    });
  } catch {
    clearSearchResults();
    resetPaginationState();
  } finally {
    if (searchToken === latestSearchToken) {
      window.setTimeout(() => {
        if (searchToken === latestSearchToken) {
          isIgnoringChanges.value = false;
        }
      }, 100);
      await nextTick();
      handleScroll();
    }
  }
};

const resolvePlaylistRouteId = (entry: PlaylistMeta) => {
  return entry.listCreateGid || entry.globalCollectionId || entry.listCreateListid || entry.id;
};

const getPlaylistCardProps = (entry: PlaylistMeta): SearchPlaylistCardProps => {
  return {
    id: resolvePlaylistRouteId(entry),
    name: entry.name,
    coverUrl: entry.pic,
    creator: entry.nickname,
    songCount: entry.count,
  };
};

const getAlbumCardProps = (album: AlbumMeta): SearchAlbumCardProps => {
  return {
    id: album.id,
    name: album.name,
    coverUrl: album.pic,
    artist: album.singerName,
    subtitle: [album.singerName, album.songCount ? `${album.songCount} 首歌曲` : '']
      .filter(Boolean)
      .join(' • '),
  };
};

const getArtistCardProps = (artist: ArtistMeta): SearchArtistCardProps => {
  return {
    id: artist.id,
    name: artist.name,
    coverUrl: artist.pic,
    songCount: artist.songCount,
    albumCount: artist.albumCount,
  };
};

const mapMvSearchItem = (json: unknown): SearchMvCardProps => {
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

const playlistCards = computed(() =>
  playlistResults.value.map((entry) => getPlaylistCardProps(entry)),
);
const albumCards = computed(() => albumResults.value.map((entry) => getAlbumCardProps(entry)));
const artistCards = computed(() => artistResults.value.map((entry) => getArtistCardProps(entry)));
const mvCards = computed(() => mvResults.value);

onMounted(async () => {
  await loadHotSearches();
  await attachScrollTarget();

  // 从标题栏搜索跳转过来时，自动执行搜索
  const queryKeyword = route.query.q;
  if (typeof queryKeyword === 'string' && queryKeyword.trim()) {
    await runSearch(queryKeyword.trim());
  }
});

watch(
  () => activeTabIndex.value,
  () => {
    nextTick(() => {
      handleScroll();
    });
    if (!hasSearched.value) return;
    const type = activeSearchType.value;
    const state = paginationState[type];
    if (!state.loaded && !state.loading) {
      void loadSearchResults(type);
    }
  },
);

onUnmounted(() => {
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  detachScrollTarget();
});
</script>

<template>
  <PageScrollContainer class="search-view-container">
    <div class="search-view relative pb-10">
      <div v-if="showPinnedTabs" class="search-pinned-tabs sticky top-0 z-140">
        <div class="px-10 py-1.5">
          <CustomTabBar
            v-model="activeTabIndex"
            :tabs="['单曲', '歌单', '专辑', '歌手', '歌词', 'MV']"
          />
        </div>
      </div>

      <div v-show="!showPinnedTabs" class="px-10 pt-4">
        <div class="text-[22px] font-semibold text-text-main tracking-tight">搜索</div>

        <div class="search-input-shell mt-6" :class="{ 'has-suggestions': showSuggestions }">
          <div class="search-input-wrap">
            <Icon :icon="iconSearch" width="18" height="18" class="search-input-icon" />
            <input
              ref="searchInputRef"
              v-model="searchInput"
              type="text"
              class="search-input"
              :placeholder="defaultKeyword ? `搜索: ${defaultKeyword}` : '搜索音乐、歌手、专辑'"
              @focus="handleInputFocus"
              @blur="handleInputBlur"
              @input="handleSearchChanged(searchInput)"
              @keydown.enter.prevent="runSearch()"
            />
            <Button
              variant="unstyled"
              size="none"
              v-if="searchInput"
              type="button"
              class="search-clear-btn"
              @mousedown.prevent
              @click="
                searchInput = '';
                handleSearchChanged('');
                searchInputRef?.focus();
              "
            >
              <Icon :icon="iconX" width="16" height="16" />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="search-submit-btn"
              @click="runSearch()"
              >搜索</Button
            >
          </div>

          <div v-if="showSuggestions" class="search-suggestions-panel">
            <div
              v-if="isLoadingSuggestions && suggestionCategories.length === 0"
              class="search-suggestions-empty"
            >
              加载中...
            </div>
            <div v-else-if="suggestionCategories.length === 0" class="search-suggestions-empty">
              暂无建议
            </div>
            <Scrollbar v-else class="search-suggestions-list">
              <div class="search-suggestions-list-inner">
                <div
                  v-for="category in suggestionCategories"
                  :key="category.label"
                  class="search-suggestion-group"
                >
                  <div class="search-suggestion-title">{{ category.label }}</div>
                  <Button
                    variant="unstyled"
                    size="none"
                    v-for="record in category.records"
                    :key="`${category.label}-${record.text}`"
                    type="button"
                    class="search-suggestion-item"
                    @mousedown.prevent
                    @click="runSearch(record.text)"
                  >
                    <span class="search-suggestion-leading">
                      <Icon :icon="iconSearch" width="14" height="14" class="opacity-60" />
                    </span>
                    <span class="search-suggestion-text truncate">{{ record.text }}</span>
                    <span class="search-suggestion-trailing">
                      <Icon :icon="iconChevronRight" width="13" height="13" />
                    </span>
                  </Button>
                </div>
              </div>
            </Scrollbar>
          </div>
        </div>

        <div v-if="hasSearched" class="mt-6">
          <CustomTabBar
            v-model="activeTabIndex"
            :tabs="['单曲', '歌单', '专辑', '歌手', '歌词', 'MV']"
          />
        </div>
      </div>

      <div v-if="!hasSearched" class="px-10 pt-4">
        <div v-if="isLoadingHot" class="search-placeholder">加载中...</div>
        <template v-else>
          <div v-if="searchHistory.length > 0" class="search-section">
            <div class="search-section-header">
              <div class="search-section-title">历史搜索</div>
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="search-history-clear"
                @click="settingStore.clearSearchHistory()"
              >
                <Icon :icon="iconTrash" width="16" height="16" />
              </Button>
            </div>
            <div class="search-chip-wrap">
              <Button
                variant="unstyled"
                size="none"
                v-for="keyword in searchHistory"
                :key="keyword"
                type="button"
                class="history-chip"
                @click="runSearch(keyword)"
              >
                <span class="history-chip-icon">
                  <Icon :icon="iconClock" width="11" height="11" />
                </span>
                <span class="truncate">{{ keyword }}</span>
                <span
                  class="history-chip-close"
                  @click.stop="settingStore.removeFromSearchHistory(keyword)"
                >
                  <Icon :icon="iconX" width="10" height="10" />
                </span>
              </Button>
            </div>
          </div>

          <div class="search-section">
            <div class="search-section-title">热门搜索</div>
            <div v-if="hotSearchCategories.length > 0" class="search-hot-tabs">
              <Button
                variant="unstyled"
                size="none"
                v-for="(category, index) in hotSearchCategories"
                :key="category.name"
                type="button"
                class="search-hot-tab"
                :class="{ active: selectedHotCategoryIndex === index }"
                @click="selectedHotCategoryIndex = index"
              >
                {{ category.name }}
              </Button>
            </div>
            <div class="search-chip-wrap mt-5">
              <Button
                variant="unstyled"
                size="none"
                v-for="item in currentHotKeywords"
                :key="`${item.keyword}-${item.reason}`"
                type="button"
                class="hot-chip"
                @click="runSearch(item.keyword)"
              >
                <span>{{ item.keyword }}</span>
                <template v-if="item.reason && item.reason !== item.keyword">
                  <span class="opacity-40">•</span>
                  <span class="hot-chip-reason">{{ item.reason }}</span>
                </template>
              </Button>
            </div>
          </div>
        </template>
      </div>

      <div v-else-if="isLoading" class="search-loading-wrap">
        <div
          class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>

      <div v-else class="px-10 pt-4">
        <div v-if="activeTabIndex === 0">
          <div
            class="search-song-toolbar sticky z-120 bg-bg-main"
            :style="{ top: `${songToolbarOffset}px` }"
          >
            <div class="search-song-toolbar-inner">
              <div class="search-song-title-wrap">
                <div class="search-song-badge-icon">
                  <Icon :icon="iconSparkles" width="16" height="16" />
                </div>
                <div class="text-[15px] font-semibold text-text-main leading-none">热门单曲</div>
              </div>
              <div class="search-song-toolbar-actions">
                <div class="overflow-x-auto">
                  <ActionRow @play="playSearchSongs" @batch="openSongBatchDrawer" />
                </div>
              </div>
            </div>
          </div>

          <BatchActionDrawer
            v-model:open="showSongBatchDrawer"
            :songs="songResults"
            source-id="search"
          />

          <div
            class="song-list-sticky sticky z-110 bg-bg-main"
            :style="{ top: `${songListHeaderOffset}px` }"
          >
            <div class="border-b border-border-light/10">
              <div class="flex items-center justify-between h-14">
                <div class="rank-song-tab">
                  <span class="rank-song-label relative"
                    >歌曲 <Badge :count="songCountLabel"
                  /></span>
                </div>
                <div class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="songSearchQuery"
                      type="text"
                      placeholder="搜索歌曲..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg bg-white border border-black/30 shadow-sm text-text-main placeholder:text-text-main/50 dark:bg-white/8 dark:border-white/10 dark:shadow-none outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
                  </div>
                  <Button
                    variant="unstyled"
                    size="none"
                    @click="handleSongLocate"
                    class="song-locate-btn p-2 rounded-lg"
                    title="定位当前播放"
                  >
                    <Icon :icon="iconCurrentLocation" width="16" height="16" />
                  </Button>
                </div>
              </div>
            </div>

            <SongListHeader
              :sortField="songSortField"
              :sortOrder="songSortOrder"
              :showCover="true"
              paddingClass="px-0"
              @sort="handleSongSort"
            />
          </div>

          <div class="pb-12">
            <SongList
              ref="songListRef"
              class="search-song-list"
              :songs="sortedSongResults"
              :searchQuery="songSearchQuery"
              :activeId="activeSongId"
              :showCover="true"
              :queueOptions="{
                queueId: `queue:search:${currentSearchKeyword.trim() || 'default'}`,
                title: '搜索结果',
                subtitle: currentSearchSubtitle,
                type: 'search',
                dynamic: false,
              }"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
              "
              rowPaddingClass="px-0"
            />
            <div
              v-if="activePagination.loadingMore || activePagination.hasMore"
              class="search-load-more-status"
            >
              {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
            </div>
            <div
              v-else-if="songResults.length > 0"
              class="search-load-more-status search-load-more-status--end"
            >
              没有更多结果了
            </div>
          </div>
        </div>

        <div v-else-if="activeTabIndex === 1">
          <VirtualGrid
            class="pb-6"
            :items="playlistCards"
            :loading="paginationState.special.loading && !paginationState.special.loaded"
            :active="activeTabIndex === 1"
            :itemMinWidth="180"
            :itemAspectRatio="1"
            :itemChromeHeight="66"
            :gap="20"
            :overscan="3"
            :stateMinHeight="320"
            emptyText="暂无搜索结果"
            keyField="id"
          >
            <template #default="{ item }">
              <PlaylistCard v-bind="item" layout="grid" />
            </template>
          </VirtualGrid>
          <div
            v-if="activePagination.loadingMore || activePagination.hasMore"
            class="search-load-more-status"
          >
            {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
          </div>
          <div
            v-else-if="playlistResults.length > 0"
            class="search-load-more-status search-load-more-status--end"
          >
            没有更多结果了
          </div>
        </div>

        <div v-else-if="activeTabIndex === 2">
          <VirtualGrid
            class="pb-6"
            :items="albumCards"
            :loading="paginationState.album.loading && !paginationState.album.loaded"
            :active="activeTabIndex === 2"
            :itemMinWidth="180"
            :itemAspectRatio="1"
            :itemChromeHeight="66"
            :gap="20"
            :overscan="3"
            :stateMinHeight="320"
            emptyText="暂无搜索结果"
            keyField="id"
          >
            <template #default="{ item }">
              <AlbumCard v-bind="item" />
            </template>
          </VirtualGrid>
          <div
            v-if="activePagination.loadingMore || activePagination.hasMore"
            class="search-load-more-status"
          >
            {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
          </div>
          <div
            v-else-if="albumResults.length > 0"
            class="search-load-more-status search-load-more-status--end"
          >
            没有更多结果了
          </div>
        </div>

        <div v-else-if="activeTabIndex === 3">
          <VirtualGrid
            class="pb-6"
            :items="artistCards"
            :loading="paginationState.author.loading && !paginationState.author.loaded"
            :active="activeTabIndex === 3"
            :itemMinWidth="180"
            :itemHeight="218"
            :gap="20"
            :overscan="3"
            :stateMinHeight="320"
            emptyText="暂无搜索结果"
            keyField="id"
          >
            <template #default="{ item }">
              <ArtistCard v-bind="item" />
            </template>
          </VirtualGrid>
          <div
            v-if="activePagination.loadingMore || activePagination.hasMore"
            class="search-load-more-status"
          >
            {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
          </div>
          <div
            v-else-if="artistResults.length > 0"
            class="search-load-more-status search-load-more-status--end"
          >
            没有更多结果了
          </div>
        </div>

        <div v-else-if="activeTabIndex === 4">
          <div
            class="search-song-toolbar sticky z-120 bg-bg-main"
            :style="{ top: `${songToolbarOffset}px` }"
          >
            <div class="search-song-toolbar-inner">
              <div class="search-song-title-wrap">
                <div class="search-song-badge-icon">
                  <Icon :icon="iconSparkles" width="16" height="16" />
                </div>
                <div class="text-[15px] font-semibold text-text-main leading-none">歌词搜索</div>
              </div>
              <div class="search-song-toolbar-actions">
                <div class="overflow-x-auto">
                  <ActionRow @play="playLyricSearchSongs" @batch="openLyricBatchDrawer" />
                </div>
              </div>
            </div>
          </div>

          <BatchActionDrawer
            v-model:open="showLyricBatchDrawer"
            :songs="lyricResults"
            source-id="search-lyric"
          />

          <div
            class="song-list-sticky sticky z-110 bg-bg-main"
            :style="{ top: `${songListHeaderOffset}px` }"
          >
            <SongListHeader
              :sortField="lyricSortField"
              :sortOrder="lyricSortOrder"
              :showCover="true"
              :lyricColumn="true"
              albumLabel="歌词"
              paddingClass="px-0"
              @sort="handleLyricSort"
            />
          </div>

          <div class="pb-12">
            <SongList
              class="search-song-list"
              :songs="sortedLyricResults"
              :activeId="activeSongId"
              :showCover="true"
              :showLyricColumn="true"
              :queueOptions="{
                queueId: `queue:search-lyric:${currentSearchKeyword.trim() || 'default'}`,
                title: '歌词搜索',
                subtitle: currentSearchSubtitle,
                type: 'search',
                dynamic: false,
              }"
              :enableDefaultDoubleTapPlay="true"
              rowPaddingClass="px-0"
            />
            <div
              v-if="activePagination.loadingMore || activePagination.hasMore"
              class="search-load-more-status"
            >
              {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
            </div>
            <div
              v-else-if="lyricResults.length > 0"
              class="search-load-more-status search-load-more-status--end"
            >
              没有更多结果了
            </div>
          </div>
        </div>

        <div v-else>
          <VirtualGrid
            class="pb-6"
            :items="mvCards"
            :loading="paginationState.mv.loading && !paginationState.mv.loaded"
            :active="activeTabIndex === 5"
            :itemMinWidth="220"
            :itemAspectRatio="1.78"
            :itemChromeHeight="50"
            :gap="20"
            :overscan="3"
            :stateMinHeight="320"
            emptyText="暂无搜索结果"
            keyField="videoId"
          >
            <template #default="{ item }">
              <MvCard v-bind="item" />
            </template>
          </VirtualGrid>
          <div
            v-if="activePagination.loadingMore || activePagination.hasMore"
            class="search-load-more-status"
          >
            {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
          </div>
          <div
            v-else-if="mvResults.length > 0"
            class="search-load-more-status search-load-more-status--end"
          >
            没有更多结果了
          </div>
        </div>
      </div>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.search-pinned-tabs {
  background: var(--color-bg-main);
  border-bottom: 0.5px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
}

.search-view {
  position: relative;
  isolation: isolate;
}

.search-input-shell {
  position: relative;
  z-index: 220;
}

.search-input-shell.has-suggestions {
  z-index: 260;
}

.search-input-wrap {
  height: 44px;
  display: flex;
  align-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-text-main) 10%, transparent);
  padding-left: 12px;
}

.search-input-icon {
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  padding: 0 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-main);
}

.search-input::placeholder {
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}

.search-clear-btn {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
  transition: all 0.2s ease;
}

.search-clear-btn:hover {
  color: var(--color-text-main);
}

.search-submit-btn {
  margin: 4px;
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--color-primary);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
}

.search-suggestions-panel {
  position: absolute;
  top: 48px;
  left: 0;
  width: 100%;
  max-height: 400px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 82%, transparent);
  box-shadow:
    0 10px 24px rgba(0, 0, 0, 0.14),
    0 2px 8px rgba(0, 0, 0, 0.06);
  background: var(--color-bg-card);
  backdrop-filter: blur(18px);
  z-index: 260;
}

.search-suggestions-list {
  max-height: 400px;
  min-height: 0;
}

.search-suggestions-list-inner {
  padding: 8px 0 10px;
}

.search-suggestions-empty {
  min-height: 88px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 500;
  color: color-mix(in srgb, var(--color-text-main) 58%, transparent);
}

.search-suggestion-group + .search-suggestion-group {
  margin-top: 6px;
}

.search-suggestion-group + .search-suggestion-group .search-suggestion-title {
  border-top: 0.5px solid color-mix(in srgb, var(--color-border-light) 70%, transparent);
  margin-top: 2px;
}

.search-suggestion-title {
  padding: 12px 16px 6px;
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-primary) 82%, transparent);
  letter-spacing: 0.5px;
}

.search-suggestion-item {
  width: calc(100% - 16px);
  margin: 0 8px;
  min-height: 38px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.18s ease;
}

.search-suggestion-item:hover {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-primary);
}

.search-suggestion-leading {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 62%, transparent);
}

.search-suggestion-text {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.search-suggestion-trailing {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
  opacity: 0;
  transform: translateX(-2px);
  transition: all 0.18s ease;
}

.search-suggestion-item:hover .search-suggestion-trailing {
  opacity: 1;
  transform: translateX(0);
}

.search-section + .search-section {
  margin-top: 32px;
}

.search-section-header {
  display: flex;
  align-items: center;
}

.search-section-title {
  font-size: 15px;
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-main) 88%, transparent);
}

.search-history-clear {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
  transition: all 0.18s ease;
}

.search-history-clear:hover {
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
  color: var(--color-text-main);
}

.search-chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.history-chip,
.hot-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--color-text-main) 10%, transparent);
  color: color-mix(in srgb, var(--color-text-main) 90%, transparent);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.18s ease;
}

.history-chip {
  padding: 6px 8px 6px 10px;
}

.history-chip:hover,
.hot-chip:hover {
  background: color-mix(in srgb, var(--color-text-main) 14%, transparent);
  transform: translateY(-1px);
}

.hot-chip {
  padding: 6px 12px;
  border: 0.8px solid color-mix(in srgb, var(--color-border-light) 92%, transparent);
}

.history-chip-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 48%, transparent);
}

.history-chip-close {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
  transition: all 0.18s ease;
}

.history-chip-close:hover {
  color: var(--color-text-main);
}

.hot-chip-reason {
  font-size: 10px;
  color: color-mix(in srgb, var(--color-text-main) 48%, transparent);
  font-weight: 500;
}

.search-hot-tabs {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 2px;
  margin-top: 16px;
}

.search-hot-tab {
  flex-shrink: 0;
  min-height: 30px;
  padding: 0 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-main) 10%, transparent);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.18s ease;
}

.search-hot-tab:hover {
  background: color-mix(in srgb, var(--color-text-main) 14%, transparent);
}

.search-hot-tab.active {
  background: var(--color-primary);
  color: #ffffff;
}

.search-loading-wrap,
.search-placeholder {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 16px;
}

.search-placeholder {
  font-size: 14px;
  font-weight: 500;
  color: color-mix(in srgb, var(--color-text-main) 45%, transparent);
}

.search-song-list {
  width: 100%;
}

.search-song-list :deep(.song-list-container) {
  width: 100%;
}

.search-song-toolbar {
  background: var(--color-bg-main);
}

.search-song-toolbar-inner {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0 6px;
}

.search-song-title-wrap {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-song-badge-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  border-radius: 8px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--color-primary) 92%, white),
    var(--color-secondary)
  );
}

.search-song-toolbar-actions {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: flex-end;
}

.search-load-more-status {
  padding: 8px 0 20px;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  color: color-mix(in srgb, var(--color-text-main) 48%, transparent);
}

.search-load-more-status--end {
  color: color-mix(in srgb, var(--color-text-main) 38%, transparent);
}

.rank-song-tab {
  position: relative;
  display: inline-flex;
  align-items: flex-end;
  height: 36px;
}

.rank-song-label {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
  padding-bottom: 6px;
}

.rank-song-label::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 70%, transparent);
}
</style>
