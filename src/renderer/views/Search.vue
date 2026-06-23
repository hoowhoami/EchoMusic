<script setup lang="ts">
defineOptions({ name: 'search-page' });
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getSearchHot, getSearchSuggest, search } from '@/api/search';
import { useSettingStore } from '@/stores/setting';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { PlaylistMeta } from '@/models/playlist';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import {
  appendResultsByType,
  createSearchPaginationState,
  extractHotCategories,
  extractSearchLists,
  extractSearchTotal,
  extractSuggestionCategories,
  getAlbumCardProps,
  getArtistCardProps,
  getPlaylistCardProps,
  replaceResultsByType as applyResultsByType,
  SEARCH_PAGE_SIZE,
  TAB_SEARCH_TYPES,
  type SearchTabType,
} from './search/searchHelpers';
import type {
  SearchHotCategory,
  SearchMvCardProps,
  SearchPaginationState,
  SearchSuggestionCategory,
} from './search/types';
import SearchHeader from './search/components/SearchHeader.vue';
import SearchDiscovery from './search/components/SearchDiscovery.vue';
import SearchGridResultsPanel from './search/components/SearchGridResultsPanel.vue';
import SearchLoadMoreStatus from './search/components/SearchLoadMoreStatus.vue';
import SearchSongResultsPanel from './search/components/SearchSongResultsPanel.vue';

const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const route = useRoute();
const router = useRouter();

const searchInput = ref('');
const currentSearchKeyword = ref('');
const searchHeaderRef = ref<InstanceType<typeof SearchHeader> | null>(null);
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
const resultRefs = {
  songResults,
  playlistResults,
  albumResults,
  artistResults,
  lyricResults,
  mvResults,
};

const paginationState = reactive<Record<SearchTabType, SearchPaginationState>>({
  song: createSearchPaginationState(),
  special: createSearchPaginationState(),
  album: createSearchPaginationState(),
  author: createSearchPaginationState(),
  lyric: createSearchPaginationState(),
  mv: createSearchPaginationState(),
});

const songSearchQuery = ref('');
const songSortField = ref<SortField | null>(null);
const songSortOrder = ref<SortOrder>(null);
const songResultsPanelRef = ref<{ scrollToActive?: () => void } | null>(null);

const lyricSortField = ref<SortField | null>(null);
const lyricSortOrder = ref<SortOrder>(null);

const pinnedTabHeight = 50;
const songToolbarOffset = computed(() => (showPinnedTabs.value ? pinnedTabHeight : 0));
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
  return sortSongs(songResults.value, songSortField.value, songSortOrder.value, {
    indexSource: songResults.value,
  });
});
const filteredSongResults = computed(() =>
  filterSongsByQuery(sortedSongResults.value, songSearchQuery.value),
);

const sortedLyricResults = computed(() => {
  return sortSongs(lyricResults.value, lyricSortField.value, lyricSortOrder.value, {
    indexSource: lyricResults.value,
    albumAccessor: (song) => song.lyricSnippet ?? '',
  });
});

const songFilteredCount = computed(() => {
  return filteredSongResults.value.length;
});

const songCountLabel = computed(() => {
  const total = songResults.value.length;
  if (!songSearchQuery.value.trim()) return `${total}`;
  return `${songFilteredCount.value} / ${total}`;
});

const handleScroll = () => {
  const scrollTop = scrollTarget?.scrollTop ?? 0;
  showPinnedTabs.value = hasSearched.value && activeTabIndex.value !== 0 && scrollTop > 80;
};

// 使用 IntersectionObserver 检测"加载更多"元素进入视口，比 scroll 距离检测更可靠
const loadMoreSentinelRef = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;

const setupLoadMoreObserver = () => {
  loadMoreObserver?.disconnect();
  const root = scrollTarget ?? scrollContainerRef.value ?? null;
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      if (isLoading.value || !hasSearched.value) return;
      if (!activePagination.value.loaded || activePagination.value.loading) return;
      void loadMoreActiveResults();
    },
    { root, rootMargin: '0px 0px 240px 0px' },
  );
  if (loadMoreSentinelRef.value) {
    loadMoreObserver.observe(loadMoreSentinelRef.value);
  }
};

watch(loadMoreSentinelRef, (el) => {
  if (!loadMoreObserver) {
    setupLoadMoreObserver();
    return;
  }
  loadMoreObserver.disconnect();
  if (el) loadMoreObserver.observe(el);
});

const attachScrollTarget = async () => {
  await nextTick();
  scrollTarget = scrollContainerRef.value;
  if (scrollTarget) {
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    setupLoadMoreObserver();
    handleScroll();
  }
};

const detachScrollTarget = () => {
  if (scrollTarget) {
    scrollTarget.removeEventListener('scroll', handleScroll);
    scrollTarget = null;
  }
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
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
    clearSearchResults();
    resetPaginationState();
    currentSearchKeyword.value = '';
    clearSuggestions();
    hasSearched.value = false;
    showPinnedTabs.value = false;
    isIgnoringChanges.value = false;
    if (route.query.q !== undefined) {
      void router.replace({ name: 'search', query: {} });
    }
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
    if (document.activeElement === searchHeaderRef.value?.inputRef) {
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
  const queueSongs = filteredSongResults.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: `queue:search:${currentSearchKeyword.value.trim() || 'default'}`,
    title: '搜索结果',
    subtitle: currentSearchSubtitle.value,
    type: 'search',
    dynamic: false,
  });
};

const playLyricSearchSongs = async () => {
  const queueSongs = sortedLyricResults.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: `queue:search-lyric:${currentSearchKeyword.value.trim() || 'default'}`,
    title: '歌词搜索',
    subtitle: currentSearchSubtitle.value,
    type: 'search',
    dynamic: false,
  });
};

const setLoadMoreSentinelRef = (el: Element | ComponentPublicInstance | null) => {
  loadMoreSentinelRef.value = el instanceof HTMLElement ? el : null;
};

const handleSongLocate = () => songResultsPanelRef.value?.scrollToActive?.();

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
  type: SearchTabType,
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

const fetchSearchPage = async (keywords: string, type: SearchTabType, page = 1) => {
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

const replaceResultsByType = (type: SearchTabType, lists: unknown[]) => {
  applyResultsByType(type, lists, resultRefs);
};

const loadSearchResults = async (
  type: SearchTabType,
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

    appendResultsByType(type, lists, resultRefs);
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
  searchHeaderRef.value?.inputRef?.blur();
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

const playlistCards = computed(() =>
  playlistResults.value.map((entry) => getPlaylistCardProps(entry)),
);
const albumCards = computed(() => albumResults.value.map((entry) => getAlbumCardProps(entry)));
const artistCards = computed(() => artistResults.value.map((entry) => getArtistCardProps(entry)));
const mvCards = computed(() => mvResults.value);

onMounted(async () => {
  await loadHotSearches();
  await attachScrollTarget();
});

watch(
  () => route.query.q,
  (queryKeyword) => {
    const keyword = typeof queryKeyword === 'string' ? queryKeyword.trim() : '';

    if (!keyword) {
      searchInput.value = '';
      currentSearchKeyword.value = '';
      clearSearchResults();
      resetPaginationState();
      clearSuggestions();
      hasSearched.value = false;
      showPinnedTabs.value = false;
      isIgnoringChanges.value = false;
      return;
    }

    searchInput.value = keyword;
    if (keyword === currentSearchKeyword.value.trim() && hasSearched.value) {
      return;
    }

    void runSearch(keyword);
  },
  { immediate: true },
);

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

// 响应滚动容器变化（PageScrollContainer 延迟 provide 时重新绑定）
watch(scrollContainerRef, () => {
  detachScrollTarget();
  scrollTarget = scrollContainerRef.value;
  if (scrollTarget) {
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
  }
  // root 变了，需要重建 observer
  setupLoadMoreObserver();
});

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
      <SearchHeader
        ref="searchHeaderRef"
        :active-tab-index="activeTabIndex"
        :default-keyword="defaultKeyword"
        :has-searched="hasSearched"
        :is-loading-suggestions="isLoadingSuggestions"
        :search-input="searchInput"
        :show-pinned-tabs="showPinnedTabs"
        :show-suggestions="showSuggestions"
        :suggestion-categories="suggestionCategories"
        :tabs="['单曲', '歌单', '专辑', '歌手', '歌词', 'MV']"
        @blur="handleInputBlur"
        @clear="
          searchInput = '';
          handleSearchChanged('');
          searchHeaderRef?.inputRef?.focus();
        "
        @focus="handleInputFocus"
        @pick-suggestion="runSearch($event)"
        @submit="runSearch()"
        @update:active-tab-index="activeTabIndex = $event"
        @update:search-input="
          searchInput = $event;
          handleSearchChanged($event);
        "
      />

      <SearchDiscovery
        v-if="!hasSearched"
        :current-hot-keywords="currentHotKeywords"
        :hot-search-categories="hotSearchCategories"
        :is-loading-hot="isLoadingHot"
        :search-history="searchHistory"
        :selected-hot-category-index="selectedHotCategoryIndex"
        @clear-history="settingStore.clearSearchHistory()"
        @pick-keyword="runSearch($event)"
        @remove-history="settingStore.removeFromSearchHistory($event)"
        @update:selected-hot-category-index="selectedHotCategoryIndex = $event"
      />

      <div v-else-if="isLoading" class="search-loading-wrap">
        <div
          class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>

      <div v-else class="px-10 pt-4">
        <div v-if="activeTabIndex === 0">
          <SearchSongResultsPanel
            ref="songResultsPanelRef"
            :active-song-id="activeSongId"
            :current-search-keyword="currentSearchKeyword"
            :current-search-subtitle="currentSearchSubtitle"
            :enable-locate="true"
            :enable-search-query="true"
            :queue-id-prefix="'queue:search'"
            :row-title="'搜索结果'"
            :search-query="songSearchQuery"
            :songs="filteredSongResults"
            :sort-field="songSortField"
            :sort-order="songSortOrder"
            :sorted-songs="sortedSongResults"
            :sticky-top="songToolbarOffset"
            :subtitle-label="songCountLabel"
            @locate="handleSongLocate"
            @play="playSearchSongs"
            @song-search-change="songSearchQuery = $event"
            @sort="handleSongSort"
          />
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="songResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>

        <div v-else-if="activeTabIndex === 1">
          <SearchGridResultsPanel
            :items="playlistCards"
            :loading="paginationState.special.loading && !paginationState.special.loaded"
            :active="activeTabIndex === 1"
            :item-min-width="180"
            :item-aspect-ratio="1"
            :item-chrome-height="66"
            :gap="20"
            key-field="id"
          >
            <template #default="{ item }">
              <PlaylistCard
                :id="item.id"
                :name="item.name"
                :cover-url="item.coverUrl"
                :creator="item.creator"
                :song-count="item.songCount"
                layout="grid"
              />
            </template>
          </SearchGridResultsPanel>
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="playlistResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>

        <div v-else-if="activeTabIndex === 2">
          <SearchGridResultsPanel
            :items="albumCards"
            :loading="paginationState.album.loading && !paginationState.album.loaded"
            :active="activeTabIndex === 2"
            :item-min-width="180"
            :item-aspect-ratio="1"
            :item-chrome-height="66"
            :gap="20"
            key-field="id"
          >
            <template #default="{ item }">
              <AlbumCard
                :id="item.id"
                :name="item.name"
                :cover-url="item.coverUrl"
                :artist="item.artist"
                :subtitle="item.subtitle"
              />
            </template>
          </SearchGridResultsPanel>
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="albumResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>

        <div v-else-if="activeTabIndex === 3">
          <SearchGridResultsPanel
            :items="artistCards"
            :loading="paginationState.author.loading && !paginationState.author.loaded"
            :active="activeTabIndex === 3"
            :item-min-width="180"
            :item-aspect-ratio="1"
            :item-chrome-height="68"
            :gap="20"
            key-field="id"
          >
            <template #default="{ item }">
              <ArtistCard
                :id="item.id"
                :name="item.name"
                :cover-url="item.coverUrl"
                :song-count="item.songCount"
                :album-count="item.albumCount"
              />
            </template>
          </SearchGridResultsPanel>
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="artistResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>

        <div v-else-if="activeTabIndex === 4">
          <SearchSongResultsPanel
            :active-song-id="activeSongId"
            :current-search-keyword="currentSearchKeyword"
            :current-search-subtitle="currentSearchSubtitle"
            :queue-id-prefix="'queue:search-lyric'"
            :row-title="'歌词搜索'"
            :show-lyric-column="true"
            :songs="sortedLyricResults"
            :sort-field="lyricSortField"
            :sort-order="lyricSortOrder"
            :sorted-songs="sortedLyricResults"
            :sticky-top="songToolbarOffset"
            @play="playLyricSearchSongs"
            @sort="handleLyricSort"
          />
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="lyricResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>

        <div v-else>
          <SearchGridResultsPanel
            :items="mvCards"
            :loading="paginationState.mv.loading && !paginationState.mv.loaded"
            :active="activeTabIndex === 5"
            :item-min-width="220"
            :item-aspect-ratio="1.78"
            :item-chrome-height="66"
            :gap="20"
            key-field="videoId"
          >
            <template #default="{ item }">
              <MvCard
                :video-id="item.videoId"
                :hash="item.hash"
                :title="item.name"
                :cover-url="item.coverUrl"
                :artist="item.artist"
                :duration="item.duration"
                :publish-date="item.publishDate"
                :album-audio-id="item.albumAudioId"
              />
            </template>
          </SearchGridResultsPanel>
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="mvResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
          />
        </div>
      </div>
    </div>
  </PageScrollContainer>
</template>

<style scoped src="./search/searchView.css"></style>
