<script setup lang="ts">
import { useRouteTabs } from '@/composables/useRouteTabs';
import { useTabDoubleClickTop, type PageScrollHandle } from '@/composables/useTabDoubleClickTop';
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
import { hideElementTooltip, showElementTooltip } from '@/components/ui/tooltip';
import { createLocateFeedback } from '@/utils/locateFeedback';
defineOptions({ name: 'album-detail' });
import {
  ref,
  shallowRef,
  onMounted,
  onActivated,
  onBeforeUnmount,
  computed,
  watch,
  nextTick,
} from 'vue';
import { extractFirstObject, extractList } from '@/utils/extractors';

import { useRoute, useRouter } from 'vue-router';
import { useRouteId } from '@/composables/useRouteId';
import {
  getAlbumDetail,
  getAlbumSongs,
  favoriteAlbum as favoriteAlbumApi,
  unfavoriteAlbum as unfavoriteAlbumApi,
} from '@/api/album';
import { useDetailComments } from '@/composables/useDetailComments';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import DetailPageSkeleton from '@/components/music/DetailPageSkeleton.vue';
import DetailPageError from '@/components/music/DetailPageError.vue';
import DynamicAlbumCover from '@/components/music/DynamicAlbumCover.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import CommentComposer from '@/components/music/CommentComposer.vue';
import CommentList from '@/components/music/CommentList.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song, SongArtist } from '@/models/song';
import Button from '@/components/ui/Button.vue';
import { mapAlbumDetailMeta, mapAlbumSong } from '@/utils/mappers';
import type { AlbumMeta } from '@/models/album';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { usePlayerStore } from '@/stores/player';
import { resumeRecordForScope } from '@/stores/player/resume';
import {
  dismissResumeHint,
  resumeHintRequest,
  showPageResumeHint,
  takeResumeHintRequest,
} from '@/utils/resumeHint';
import { useSettingStore } from '@/stores/setting';
import { logger } from '@/utils/logger';
import {
  iconCurrentLocation,
  iconPlay,
  iconList,
  iconHeart,
  iconHeartFilled,
  iconShare,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { copyShareTarget, createShareTarget } from '@/utils/share';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { isRecord } from '../../../shared/object';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import { captureUserSession, userSessionSources } from '@/utils/userSession';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const route = useRoute();
const router = useRouter();
const { id: currentId, onIdChange } = useRouteId();
const getAlbumId = () => currentId.value;

const loading = ref(true);
const album = ref<AlbumMeta | null>(null);
// 有声判定：接口返回的 category 最可靠，取不到时退回路由参数（搜索、收藏等入口会带 category=2）
const albumCategory = ref('');
const readAlbumCategory = (value: unknown) => {
  if (!value || typeof value !== 'object') return '';
  return String((value as Record<string, unknown>).category ?? '');
};
const isAudiobookAlbum = computed(
  () => (albumCategory.value || String(route.query.category ?? '')) === '2',
);

// 使用 shallowRef 极大减少响应式开销
const songs = shallowRef<Song[]>([]);
const loadedSongCount = ref(0);
const coverAudioId = computed(() => {
  const song = songs.value.find((item) => item.albumAudioId || item.mixSongId);
  return song?.albumAudioId || song?.mixSongId;
});

const {
  state: { tab: activeTab },
  select: selectTabs,
  isActive,
} = useRouteTabs({ tab: ['songs', 'comments'] });

const showBatchDrawer = ref(false);
const showIntroDialog = ref(false);

const albumSongCount = computed(() => {
  const metaCount = album.value?.songCount ?? 0;
  return metaCount > 0 ? metaCount : loadedSongCount.value;
});

const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();

// 搜索和定位逻辑
const searchQuery = ref('');
const songListRef = ref<{
  scrollToActive?: () => Promise<boolean> | void;
  scrollToSong?: (songId: string) => Promise<boolean> | void;
  flashSong?: (songId: string) => void;
} | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

const albumArtists = ref<SongArtist[]>([]);

const parseAlbumArtists = (payload: unknown): SongArtist[] => {
  if (!isRecord(payload)) return [];
  const rawAuthors = Array.isArray(payload.authors) ? payload.authors : [];
  const mapped = rawAuthors
    .filter((item) => isRecord(item))
    .map((item) => ({
      id: item.author_id != null ? String(item.author_id) : undefined,
      name: String(item.author_name ?? '').trim(),
    }))
    .filter((item) => item.name.length > 0);

  if (mapped.length > 0) return mapped;
  if (!album.value?.singerName) return [];
  return [
    {
      id: album.value.singerId ? String(album.value.singerId) : undefined,
      name: album.value.singerName,
    },
  ];
};

const isAlbumArtistClickable = (artist: SongArtist) => Boolean(artist.id);

const openAlbumArtist = (artist: SongArtist) => {
  if (!artist.id) return;
  router.push({
    name: 'artist-detail',
    params: { id: String(artist.id) },
  });
};

const currentAlbumIds = computed(() => {
  const meta = album.value;
  if (!meta) return [] as string[];
  return [meta.id, meta.albumid, meta.album_id]
    .filter((item): item is number => item !== undefined && item !== null)
    .map((item) => String(item));
});

const isFavoriteAlbum = computed(() => {
  const ids = currentAlbumIds.value;
  if (ids.length === 0) return false;
  return playlistStore.userPlaylists.some((entry) => {
    if (entry.source !== 2) return false;
    const entryIds = [
      entry.id,
      entry.listid,
      entry.listCreateListid,
      entry.globalCollectionId,
      entry.listCreateGid,
    ]
      .filter(
        (item): item is string | number =>
          item !== undefined && item !== null && String(item) !== '',
      )
      .map((item) => String(item));
    return entryIds.some((id) => ids.includes(id));
  });
});

const togglingFavorite = ref(false);
let favoriteGeneration = 0;
watch(
  [getAlbumId, ...userSessionSources(userStore)],
  () => {
    favoriteGeneration++;
    togglingFavorite.value = false;
  },
  { flush: 'sync' },
);

const toggleFavoriteAlbum = async () => {
  const meta = album.value;
  if (disposed || !meta || togglingFavorite.value) return;
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('收藏专辑');
    return;
  }
  const previousFavorite = isFavoriteAlbum.value;
  let listId: string | number | undefined;
  if (previousFavorite) {
    const target = playlistStore.userPlaylists.find((entry) => {
      if (entry.source !== 2) return false;
      const entryIds = [
        entry.id,
        entry.listid,
        entry.listCreateListid,
        entry.globalCollectionId,
        entry.listCreateGid,
      ]
        .filter(
          (item): item is string | number =>
            item !== undefined && item !== null && String(item) !== '',
        )
        .map((item) => String(item));
      return entryIds.some((id) => currentAlbumIds.value.includes(id));
    });
    listId = target?.listid ?? target?.id;
    if (!listId) return;
  }
  const resourceId = getAlbumId();
  const generation = ++favoriteGeneration;
  const isSessionCurrent = captureUserSession(userStore);
  const isCurrent = () =>
    !disposed &&
    generation === favoriteGeneration &&
    resourceId === getAlbumId() &&
    isSessionCurrent();
  togglingFavorite.value = true;
  try {
    const response = previousFavorite
      ? await unfavoriteAlbumApi(listId!)
      : await favoriteAlbumApi(meta.id, meta.name, meta.singerId);
    if (!isCurrent()) return;
    if (!isRecord(response) || response.status !== 1) {
      toastStore.actionFailed(previousFavorite ? '取消收藏专辑' : '收藏专辑');
      return;
    }

    await playlistStore.fetchUserPlaylists();
    if (!isCurrent()) return;
    if (previousFavorite) toastStore.actionCompleted('已取消收藏专辑');
    else toastStore.actionSucceeded('收藏专辑');
  } catch {
    if (isCurrent()) toastStore.actionFailed(previousFavorite ? '取消收藏专辑' : '收藏专辑');
  } finally {
    if (isCurrent()) togglingFavorite.value = false;
  }
};

// 排序逻辑
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const sortedSongs = computed(() =>
  sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  }),
);
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const { loadingComments, comments, hotComments, commentTotal, hasMoreComments, fetchComments } =
  useDetailComments({
    type: 'album',
    resourceId: getAlbumId,
    isActive: () => isActive.value && activeTab.value === 'comments',
  });

const loadingSongs = ref(true);

// 歌曲分页加载器
let songLoader: PagedSongLoader<Song> | null = null;
let songsFullyLoaded = false;
// 首屏到手时 loading 就已经是 false 了，剩下的页还在后台拉；
// 只有全部加载完成，才能说「列表里确实没有这一首」。
const songsAllLoaded = ref(false);

const handleTabChange = (value: string | number) => selectTabs({ tab: String(value) });
const loadActiveTabData = () => {
  if (!isActive.value) return;
  if (activeTab.value === 'comments' && comments.value.length === 0) void fetchComments(true);
};
watch(activeTab, loadActiveTabData);

// 滚动加载更多评论（使用 IntersectionObserver）
const scrollContainerRef = useScrollContainer();

// 双击 tab 回到顶部：本页是 PageScrollContainer 的父组件，useScrollContainer() 只能拿到 null
const pageScrollRef = ref<PageScrollHandle | null>(null);
const { onTabPointerDown, onTabDoubleClick } = useTabDoubleClickTop(() => pageScrollRef.value);
const commentSentinelRef = ref<HTMLElement | null>(null);
let commentObserver: IntersectionObserver | null = null;

const setupCommentObserver = () => {
  commentObserver?.disconnect();
  const root = scrollContainerRef.value ?? null;
  commentObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      if (activeTab.value !== 'comments') return;
      if (loadingComments.value || !hasMoreComments.value) return;
      fetchComments();
    },
    { root, rootMargin: '0px 0px 400px 0px' },
  );
  if (commentSentinelRef.value) {
    commentObserver.observe(commentSentinelRef.value);
  }
};

watch(commentSentinelRef, (el) => {
  if (!commentObserver) {
    setupCommentObserver();
    return;
  }
  commentObserver.disconnect();
  if (el) commentObserver.observe(el);
});

watch(scrollContainerRef, () => {
  setupCommentObserver();
});

let loadGeneration = 0;
let disposed = false;
const fetchData = async () => {
  if (disposed) return;
  const generation = ++loadGeneration;
  const albumId = getAlbumId();
  const hadCompleteSongs = songsFullyLoaded;
  const isCurrent = () => !disposed && generation === loadGeneration && albumId === getAlbumId();
  loading.value = true;
  loadingSongs.value = true;
  albumCategory.value = '';

  // 1. 先获取专辑详情
  const detailTask = getAlbumDetail(albumId)
    .then((detailRes) => {
      if (!isCurrent()) return;

      const detailRaw = extractFirstObject(detailRes);
      albumCategory.value = readAlbumCategory(detailRaw);
      const meta = detailRaw && mapAlbumDetailMeta(detailRaw);
      // Empty detail is unavailable content, not an album with a fabricated zero ID.
      if (!meta?.id) return;
      album.value = meta;
      albumArtists.value = parseAlbumArtists(detailRaw);
      // 进详情页就登记：有声入口打开的书进「有声」桶，其余进「专辑」桶
      playerStore.registerResumeScope(
        isAudiobookAlbum.value ? 'audiobook' : 'album',
        String(meta.id),
        { name: meta.name, cover: meta.pic },
      );
    })
    .catch((e) => {
      if (!isCurrent()) return;
      logger.error('AlbumDetail', 'Fetch album detail error', e);
      if (album.value) toastStore.loadFailed('专辑详情');
    })
    .finally(() => {
      if (isCurrent()) loading.value = false;
    });

  // 2. 中止上一次加载
  if (songLoader) {
    songLoader.abort();
  }

  // 3. 创建加载器获取歌曲
  const loader = new PagedSongLoader<Song>(
    async (page, pageSize) => {
      if (!isCurrent()) throw new Error('专辑加载已失效');
      const res = await getAlbumSongs(albumId, page, pageSize);
      if (!isCurrent()) throw new Error('专辑加载已失效');

      if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) {
        return { items: [], hasMore: false };
      }
      const items = extractList(res).map((item) => mapAlbumSong(item));
      return { items, hasMore: items.length >= pageSize };
    },
    {
      pageSize: 30,
      concurrency: 3,
      dedupeKey: (song) => String(song.mixSongId || song.id),
      logTag: 'AlbumSongsLoader',
      onPageLoaded(allItems) {
        if (!isCurrent() || hadCompleteSongs) return;
        songsFullyLoaded = false;
        songsAllLoaded.value = false;
        songs.value = allItems.slice();
        loadedSongCount.value = allItems.length;
      },
      onComplete(allItems) {
        if (!isCurrent()) return;
        songsFullyLoaded = true;
        songsAllLoaded.value = true;
        songs.value = allItems.slice();
        loadedSongCount.value = allItems.length;
      },
      onError() {
        if (isCurrent()) toastStore.loadFailed('专辑歌曲');
      },
    },
  );

  songLoader = loader;
  const songsTask = loader
    .loadFirstPage()
    .then(() => {
      if (!isCurrent()) return;
      loadingSongs.value = false;
      // 首页加载完后，只要还有更多数据就继续加载剩余页
      if (!loader.fullyLoaded && !loader.failed) {
        void loader.loadRemaining();
      }
    })
    .catch((e) => {
      if (!isCurrent()) return;
      console.error('Fetch album songs error:', e);
      loadingSongs.value = false;
    });

  await Promise.allSettled([detailTask, songsTask]);
};

onMounted(() => {
  fetchData();
  loadActiveTabData();
  setupCommentObserver();
});

onActivated(() => {
  if (!album.value && !loading.value) void fetchData();
});

onBeforeUnmount(() => {
  disposed = true;
  clearResumePlayTimer();
  loadGeneration++;
  songLoader?.abort();
  commentObserver?.disconnect();
  commentObserver = null;
});

// id 变化时重置数据（仅同路由间切换，如专辑A→专辑B）
onIdChange(() => {
  clearResumePlayTimer();
  songsFullyLoaded = false;
  songsAllLoaded.value = false;
  album.value = null;
  albumArtists.value = [];
  songs.value = [];
  loadedSongCount.value = 0;
  if (songLoader) {
    songLoader.abort();
    songLoader = null;
  }
  fetchData();
  if (activeTab.value === 'comments') {
    fetchComments(true);
  }
});

const handleShareAlbum = async () => {
  const meta = album.value;
  if (!meta) return;
  const target = createShareTarget('album', meta.id ?? getAlbumId(), meta.name);
  if (!target) return;
  try {
    await copyShareTarget(target);
    toastStore.actionCompleted('分享链接已复制');
  } catch {
    toastStore.actionFailed('复制分享链接');
  }
};

const secondaryActions = computed(() => {
  if (!album.value) return [];
  const actions = [] as {
    icon: typeof iconHeart;
    label: string;
    emphasized?: boolean;
    tone?: 'default' | 'favorite';
    onTap: () => void | Promise<void>;
  }[];

  if (userStore.isLoggedIn) {
    actions.push({
      icon: iconHeart,
      label: isFavoriteAlbum.value ? '已收藏' : '收藏',
      emphasized: isFavoriteAlbum.value,
      tone: 'favorite' as const,
      onTap: async () => {
        if (!album.value) return;
        await toggleFavoriteAlbum();
      },
    });
  }

  actions.push({
    icon: iconShare,
    label: '分享',
    onTap: handleShareAlbum,
  });

  return actions;
});

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: `queue:album:${album.value?.id ?? getAlbumId()}`,
    title: album.value?.name || '专辑',
    subtitle: album.value?.singerName || '',
    type: 'album',
    resumeScope: {
      kind: isAudiobookAlbum.value ? 'audiobook' : 'album',
      id: String(album.value?.id ?? getAlbumId()),
    } as const,
  });
};

const handlePlayAll = async () => {
  const loader = songLoader;
  const generation = loadGeneration;
  const resourceId = getAlbumId();
  const requestSortField = sortField.value;
  const requestSortOrder = sortOrder.value;
  const requestQuery = searchQuery.value;
  const isCurrent = () =>
    !disposed &&
    generation === loadGeneration &&
    resourceId === getAlbumId() &&
    loader === songLoader;
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  const queueOpts = {
    queueId: `queue:album:${album.value?.id ?? getAlbumId()}`,
    title: album.value?.name || '专辑',
    subtitle: album.value?.singerName || '',
    type: 'album' as const,
    resumeScope: {
      kind: isAudiobookAlbum.value ? 'audiobook' : 'album',
      id: String(album.value?.id ?? getAlbumId()),
    } as const,
  };
  const playRequest = replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    0,
    undefined,
    queueOpts,
  );
  const queue = playlistStore.getQueueById(queueOpts.queueId);
  const queuedSongs = queue?.songs;
  const queueRevision = queue?.playbackRevision;
  const isCurrentQueue = () =>
    isCurrent() &&
    playlistStore.activeQueueId === queueOpts.queueId &&
    playlistStore.getQueueById(queueOpts.queueId) === queue &&
    queue?.songs === queuedSongs &&
    queue?.playbackRevision === queueRevision;
  const played = await playRequest;
  if (!played || !isCurrentQueue()) return;
  // 后台等待全部加载完，静默更新播放队列
  if (loader && !loader.failed) {
    const allSongs = Array.from(await loader.waitForAll()) as Song[];
    if (!isCurrentQueue() || !loader.fullyLoaded || loader.failed) return;
    const sortedAllSongs = sortSongs(allSongs, requestSortField, requestSortOrder, {
      indexSource: allSongs,
    });
    const displayedAllSongs = filterSongsByQuery(sortedAllSongs, requestQuery);
    if (displayedAllSongs.length > queueSongs.length) {
      playlistStore.setPlaybackQueueWithOptions(
        Array.from(displayedAllSongs) as Song[],
        0,
        queueOpts,
      );
    }
  }
};
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};
const resumeScopeRef = computed(() => {
  const ids = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  };
  push(getAlbumId());
  push(album.value?.id);
  if (ids.size === 0) return null;
  return (
    playerStore.resumeScopes.find(
      (entry) =>
        entry.trackId &&
        (entry.kind === 'audiobook' || entry.kind === 'album') &&
        ids.has(entry.id),
    ) ?? null
  );
});

const resumeScopeTrackId = computed(() => resumeScopeRef.value?.trackId ?? '');

const resumeTarget = computed(() => {
  const trackId = resumeScopeTrackId.value;
  if (!trackId) return null;
  const record = resumeRecordForScope(playerStore.$state, resumeScopeRef.value);
  if (!record || !(record.position > 0)) return null;
  return { trackId, position: record.position };
});

// 只有「在本页点了这一页的曲目播放」才建卡（认领走 playTrack 的 resumeScope）。
// 播放中进入详情页、或者回到这一页时，不再把正在播的歌自动认领进来。

// 进这一页就把「这一页的续播卡」贴出来（常驻）：有个 position > 0 的记录才贴，
// 退出页面、或者开始播记录里那一集（不管从哪儿点的）时才收。
const pageResumeHintKey = computed(() => {
  const scope = resumeScopeRef.value;
  return scope && resumeTarget.value ? scope.kind + ':' + scope.id : '';
});

// 页面会被 RouteKeepAlive 缓存住，缓存的页面照样会收到播放状态变化：
// 只有本页在前台时才允许收掉提示卡，否则会把别的页面刚弹出来的那些卡一起收掉。
const dismissPageResumeHint = () => {
  if (isActive.value) dismissResumeHint();
};

const showPageResumeHintNow = () => {
  const scope = resumeScopeRef.value;
  const target = resumeTarget.value;
  if (!scope || !target) {
    dismissPageResumeHint();
    return;
  }
  // 正在接着播的就是记录里那一集：这一页没什么可提示的了，不贴
  const playingThisOne =
    playerStore.isPlaying && String(playerStore.currentTrackId ?? '') === String(target.trackId);
  if (playingThisOne) {
    dismissPageResumeHint();
    return;
  }
  showPageResumeHint({
    kind: scope.kind,
    id: scope.id,
    scopeName: scope.name,
    cover: scope.cover,
    recordTitle: resumeRecordForScope(playerStore.$state, scope)?.title ?? '',
    recordPosition: target.position,
    trackId: target.trackId,
    sameTrack: String(playerStore.currentTrackId ?? '') === String(target.trackId),
  });
};

watch(
  pageResumeHintKey,
  (key) => {
    if (key) showPageResumeHintNow();
    else dismissPageResumeHint();
  },
  { immediate: true },
);

// 离开这一页就收卡；回来时有记录会重新贴
watch(isActive, (value) => {
  if (!value) dismissResumeHint();
});

// 缓存页面重新激活时补一次：上面那个 watch 只在离开时收卡，回来 key 没变不会再贴
onActivated(() => {
  if (pageResumeHintKey.value) showPageResumeHintNow();
});
onBeforeUnmount(() => dismissPageResumeHint());

// 这一页一开始播放就收卡：点卡续播、双击某一集、播放全部、自动连播都算
watch(
  () => [playerStore.currentTrackId, playerStore.isPlaying] as const,
  () => {
    if (playerStore.isPlaying) dismissPageResumeHint();
  },
);

// 卡上点了「续播」：交给本页的定位 + 续播流程（滚到那一集、高亮、从记录位置播）
watch(
  () => resumeHintRequest.token,
  () => {
    if (!isActive.value) return;
    if (takeResumeHintRequest(pageResumeHintKey.value)) void handleLocate();
  },
);

// 有上次听到的记录就定位它；没有记录才退回「定位当前播放」
const locateTooltip = computed(() => (resumeTarget.value ? '定位上次听到' : '定位当前播放'));

// 与 SongList 的目标行高亮时长保持一致，高亮结束再续播
const RESUME_PLAY_DELAY_MS = 1800;
let resumePlayTimer: number | null = null;

const clearResumePlayTimer = () => {
  if (resumePlayTimer !== null) {
    window.clearTimeout(resumePlayTimer);
    resumePlayTimer = null;
  }
};

// 缓存里的旧页面也会收到路由变化：只有「当前就是这一页」时才允许定位与续播
const isCurrentRoute = () =>
  String(route.name ?? '') === 'album-detail' &&
  String(route.params.id ?? '') === String(getAlbumId());

// 页面被切走就把还没到点的续播取消掉，免得它隔着页面把播放抢过去
watch(isActive, (value) => {
  if (!value) {
    clearResumePlayTimer();
    // 同时重置定位冷却状态：返回后再点进来要能重新滚过去
    lastLocateAt = 0;
  }
});

const playFromResumePoint = async (song: Song, resumeAt: number) => {
  if (disposed || !isActive.value || !isCurrentRoute()) return;
  if (playerStore.currentTrackId !== String(song.id)) {
    await handleSongDoubleTapPlay(song);
    // 等音源挂上、拿到时长再跳，早一步会被加载完的时间回报覆盖回 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (playerStore.currentTrackId === String(song.id) && playerStore.duration > 0) break;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  } else if (!playerStore.isPlaying) {
    void playerStore.togglePlay();
  }
  if (resumeAt > 0 && Math.abs(playerStore.currentTime - resumeAt) > 5) {
    playerStore.seek(resumeAt);
  }
};

const scheduleResumePlay = (song: Song, resumeAt = 0) => {
  clearResumePlayTimer();
  resumePlayTimer = window.setTimeout(() => {
    resumePlayTimer = null;
    if (disposed || !isActive.value || !isCurrentRoute()) return;
    void playFromResumePoint(song, resumeAt);
  }, RESUME_PLAY_DELAY_MS);
};

// 同一个按钮 3 秒内只认第一下：不重复定位、不重复高亮、不叠提示

const locateFeedback = createLocateFeedback();

const LOCATE_COOLDOWN_MS = 3000;
let lastLocateAt = 0;

// 进入页面时若这里已有上次播放记录，主动把定位按钮的提示弹出来一次
const locateAnchorRef = ref<HTMLElement | null>(null);
const LOCATE_HINT_MS = 2400;
let locateHintTimer: number | null = null;

const locateHintElement = (): HTMLElement | null =>
  locateAnchorRef.value?.querySelector<HTMLElement>('button') ?? null;

const hideLocateHint = () => {
  if (locateHintTimer !== null) {
    window.clearTimeout(locateHintTimer);
    locateHintTimer = null;
  }
  hideElementTooltip(locateHintElement());
};

const showLocateHint = () => {
  const element = locateHintElement();
  if (!element || !showElementTooltip(element, 400)) return;
  if (locateHintTimer !== null) window.clearTimeout(locateHintTimer);
  locateHintTimer = window.setTimeout(() => {
    locateHintTimer = null;
    hideElementTooltip(element);
  }, LOCATE_HINT_MS);
};

// 列表是虚拟滚动的：数据刚到时会还没测量出行位置，多试几次才能真的滚到位。
// 3 秒窗口只用来判定「不在列表里」；曲目确实在列表里、只是列表还没测量好时多等一会儿，
// 否则刚打开页面那一下永远滚不过去。
const LOCATE_RETRY_MS = 150;
// 等列表加载和真去滚这一行共用一个窗口（取大的那个值），到点就不再耗着
const LOCATE_WAIT_MS = 20000;

/** 等列表停止加载；到窗口上限还没好就返回 false，别拿半截列表判「不在」。 */
const waitSongsLoaded = async (): Promise<boolean> => {
  const start = Date.now();
  while (loadingSongs.value && Date.now() - start <= LOCATE_WAIT_MS) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, LOCATE_RETRY_MS);
    });
  }
  return !loadingSongs.value;
};

const revealSongRow = async (trackId: string): Promise<boolean> => {
  if (!trackId) return false;
  const loaded = await waitSongsLoaded();
  if (!loaded) return false;
  const start = Date.now();
  while (Date.now() - start <= LOCATE_WAIT_MS && !disposed) {
    if (songs.value.some((song) => String(song.id) === trackId)) {
      if (await songListRef.value?.scrollToSong?.(trackId)) return true;
    } else if (songsAllLoaded.value) {
      // 分页全加载完还是找不到：是真的不在这个列表里，不用再等
      return false;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, LOCATE_RETRY_MS);
    });
  }
  return false;
};

// 记录指向的那一首已经不在本页了：把这条续播记录一起删掉。
// 只删指向本页的那条 —— 同一首可能同时记在别的专辑/有声桶里，别顺手把别人的卡删了。
const forgetResumeScopeOf = (trackId: string) => {
  const ids = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  };
  push(getAlbumId());
  push(album.value?.id);
  const kind = isAudiobookAlbum.value ? 'audiobook' : 'album';
  const scope = playerStore.resumeScopes.find(
    (entry) => entry.trackId === trackId && entry.kind === kind && ids.has(entry.id),
  );
  if (!scope) return;
  playerStore.forgetResumeScope(scope.kind, scope.id);
};

// play: true = 续播卡点的；false = 别的入口过来的，只定位不播；不传 = 页面上的「定位」按钮
const handleLocate = async () => {
  if (!isCurrentRoute()) return;
  const now = Date.now();
  if (now - lastLocateAt < LOCATE_COOLDOWN_MS) return;
  lastLocateAt = now;
  // 定位对象是「上次听到的那一首」：播放器放的是别的歌也照样滚过去
  const targetId = resumeTarget.value?.trackId ?? String(playerStore.currentTrackId ?? '');
  hideLocateHint();
  clearResumePlayTimer();
  // 既没记录、也没在播：没有定位对象，页面停最上方
  if (!targetId) return;
  // 搜索词把它过滤掉了：先清空搜索，再滚
  if (searchQuery.value && !displayedSongs.value.some((song) => String(song.id) === targetId)) {
    searchQuery.value = '';
  }
  const reached = await revealSongRow(targetId);
  if (!reached) {
    // 列表加载完了、总数里真的没有这一首（下架/被删）：提示一句、删掉这条记录，页面停最上方
    if (songsAllLoaded.value && !songs.value.some((song) => String(song.id) === targetId)) {
      locateFeedback.show('上次听到的曲目不在本页列表了');
      forgetResumeScopeOf(targetId);
    }
    return;
  }
  const isCurrentTrack = String(playerStore.currentTrackId ?? '') === targetId;
  // 当前播放那一行本来就有高亮；滚过去的是别的行，就闪一下让人看见
  if (!isCurrentTrack) songListRef.value?.flashSong?.(targetId);
  const targetEntry = resumeTarget.value;
  // 没有进度记录就只滚不播；正在播这一首也不用重来
  if (!targetEntry) return;
  if (isCurrentTrack && playerStore.isPlaying) return;
  // 要不要真的播，听「定位后自动续播」开关
  if (!settingStore.resumeAutoPlayOnLocate) return;
  const targetSong = songs.value.find((song) => String(song.id) === targetId);
  if (targetSong) scheduleResumePlay(targetSong, targetEntry.position);
};

// 气泡每次进入只弹一次，别被分页加载反复触发
let locateHintShownOnce = false;

// 点了续播卡过来时只会留下一条续播请求：列表就绪、这一页的卡认得出自己就认领一次
const consumeLocateRequest = (): boolean => {
  if (!isActive.value) return false;
  if (loadingSongs.value || songs.value.length === 0) return false;
  if (!takeResumeHintRequest(pageResumeHintKey.value)) return false;
  void handleLocate();
  return true;
};

// 等歌曲列表真正就绪（不被 loading 挡住）再定位，否则虚拟列表还没有行可以滚
watch(
  [() => songs.value.length, loadingSongs],
  ([length, isLoading]) => {
    if (length === 0 || isLoading) return;
    if (consumeLocateRequest()) return;
    void nextTick(() => {
      if (!resumeTarget.value || locateHintShownOnce) return;
      locateHintShownOnce = true;
      showLocateHint();
    });
  },
  { immediate: true },
);

// 请求可能比这一页的续播桶晚到：key 一就绪再认领一次
watch(pageResumeHintKey, () => {
  consumeLocateRequest();
});

onActivated(() => {
  if (disposed) return;
  const fromRequest = consumeLocateRequest();
  // 每次回到这一页，只要有上次听到的记录就在靶心弹一次；带着续播请求进来会直接定位，不弹
  locateHintShownOnce = false;
  if (!fromRequest && resumeTarget.value) {
    void nextTick(() => {
      if (locateHintShownOnce) return;
      locateHintShownOnce = true;
      showLocateHint();
    });
  }
});

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="album-detail-page">
    <div class="album-detail-container bg-bg-main min-h-full">
      <DetailPageSkeleton v-if="loading && !album?.id" typeLabel="ALBUM" :expandedHeight="196" />

      <DetailPageError v-else-if="!album?.id" resource-name="专辑" @retry="fetchData" />

      <template v-else-if="album">
        <!-- 1. Sliver Header -->
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="ALBUM"
          :title="album.name"
          :description="album.intro"
          @description-click="showIntroDialog = true"
          :coverUrl="album.pic"
          :hasDetails="true"
          distribute-details
          :expandedHeight="196"
        >
          <template #cover="{ expanded, borderRadius }">
            <DynamicAlbumCover
              :enabled="settingStore.dynamicAlbumCover"
              :url="album.pic"
              :album-audio-id="coverAudioId"
              :album-id="album.id"
              :active="expanded && !playerStore.isLyricViewOpen"
              :border-radius="borderRadius"
              :size="400"
              :alt="album.name"
            />
          </template>
          <template #details>
            <div class="contents text-text-secondary">
              <div class="album-artist-line">
                <template
                  v-for="(artistItem, index) in albumArtists"
                  :key="`${artistItem.name}-${index}`"
                >
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="album-singer-link"
                    :class="{ 'is-link': isAlbumArtistClickable(artistItem) }"
                    :disabled="!isAlbumArtistClickable(artistItem)"
                    @click="openAlbumArtist(artistItem)"
                  >
                    {{ artistItem.name }}
                  </Button>
                  <span v-if="index < albumArtists.length - 1" class="album-artist-separator">
                    /
                  </span>
                </template>
              </div>
              <div class="text-[11px] font-semibold text-text-secondary">
                {{ album.publishTime }} • {{ albumSongCount }} 首歌曲
              </div>
              <div
                v-if="album.type || album.language"
                class="text-[11px] font-semibold text-text-secondary"
              >
                <span v-if="album.type">{{ album.type }}</span>
                <span v-if="album.type && album.language"> • </span>
                <span v-if="album.language">{{ album.language }}</span>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow
              :secondaryActions="secondaryActions"
              :showPlaybackActions="activeTab === 'songs'"
              @play="handlePlayAll"
              @batch="openBatchDrawer"
            />
          </template>

          <template #collapsed-actions>
            <template v-if="activeTab === 'songs'">
              <Button
                variant="unstyled"
                size="icon"
                @click="handlePlayAll"
                class="action-icon hover:bg-[var(--control-hover-bg)] text-primary-text"
              >
                <Icon :icon="iconPlay" width="20" height="20" />
              </Button>
              <Button
                variant="unstyled"
                size="icon"
                @click="openBatchDrawer"
                class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
              >
                <Icon :icon="iconList" width="18" height="18" />
              </Button>
            </template>

            <Button
              v-if="userStore.isLoggedIn"
              variant="unstyled"
              size="icon"
              @click="toggleFavoriteAlbum"
              class="action-icon hover:bg-[var(--control-hover-bg)] text-red-500"
            >
              <Icon :icon="isFavoriteAlbum ? iconHeartFilled : iconHeart" width="18" height="18" />
            </Button>
            <Button
              variant="unstyled"
              size="icon"
              @click="handleShareAlbum"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconShare" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" />

        <!-- 2. Sticky Tabs + 表头 -->
        <Tabs
          :model-value="activeTab"
          class="w-full"
          :style="{ minHeight: tabsMinHeight }"
          @update:model-value="handleTabChange"
        >
          <PageStickyHeader
            class="song-list-sticky sticky z-110 bg-bg-main"
            :style="{ top: `${tabsTop}px` }"
          >
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList
                    class="bg-transparent border-none gap-8"
                    @pointerdown="onTabPointerDown"
                    @dblclick="onTabDoubleClick"
                  >
                    <TabsTrigger value="songs">
                      <span class="badge-label">歌曲 <Badge :count="loadedSongCount" /></span>
                    </TabsTrigger>
                    <TabsTrigger value="comments">
                      <span class="badge-label">
                        评论
                        <Badge v-if="commentTotal > 0" :count="commentTotal" />
                      </span>
                    </TabsTrigger>
                  </TabsList>

                  <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                    <SongSearchInput v-model="searchQuery" />
                    <span ref="locateAnchorRef" class="inline-flex">
                      <Button
                        variant="unstyled"
                        size="icon"
                        @click="handleLocate()"
                        class="action-icon song-locate-btn"
                        :tooltip="locateTooltip"
                      >
                        <Icon :icon="iconCurrentLocation" width="18" height="18" />
                      </Button>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <SongListHeader
              v-if="activeTab === 'songs'"
              :sortField="sortField"
              :sortOrder="sortOrder"
              :showCover="true"
              paddingClass="px-6"
              @sort="handleSort"
            />
          </PageStickyHeader>

          <div class="pb-12">
            <TabsContent value="songs" class="px-6 flex flex-col flex-1 min-h-0">
              <SongList
                ref="songListRef"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :loading="loadingSongs"
                :active="activeTab === 'songs'"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: `queue:album:${album?.id ?? getAlbumId()}`,
                  title: album?.albumname || '专辑',
                  subtitle: album?.singerName || '',
                  type: 'album',
                  resumeScope: {
                    kind: isAudiobookAlbum ? 'audiobook' : 'album',
                    id: String(album?.id ?? getAlbumId()),
                  },
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
                "
              />
            </TabsContent>

            <TabsContent value="comments" class="px-6 pt-5 pb-10">
              <div class="w-full">
                <div
                  v-if="hotComments.length"
                  class="text-[12px] font-semibold text-text-secondary mt-2 mb-3"
                >
                  热门评论
                </div>
                <CommentList
                  :resource-id="currentId"
                  :comments="hotComments"
                  :loading="loadingComments"
                  resourceType="album"
                  :fallbackMixSongId="String(currentId)"
                  compact
                  hide-empty
                  @deleted="fetchComments(true)"
                />
                <CommentList
                  :resource-id="currentId"
                  :comments="comments"
                  :loading="loadingComments"
                  :total="commentTotal"
                  resourceType="album"
                  :fallbackMixSongId="String(currentId)"
                  compact
                  :hide-empty="hotComments.length > 0"
                  @deleted="fetchComments(true)"
                />

                <div v-if="hasMoreComments" ref="commentSentinelRef" class="h-1" />

                <div
                  v-if="
                    loadingComments ||
                    ((hotComments.length > 0 || comments.length > 0) && !hasMoreComments)
                  "
                  class="flex justify-center mt-8"
                >
                  <div class="text-[12px] font-semibold text-text-secondary">
                    {{ loadingComments ? '加载中...' : '已加载全部评论' }}
                  </div>
                </div>
              </div>
              <CommentComposer
                class="detail-comment-composer"
                :resource="{ type: 'album', id: String(getAlbumId()), name: album.name }"
                @sent="fetchComments(true)"
              />
            </TabsContent>
          </div>
        </Tabs>
        <Dialog
          v-model:open="showIntroDialog"
          title="专辑介绍"
          :description="album.intro"
          contentClass="detail-intro-dialog"
          descriptionClass="text-[13px]"
          showClose
        />
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.album-artist-line {
  display: block;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.album-singer-link {
  display: inline;
  padding: 0;
  background: transparent;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary-text);
}

.album-singer-link.is-link {
  cursor: pointer;
}

.album-artist-separator {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.search-expand-enter-active,
.search-expand-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.search-expand-enter-from,
.search-expand-leave-to {
  opacity: 0;
  width: 0;
  transform: translateX(10px);
}

:deep(.song-list) {
  @apply px-0;
}

.comment-load-more {
  display: flex;
  justify-content: center;
  margin: 18px 0 12px;
}

.comment-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-end-hint {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.comment-loading-spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--color-primary) 28%, transparent);
  border-top-color: var(--color-primary);
  animation: comment-spin 0.8s linear infinite;
}

@keyframes comment-spin {
  to {
    transform: rotate(360deg);
  }
}
.detail-comment-composer {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  width: min(720px, 100%);
  box-sizing: border-box;
  margin: 16px auto 0;
}
</style>
