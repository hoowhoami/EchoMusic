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
import { getSearchHot, search } from '@/api/search';
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
import Button from '@/components/ui/Button.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import {
  appendResultsByType,
  createSearchPaginationState,
  extractHotCategories,
  extractSearchLists,
  extractSearchTotal,
  getAlbumCardProps,
  getArtistCardProps,
  getPlaylistCardProps,
  replaceResultsByType as applyResultsByType,
  SEARCH_PAGE_SIZE,
  TAB_SEARCH_TYPES,
  type SearchTabType,
} from './search/searchHelpers';
import type { SearchHotCategory, SearchMvCardProps, SearchPaginationState } from './search/types';
import SearchHeader from './search/components/SearchHeader.vue';
import SearchDiscovery from './search/components/SearchDiscovery.vue';
import SearchGridResultsPanel from './search/components/SearchGridResultsPanel.vue';
import SearchLoadMoreStatus from './search/components/SearchLoadMoreStatus.vue';
import SearchResultsSkeleton from './search/components/SearchResultsSkeleton.vue';
import SearchSongResultsPanel from './search/components/SearchSongResultsPanel.vue';

const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const route = useRoute();
const router = useRouter();

const currentSearchKeyword = ref('');
const isLoading = ref(false);
const isLoadingHot = ref(true);
const hasSearched = ref(false);
const showPinnedTabs = ref(false);
const activeTabIndex = ref(0);
const hotSearchCategories = ref<SearchHotCategory[]>([]);

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

const searchErrors = reactive<Partial<Record<SearchTabType, string>>>({});
const songSearchQuery = ref('');
const songSortField = ref<SortField | null>(null);
const songSortOrder = ref<SortOrder>(null);
const songResultsPanelRef = ref<{ scrollToActive?: () => void } | null>(null);

const lyricSortField = ref<SortField | null>(null);
const lyricSortOrder = ref<SortOrder>(null);

const pinnedTabHeight = 50;
const songToolbarOffset = computed(() => (showPinnedTabs.value ? pinnedTabHeight : 0));
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const scrollContainerRef = useScrollContainer();
let scrollTarget: HTMLElement | null = null;

const searchHistory = computed(() => settingStore.searchHistory ?? []);
const activeSearchType = computed(() => TAB_SEARCH_TYPES[activeTabIndex.value] ?? 'song');
const currentSearchSubtitle = computed(() => currentSearchKeyword.value.trim() || '歌曲搜索');
const activePagination = computed(() => paginationState[activeSearchType.value]);
const searchSkeletonMode = computed<'song' | 'grid' | 'video'>(() => {
  if (activeSearchType.value === 'song' || activeSearchType.value === 'lyric') return 'song';
  if (activeSearchType.value === 'mv') return 'video';
  return 'grid';
});

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
  } catch {
    hotSearchCategories.value = [];
  } finally {
    isLoadingHot.value = false;
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
    delete searchErrors[type];
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
  delete searchErrors[type];
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
    searchErrors[type] = '搜索请求失败，请重试';
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

const runSearch = async (keyword: string) => {
  const keywords = keyword.trim();
  if (!keywords) return;

  currentSearchKeyword.value = keywords;
  latestSearchToken += 1;
  const searchToken = latestSearchToken;
  isLoading.value = true;
  hasSearched.value = true;
  songSortField.value = null;
  songSortOrder.value = null;
  lyricSortField.value = null;
  lyricSortOrder.value = null;
  songSearchQuery.value = '';
  clearSearchResults();
  resetPaginationState();
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
    if (route.name !== 'search') return;
    const keyword = typeof queryKeyword === 'string' ? queryKeyword.trim() : '';

    if (!keyword) {
      latestSearchToken++;
      isLoading.value = false;
      currentSearchKeyword.value = '';
      clearSearchResults();
      resetPaginationState();
      hasSearched.value = false;
      showPinnedTabs.value = false;
      return;
    }

    if (keyword === currentSearchKeyword.value.trim() && hasSearched.value) {
      return;
    }

    void runSearch(keyword);
  },
  { immediate: true, flush: 'post' },
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
  detachScrollTarget();
});
</script>

<template>
  <PageScrollContainer class="search-view-container">
    <div class="search-view relative pb-10">
      <SearchHeader
        :active-tab-index="activeTabIndex"
        :has-searched="hasSearched"
        :keyword="currentSearchKeyword"
        :show-pinned-tabs="showPinnedTabs"
        :tabs="['单曲', '歌单', '专辑', '歌手', '歌词', 'MV']"
        @update:active-tab-index="activeTabIndex = $event"
      />

      <SearchDiscovery
        v-if="!hasSearched"
        :hot-search-categories="hotSearchCategories"
        :is-loading-hot="isLoadingHot"
        :search-history="searchHistory"
        @clear-history="settingStore.clearSearchHistory()"
        @pick-keyword="router.push({ name: 'search', query: { q: $event } })"
        @remove-history="settingStore.removeFromSearchHistory($event)"
      />

      <SearchResultsSkeleton
        v-else-if="isLoading"
        :mode="searchSkeletonMode"
        :lyric-column="activeSearchType === 'lyric'"
      />

      <div v-else-if="searchErrors[activeSearchType]" class="search-placeholder px-10" role="alert">
        <p>{{ searchErrors[activeSearchType] }}</p>
        <Button variant="secondary" size="sm" @click="runSearch(currentSearchKeyword)"
          >重新搜索</Button
        >
      </div>

      <div v-else class="px-10 pt-4">
        <div v-if="activeTabIndex === 0">
          <SearchSongResultsPanel
            ref="songResultsPanelRef"
            :active-song-id="activeSongId"
            :enable-locate="true"
            :enable-search-query="true"
            :queue-id-prefix="'queue:search'"
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
            :queue-id-prefix="'queue:search-lyric'"
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
