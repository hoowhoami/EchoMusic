<script setup lang="ts">
import { useRouteTabs } from '@/composables/useRouteTabs';
defineOptions({ name: 'search-page' });
import {
  computed,
  nextTick,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getSearchHot, search } from '@/api/search';
import { useSettingStore } from '@/stores/setting';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import type { AlbumMeta } from '@/models/album';
import type { ArtistMeta } from '@/models/artist';
import type { PlaylistMeta } from '@/models/playlist';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { RESUME_SCOPE_LABEL, resumeRecordForScope } from '@/stores/player/resume';
import {
  RESUME_LOCATE_FAILED_TEXT,
  navigateResumeTarget,
  requestResumeHintPlay,
} from '@/utils/resumeHint';
import { formatDuration } from '@/utils/format';
import { resolvePlaylistRoute } from '@/utils/playlistRoute';
import type { ResumeCardKind, ResumeEntryCard } from './search/resumeCard';
import PlaylistCard from '@/components/music/PlaylistCard.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Button from '@/components/ui/Button.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useTabDoubleClickTop, type PageScrollHandle } from '@/composables/useTabDoubleClickTop';
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
  getLongAudioCardProps,
  getPlaylistCardProps,
  replaceResultsByType as applyResultsByType,
  resolveSearchRequest,
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
const userStore = useUserStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();
const route = useRoute();
const router = useRouter();

let disposed = false;
const currentSearchKeyword = ref('');
const isLoading = ref(false);
const isLoadingHot = ref(true);
const hasSearched = ref(false);
const showPinnedTabs = ref(false);
const {
  state: { tab: activeTab },
  select: selectTabs,
  isActive,
} = useRouteTabs({ tab: TAB_SEARCH_TYPES });
const activeTabIndex = computed(() => TAB_SEARCH_TYPES.indexOf(activeTab.value));
const hotSearchCategories = ref<SearchHotCategory[]>([]);

const songResults = ref<Song[]>([]);
const playlistResults = ref<PlaylistMeta[]>([]);
const albumResults = ref<AlbumMeta[]>([]);
const longaudioResults = ref<AlbumMeta[]>([]);
const artistResults = ref<ArtistMeta[]>([]);
const lyricResults = ref<Song[]>([]);
const mvResults = ref<SearchMvCardProps[]>([]);
const resultRefs = {
  songResults,
  playlistResults,
  albumResults,
  longaudioResults,
  artistResults,
  lyricResults,
  mvResults,
};

const paginationState = reactive<Record<SearchTabType, SearchPaginationState>>({
  song: createSearchPaginationState(),
  special: createSearchPaginationState(),
  album: createSearchPaginationState(),
  longaudio: createSearchPaginationState(),
  author: createSearchPaginationState(),
  lyric: createSearchPaginationState(),
  mv: createSearchPaginationState(),
});

const searchErrors = reactive<Partial<Record<SearchTabType, string>>>({});
const songSearchQuery = ref('');
const songSortField = ref<SortField | null>(null);
const songSortOrder = ref<SortOrder>(null);
const songResultsPanelRef = ref<{ scrollToActive?: () => Promise<boolean> } | null>(null);

const lyricSortField = ref<SortField | null>(null);
const lyricSortOrder = ref<SortOrder>(null);
const lyricSearchQuery = ref('');
const lyricResultsPanelRef = ref<{ scrollToActive?: () => Promise<boolean> } | null>(null);

const pinnedTabHeight = 50;
const songToolbarOffset = computed(() => (showPinnedTabs.value ? pinnedTabHeight : 0));
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const scrollContainerRef = useScrollContainer();
const pageScrollRef = ref<PageScrollHandle | null>(null);
const { onTabPointerDown, onTabDoubleClick } = useTabDoubleClickTop(() => pageScrollRef.value);
let scrollTarget: HTMLElement | null = null;

const searchHistory = computed(() => settingStore.searchHistory ?? []);
const activeSearchType = computed(() => TAB_SEARCH_TYPES[activeTabIndex.value] ?? 'song');
const currentSearchSubtitle = computed(() => currentSearchKeyword.value.trim());
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
const filteredLyricResults = computed(() =>
  filterSongsByQuery(sortedLyricResults.value, lyricSearchQuery.value),
);
const lyricCountLabel = computed(() => {
  const total = lyricResults.value.length;
  if (!lyricSearchQuery.value.trim()) return `${total}`;
  return `${filteredLyricResults.value.length} / ${total}`;
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
  loadMoreObserver = null;
  if (disposed || !isActive.value) return;
  const root = scrollTarget ?? scrollContainerRef.value ?? null;
  const observer = new IntersectionObserver(
    (entries) => {
      if (disposed || !isActive.value || loadMoreObserver !== observer) return;
      const entry = entries[0];
      if (!entry?.isIntersecting || entry.target !== loadMoreSentinelRef.value) return;
      if (isLoading.value || !hasSearched.value) return;
      if (
        !activePagination.value.loaded ||
        activePagination.value.loading ||
        activePagination.value.error ||
        searchErrors[activeSearchType.value]
      )
        return;
      void loadMoreActiveResults();
    },
    { root, rootMargin: '0px 0px 240px 0px' },
  );
  loadMoreObserver = observer;
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
  if (disposed || !isActive.value) return;
  if (scrollTarget && scrollTarget === scrollContainerRef.value && loadMoreObserver) {
    handleScroll();
    return;
  }
  detachScrollTarget();
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

let hotSearchToken = 0;
const loadHotSearches = async () => {
  if (disposed) return;
  const token = ++hotSearchToken;
  isLoadingHot.value = true;
  try {
    const hotRes = await getSearchHot();
    if (disposed || token !== hotSearchToken) return;

    hotSearchCategories.value = extractHotCategories(hotRes);
  } catch {
    // 保留上次成功结果，热搜失败不影响搜索和滚动容器初始化。
  } finally {
    if (!disposed && token === hotSearchToken) isLoadingHot.value = false;
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
  const queueSongs = filteredLyricResults.value.slice() as Song[];
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

// 定位当前播放：滚不到就提示，别让人以为按钮点了没反应
const locateInPanel = async (panel: { scrollToActive?: () => Promise<boolean> } | null) => {
  if (!String(playerStore.currentTrackId ?? '')) return;
  const reached = (await panel?.scrollToActive?.()) ?? false;
  if (!reached) toastStore.info('当前播放不在搜索结果里');
};

const handleSongLocate = () => void locateInPanel(songResultsPanelRef.value);
const handleLyricLocate = () => void locateInPanel(lyricResultsPanelRef.value);

const resetPaginationState = () => {
  TAB_SEARCH_TYPES.forEach((type) => {
    delete searchErrors[type];
    paginationState[type].page = 1;
    paginationState[type].hasMore = false;
    paginationState[type].loadingMore = false;
    paginationState[type].loading = false;
    paginationState[type].loaded = false;
    paginationState[type].total = null;
    paginationState[type].error = '';
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
    listLength > 0 &&
    (total !== null ? page * SEARCH_PAGE_SIZE < total : listLength >= SEARCH_PAGE_SIZE);
};

const fetchSearchPage = async (keywords: string, type: SearchTabType, page = 1) => {
  const request = resolveSearchRequest(type);
  const response = await search(keywords, request.type, page, SEARCH_PAGE_SIZE, request.category);
  const lists = extractSearchLists(response);
  const total = extractSearchTotal(response);
  return { lists, total };
};

let latestSearchToken = 0;

const clearSearchResults = () => {
  songResults.value = [];
  playlistResults.value = [];
  albumResults.value = [];
  longaudioResults.value = [];
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

  if (disposed || !isActive.value || !keywords || state.loading || state.loadingMore) return;

  state.loading = true;
  state.error = '';
  delete searchErrors[type];
  if (options?.useGlobalLoading) {
    isLoading.value = true;
  }

  try {
    const { lists, total } = await fetchSearchPage(keywords, type, 1);
    if (disposed || !isActive.value || token !== latestSearchToken) return;

    replaceResultsByType(type, lists);
    applyPaginationState(type, 1, lists.length, total);
  } catch {
    if (disposed || !isActive.value || token !== latestSearchToken) return;
    searchErrors[type] = '搜索请求失败，请重试';
  } finally {
    if (!disposed && token === latestSearchToken) {
      state.loading = false;
      if (options?.useGlobalLoading) {
        isLoading.value = false;
      }
      await nextTick();
      if (!disposed && isActive.value && token === latestSearchToken) handleScroll();
    }
  }
};

const loadMoreActiveResults = async () => {
  const type = activeSearchType.value;
  const keywords = currentSearchKeyword.value.trim();
  const state = paginationState[type];

  if (
    disposed ||
    !isActive.value ||
    !keywords ||
    !state.loaded ||
    state.loading ||
    !state.hasMore ||
    state.loadingMore
  )
    return;

  state.loadingMore = true;
  state.error = '';
  const token = latestSearchToken;
  const nextPage = state.page + 1;

  try {
    const { lists, total } = await fetchSearchPage(keywords, type, nextPage);
    if (disposed || !isActive.value || token !== latestSearchToken) return;

    appendResultsByType(type, lists, resultRefs);
    applyPaginationState(type, nextPage, lists.length, total);
  } catch {
    if (disposed || !isActive.value || token !== latestSearchToken) return;
    state.error = '加载更多失败，请重试';
  } finally {
    if (!disposed && token === latestSearchToken) {
      paginationState[type].loadingMore = false;
      await nextTick();
      if (!disposed && isActive.value && token === latestSearchToken) handleScroll();
    }
  }
};

const runSearch = async (keyword: string) => {
  const keywords = keyword.trim();
  if (disposed || !isActive.value || !keywords) return;

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
  lyricSearchQuery.value = '';
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
    if (disposed || !isActive.value || searchToken !== latestSearchToken) return;
    searchErrors[activeSearchType.value] = '搜索请求失败，请重试';
  } finally {
    if (!disposed && searchToken === latestSearchToken) {
      await nextTick();
      if (!disposed && isActive.value && searchToken === latestSearchToken) handleScroll();
    }
  }
};

const playlistCards = computed(() =>
  playlistResults.value.map((entry) => getPlaylistCardProps(entry)),
);
const albumCards = computed(() => albumResults.value.map((entry) => getAlbumCardProps(entry)));
const longaudioCards = computed(() =>
  longaudioResults.value.map((entry) => getLongAudioCardProps(entry)),
);
const artistCards = computed(() => artistResults.value.map((entry) => getArtistCardProps(entry)));
const mvCards = computed(() => mvResults.value);

onMounted(() => {
  void loadHotSearches();
  void attachScrollTarget();
});
onActivated(() => void attachScrollTarget());
onDeactivated(detachScrollTarget);

const selectSearchTab = (index: number) => selectTabs({ tab: TAB_SEARCH_TYPES[index] });

watch(
  [() => route.name, () => route.query.q, activeSearchType, isActive],
  ([name, queryKeyword, type]) => {
    if (disposed || name !== 'search' || !isActive.value) return;
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
      const state = paginationState[type];
      if (!state.loaded && !state.loading) void loadSearchResults(type);
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
      if (!disposed && isActive.value) handleScroll();
    });
  },
);

// 响应滚动容器变化（PageScrollContainer 延迟 provide 时重新绑定）
watch(scrollContainerRef, () => {
  void attachScrollTarget();
});

onBeforeUnmount(() => {
  disposed = true;
  latestSearchToken++;
  hotSearchToken++;
  isLoading.value = false;
  isLoadingHot.value = false;
  TAB_SEARCH_TYPES.forEach((type) => {
    paginationState[type].loading = false;
    paginationState[type].loadingMore = false;
  });
  detachScrollTarget();
});

// 搜索页右上角「上次播放」：只查本地续播桶，按 有声 > 歌单 > 歌手 > 专辑 排
const RESUME_CARD_ORDER: ResumeCardKind[] = ['audiobook', 'playlist', 'artist', 'album'];

// 只比文字，忽略标点与空白：「夜的·命名术」也算命中「夜的命名术」
const normalizeName = (value: string) =>
  value.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]+/g, '');

type ResumeScopeItem = (typeof playerStore.resumeScopes)[number];

// 参与匹配的文字：桶名（有声/专辑/歌单/歌手名）＋ 桶里记的那一首的标题
// （有声的章节名＝专辑/歌单里的歌曲名，所以同样参与匹配）
const resumeTexts = (scope: ResumeScopeItem): string[] => {
  const record = resumeRecordForScope(playerStore.$state, scope);
  return [scope.name ?? '', record?.title ?? ''].map((text) => text.trim()).filter(Boolean);
};

const resumeEntries = computed<ResumeEntryCard[]>(() => {
  // 设置里关掉了续播卡或搜索页续播牌堆，就一张都不摆
  if (!settingStore.resumeHintEnabled || !settingStore.resumeHintDeckEnabled) return [];
  const keyword = normalizeName(currentSearchKeyword.value.trim());
  if (!hasSearched.value || !keyword) return [];
  // 双向包含：关键词含文字（关键词更长）或文字含关键词（带后缀/前后缀）都算命中；桶名与章节名同等对待
  const matched = playerStore.resumeScopes.filter((scope) => {
    // 没播放过的桶不建卡：卡片代表「上次听到这里」，只有真正写进进度（position > 0）的才算
    const record = resumeRecordForScope(playerStore.$state, scope);
    if (!record || !(record.position > 0)) return false;
    return resumeTexts(scope).some((text) => {
      const normalized = normalizeName(text);
      return !!normalized && (normalized.includes(keyword) || keyword.includes(normalized));
    });
  });
  const cards = matched.map<ResumeEntryCard>((scope) => {
    const record = resumeRecordForScope(playerStore.$state, scope);
    const where = formatDuration(record?.position ?? 0);
    const hint = record?.title ? `${record.title} · ${where}` : `上次听到 ${where}`;
    return {
      key: `${scope.kind}:${scope.id}`,
      kind: scope.kind,
      id: scope.id,
      kindLabel: RESUME_SCOPE_LABEL[scope.kind],
      name: scope.name,
      cover: scope.cover,
      updatedAt: scope.updatedAt ?? 0,
      hint,
      routeId: scope.routeId,
      routeType: scope.routeType,
    };
  });
  // 展示顺序三档：完全命中(0) > 归一化包含(1) > 靠双向包含才命中(2)；桶名与章节名任一对上即算
  const rawKeyword = currentSearchKeyword.value.trim().toLowerCase();
  const tierOf = (scope: ResumeScopeItem): number => {
    const texts = resumeTexts(scope);
    if (!texts.length) return 2;
    if (texts.some((text) => text.toLowerCase() === rawKeyword)) return 0;
    if (texts.some((text) => normalizeName(text).includes(keyword))) return 1;
    return 2;
  };
  const tierMap = new Map(matched.map((scope) => [`${scope.kind}:${scope.id}`, tierOf(scope)]));
  const tier = (key: string): number => tierMap.get(key) ?? 2;
  // 同档内：时间越新越靠前（最上面），同一时刻再按 有声 > 歌单 > 歌手 > 专辑 兜底
  const rank = (kind: ResumeCardKind): number => RESUME_CARD_ORDER.indexOf(kind);
  return cards.sort(
    (a, b) => tier(a.key) - tier(b.key) || b.updatedAt - a.updatedAt || rank(a.kind) - rank(b.kind),
  );
});

const openResumeEntry = async (entry: ResumeEntryCard) => {
  // 统一走「续播请求」：落地页收到就自己滚到那一集、高亮、按设置起播
  requestResumeHintPlay(entry.key);
  const id = String(entry.id);
  let reached = false;
  if (entry.kind === 'audiobook' || entry.kind === 'album') {
    reached = await navigateResumeTarget(
      router,
      {
        name: 'album-detail',
        params: { id },
        query: entry.kind === 'audiobook' ? { category: '2' } : {},
      },
      'album-detail',
      id,
    );
  } else if (entry.kind === 'playlist') {
    // 桶里记的是歌单自己的 id，路由要的是 collection 串：桶上存过就直接用，没存过再按用户歌单列表反查
    const target = entry.routeId
      ? { id: entry.routeId, type: entry.routeType ?? null }
      : resolvePlaylistRoute(entry.id, playlistStore.userPlaylists, userStore.info?.userid);
    reached = await navigateResumeTarget(
      router,
      {
        name: 'playlist-detail',
        params: { id: target.id },
        query: target.type ? { type: target.type } : {},
      },
      'playlist-detail',
      String(target.id),
    );
  } else {
    reached = await navigateResumeTarget(
      router,
      { name: 'artist-detail', params: { id } },
      'artist-detail',
      id,
    );
  }
  if (!reached) toastStore.warning(RESUME_LOCATE_FAILED_TEXT);
};

// 续播卡右键删除：把这条记录从续播桶里摘掉（下一次写盘就没了）
const removeResumeEntry = (entry: ResumeEntryCard) => {
  playerStore.forgetResumeScope(entry.kind, entry.id);
  toastStore.actionCompleted('已移除续播记录');
};
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="search-view-container">
    <div class="search-view relative pb-10">
      <SearchHeader
        :active-tab-index="activeTabIndex"
        :has-searched="hasSearched"
        :keyword="currentSearchKeyword"
        :show-pinned-tabs="showPinnedTabs"
        :tabs="['单曲', '歌单', '专辑', '有声', '歌手', '歌词', 'MV']"
        :resume-entries="resumeEntries"
        @update:active-tab-index="selectSearchTab"
        @open-resume="openResumeEntry"
        @delete-resume="removeResumeEntry"
        @tab-pointer-down="onTabPointerDown"
        @tab-dblclick="onTabDoubleClick"
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
        <Button
          variant="secondary"
          size="default"
          @click="loadSearchResults(activeSearchType, { useGlobalLoading: true })"
          >重新搜索</Button
        >
      </div>

      <div v-else class="px-10 pt-4">
        <div v-if="activeTabIndex === 0" class="motion-content-enter">
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
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else-if="activeTabIndex === 1" class="motion-content-enter">
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
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else-if="activeTabIndex === 2" class="motion-content-enter">
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
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else-if="activeTabIndex === 3" class="motion-content-enter">
          <SearchGridResultsPanel
            :items="longaudioCards"
            :loading="paginationState.longaudio.loading && !paginationState.longaudio.loaded"
            :active="activeTabIndex === 3"
            :item-min-width="180"
            :item-aspect-ratio="1"
            :item-chrome-height="66"
            :gap="20"
            key-field="id"
          >
            <template #default="{ item }">
              <AlbumCard
                :query="{ category: '2' }"
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
            :has-items="longaudioResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else-if="activeTabIndex === 4" class="motion-content-enter">
          <SearchGridResultsPanel
            :items="artistCards"
            :loading="paginationState.author.loading && !paginationState.author.loaded"
            :active="activeTabIndex === 4"
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
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else-if="activeTabIndex === 5" class="motion-content-enter">
          <SearchSongResultsPanel
            ref="lyricResultsPanelRef"
            :active-song-id="activeSongId"
            :enable-locate="true"
            :enable-search-query="true"
            :queue-id-prefix="'queue:search-lyric'"
            :search-query="lyricSearchQuery"
            :show-lyric-column="true"
            :songs="filteredLyricResults"
            :sort-field="lyricSortField"
            :sort-order="lyricSortOrder"
            :sorted-songs="sortedLyricResults"
            :sticky-top="songToolbarOffset"
            :subtitle-label="lyricCountLabel"
            @locate="handleLyricLocate"
            @play="playLyricSearchSongs"
            @song-search-change="lyricSearchQuery = $event"
            @sort="handleLyricSort"
          />
          <SearchLoadMoreStatus
            :active-pagination="activePagination"
            :has-items="lyricResults.length > 0"
            :set-sentinel-ref="setLoadMoreSentinelRef"
            @retry="loadMoreActiveResults"
          />
        </div>

        <div v-else class="motion-content-enter">
          <SearchGridResultsPanel
            :items="mvCards"
            :loading="paginationState.mv.loading && !paginationState.mv.loaded"
            :active="activeTabIndex === 6"
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
            @retry="loadMoreActiveResults"
          />
        </div>
      </div>
    </div>
  </PageScrollContainer>
</template>

<style scoped src="./search/searchView.css"></style>
