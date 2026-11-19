<script setup lang="ts">
import { useRouteTabs } from '@/composables/useRouteTabs';
import { useTabDoubleClickTop, type PageScrollHandle } from '@/composables/useTabDoubleClickTop';
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
import { hideElementTooltip, showElementTooltip } from '@/components/ui/tooltip';
import { createLocateFeedback } from '@/utils/locateFeedback';
defineOptions({ name: 'artist-detail' });
import {
  ref,
  shallowRef,
  nextTick,
  onMounted,
  onActivated,
  onUnmounted,
  computed,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useRouteId } from '@/composables/useRouteId';
import {
  getArtistDetail,
  getArtistSongsV2,
  getArtistAlbums,
  getArtistVideos,
  followArtist,
  unfollowArtist,
} from '@/api/artist';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import DetailPageSkeleton from '@/components/music/DetailPageSkeleton.vue';
import DetailPageError from '@/components/music/DetailPageError.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Select from '@/components/ui/Select.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';

import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { mapAlbumMeta, mapArtistDetailMeta, mapArtistSongV2 } from '@/utils/mappers';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { usePlayerStore } from '@/stores/player';
import { resumeRecordForScope, resumeRecordOfTrack } from '@/stores/player/resume';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { useContentBlacklistStore } from '@/stores/contentBlacklist';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import { captureUserSession, userSessionSources } from '@/utils/userSession';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconCurrentLocation,
  iconPlay,
  iconList,
  iconHeart,
  iconHeartFilled,
  iconShare,
  iconEyeOff,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { copyShareTarget, createShareTarget } from '@/utils/share';
import Button from '@/components/ui/Button.vue';
import { extractFirstObject, extractList } from '@/utils/extractors';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

interface ArtistAlbumCardProps {
  id: string | number;
  name: string;
  coverUrl: string;
  artist?: string;
  publishTime?: string;
}

interface ArtistMvCardProps {
  videoId: string | number;
  hash: string;
  title: string;
  coverUrl: string;
  artist?: string;
  duration?: number;
  publishDate?: string;
  albumAudioId?: string | number;
}

type ArtistSongSort = 'hot' | 'new';
type ArtistAlbumSort = 'hot' | 'new';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const contentBlacklistStore = useContentBlacklistStore();

const route = useRoute();
const router = useRouter();
const { id: currentId, onIdChange } = useRouteId();
const getArtistId = () => currentId.value;

const formatFansCount = (count: number): string => {
  if (count >= 10000) return `${(count / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(count);
};

const loading = ref(true);
const loadingSongs = ref(true);
const loadingAlbums = ref(false);
const loadingMvs = ref(false);
const artist = ref<ReturnType<typeof mapArtistDetailMeta> | null>(null);

// 使用 shallowRef 避免对成千上万个歌曲对象进行深层响应式代理，极大提升性能
const songs = shallowRef<Song[]>([]);
const songSort = ref<ArtistSongSort>(settingStore.artistSongSort);
let songFetchToken = 0;
let disposed = false;
let loadedSongSort: ArtistSongSort | null = null;
let mvFetchToken = 0;
const albums = shallowRef<ReturnType<typeof mapAlbumMeta>[]>([]);
const albumPage = ref(1);
const albumHasMore = ref(false);
const albumFetched = ref(false);
const albumSort = ref<ArtistAlbumSort>(settingStore.artistAlbumSort);
let albumFetchToken = 0;
const mvs = shallowRef<ArtistMvCardProps[]>([]);
const mvTotal = ref(0);
const mvPage = ref(1);
const mvHasMore = ref(false);
const mvFetched = ref(false);
const mvTag = ref<'all' | 'official' | 'live' | 'fan' | 'artist'>('all');

const {
  state: { tab: activeTab },
  isActive,
} = useRouteTabs({ tab: ['songs', 'albums', 'mvs'] });
const loadedSongCount = ref(0);
// const loadedAlbumCount = computed(() => albums.value.length);
const showBatchDrawer = ref(false);
const showIntroDialog = ref(false);
const togglingFollow = ref(false);
const togglingBlacklist = ref(false);

const searchQuery = ref('');
const songListRef = ref<{
  scrollToActive?: () => void;
  scrollToSong?: (songId: string) => Promise<boolean> | void;
  flashSong?: (songId: string) => void;
} | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const songSortOptions = [
  { value: 'new' as const, label: '最新' },
  { value: 'hot' as const, label: '热门' },
];

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
// 当前播放那一行的高亮
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

// 歌曲分页加载器
let songLoader: PagedSongLoader<Song> | null = null;
let songsFullyLoaded = false;
// 首屏到手时 loading 就已经是 false 了，剩下的页还在后台拉；
// 只有全部加载完成，才能说「列表里确实没有这一首」。
const songsAllLoaded = ref(false);

const resetSongTableSort = () => {
  sortField.value = null;
  sortOrder.value = null;
};

const resetSongPaging = (preserveSongs = false) => {
  songFetchToken += 1;
  if (songLoader) {
    songLoader.abort();
    songLoader = null;
  }
  if (!preserveSongs) {
    songsFullyLoaded = false;
    songs.value = [];
    loadedSongCount.value = 0;
  }
  loadingSongs.value = true;
};

const loadArtistSongs = async (artistId = getArtistId()) => {
  if (disposed) return;
  const hadCompleteSongs = songsFullyLoaded && loadedSongSort === songSort.value;
  resetSongPaging(hadCompleteSongs);

  const requestSort = songSort.value;
  const requestToken = ++songFetchToken;
  loadedSongSort = requestSort;
  const isCurrent = () =>
    !disposed &&
    requestToken === songFetchToken &&
    requestSort === songSort.value &&
    artistId === getArtistId();

  songLoader = new PagedSongLoader<Song>(
    async (page, pageSize) => {
      if (!isCurrent()) throw new Error('歌手加载已失效');
      const res = await getArtistSongsV2(artistId, page, pageSize, requestSort);
      if (!isCurrent()) throw new Error('歌手加载已失效');

      const items = extractList(res).map((item) => mapArtistSongV2(item));
      return { items, hasMore: items.length >= pageSize };
    },
    {
      pageSize: 100,
      concurrency: 3,
      dedupeKey: (song) => String(song.id),
      logTag: 'ArtistSongsLoader',
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
        if (!isCurrent()) return;
        toastStore.loadFailed('歌手歌曲');
      },
    },
  );

  const currentLoader = songLoader;
  try {
    await currentLoader.loadFirstPage();
    if (!isCurrent()) return;
    loadingSongs.value = false;
    if (!currentLoader.fullyLoaded && !currentLoader.failed) {
      void currentLoader.loadRemaining();
    }
  } catch {
    if (isCurrent()) {
      loadingSongs.value = false;
    }
  }
};

const switchSongSort = (sort: unknown) => {
  if (sort !== 'new' && sort !== 'hot') return;
  settingStore.artistSongSort = sort;
  if (sort === songSort.value) return;
  songSort.value = sort;
  resetSongTableSort();
  void loadArtistSongs();
};

let detailFetchToken = 0;
const fetchData = async () => {
  if (disposed) return;
  const token = ++detailFetchToken;
  const artistId = getArtistId();
  const isCurrent = () => !disposed && token === detailFetchToken && artistId === getArtistId();
  loading.value = true;

  // 0. 确保关注列表已加载
  void userStore.ensureFollowedArtists();

  // 1. 获取歌手详情
  const detailTask = getArtistDetail(artistId)
    .then((res) => {
      if (!isCurrent()) return;

      const detailRaw = extractFirstObject(res);
      const meta = detailRaw && mapArtistDetailMeta(detailRaw);
      if (!meta?.id) return;
      artist.value = meta;
      // 进详情页就登记：之后从这里播放的进度都记在这个歌手桶里
      playerStore.registerResumeScope('artist', String(meta.id), {
        name: meta.name,
        cover: meta.pic,
      });
    })
    .catch(() => {
      if (isCurrent() && artist.value) toastStore.loadFailed('歌手详情');
    })
    .finally(() => {
      if (isCurrent()) loading.value = false;
    });

  const songsTask = loadArtistSongs(artistId);

  await Promise.allSettled([detailTask, songsTask]);
};

// id 变化时重置数据（仅同路由间切换，如歌手A→歌手B）
onIdChange(() => {
  songsFullyLoaded = false;
  songsAllLoaded.value = false;
  artist.value = null;
  songs.value = [];
  songSort.value = settingStore.artistSongSort;
  songFetchToken += 1;
  albums.value = [];
  mvs.value = [];
  mvFetchToken++;
  loadingMvs.value = false;
  mvFetched.value = false;
  mvTotal.value = 0;
  mvPage.value = 1;
  mvHasMore.value = false;
  albumPage.value = 1;
  albumHasMore.value = false;
  albumFetched.value = false;
  albumSort.value = settingStore.artistAlbumSort;
  albumFetchToken += 1;
  loadingAlbums.value = false;
  loadedSongCount.value = 0;
  searchQuery.value = '';
  resetSongTableSort();
  if (songLoader) {
    songLoader.abort();
    songLoader = null;
  }
  void fetchData();
});

const isFollowed = computed(() => userStore.isArtistFollowed(artist.value?.id ?? ''));

let followGeneration = 0;
watch(
  [getArtistId, ...userSessionSources(userStore)],
  () => {
    followGeneration++;
    togglingFollow.value = false;
  },
  { flush: 'sync' },
);

const isRequestSuccessful = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.status === 1 || record.code === 200 || record.error_code === 0;
};

const toggleArtistFollow = async () => {
  const meta = artist.value;
  if (disposed || !meta || togglingFollow.value) return;
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('关注歌手');
    await router.push({ name: 'login' });
    return;
  }
  const resourceId = getArtistId();
  const generation = ++followGeneration;
  const isSessionCurrent = captureUserSession(userStore);
  const isCurrent = () =>
    !disposed &&
    generation === followGeneration &&
    resourceId === getArtistId() &&
    isSessionCurrent();
  togglingFollow.value = true;
  const previousFollowed = isFollowed.value;
  try {
    const response = previousFollowed ? await unfollowArtist(meta.id) : await followArtist(meta.id);
    if (!isCurrent()) return;
    if (!isRequestSuccessful(response)) {
      toastStore.actionFailed(previousFollowed ? '取消关注' : '关注');
      return;
    }
    if (previousFollowed) {
      userStore.removeFollowedArtist(meta.id);
      toastStore.actionCompleted('已取消关注');
    } else {
      userStore.addFollowedArtist(meta.id);
      toastStore.actionSucceeded('关注');
    }
  } catch {
    if (isCurrent()) toastStore.actionFailed(previousFollowed ? '取消关注' : '关注');
  } finally {
    if (isCurrent()) togglingFollow.value = false;
  }
};

const handleShareArtist = async () => {
  const meta = artist.value;
  if (!meta) return;
  const target = createShareTarget('artist', meta.id ?? getArtistId(), meta.name);
  if (!target) return;
  try {
    await copyShareTarget(target);
    toastStore.actionCompleted('分享链接已复制');
  } catch {
    toastStore.actionFailed('复制分享链接');
  }
};

const blacklistArtistId = computed(() => {
  const meta = artist.value;
  const id = meta?.singerid ?? meta?.author_id ?? meta?.id;
  const normalized = String(id ?? '').trim();
  return /^\d+$/.test(normalized) && !/^0+$/.test(normalized) ? normalized : '';
});

const blacklistArtistName = computed(() => {
  const meta = artist.value;
  return String(meta?.singername ?? meta?.author_name ?? meta?.name ?? '').trim();
});

const artistBlacklistStatus = computed(() =>
  contentBlacklistStore.status('singer', blacklistArtistId.value),
);

let blacklistGeneration = 0;
const blacklistScopeSources = [getArtistId, blacklistArtistId, ...userSessionSources(userStore)];
watch(
  blacklistScopeSources,
  () => {
    blacklistGeneration++;
    togglingBlacklist.value = false;
  },
  { flush: 'sync' },
);

const toggleArtistBlacklist = async () => {
  const singerId = blacklistArtistId.value;
  const name = blacklistArtistName.value;
  if (disposed || !userStore.isLoggedIn || !singerId || !name || togglingBlacklist.value) return;
  const generation = ++blacklistGeneration;
  const resourceId = getArtistId();
  const isSessionCurrent = captureUserSession(userStore);
  const isCurrent = () =>
    !disposed &&
    generation === blacklistGeneration &&
    resourceId === getArtistId() &&
    singerId === blacklistArtistId.value &&
    isSessionCurrent();
  togglingBlacklist.value = true;
  try {
    let currentStatus = artistBlacklistStatus.value;
    if (currentStatus === 'unknown') {
      const loaded = await contentBlacklistStore.ensureFullyLoaded('singer');
      if (!isCurrent()) return;
      if (!loaded) {
        toastStore.warning(contentBlacklistStore.singer.error || '已屏蔽歌手加载失败，请稍后重试');
        return;
      }
      currentStatus = contentBlacklistStore.status('singer', singerId);
    }
    if (currentStatus === 'unknown') {
      toastStore.warning('已屏蔽歌手加载失败，请稍后重试');
      return;
    }
    const entry =
      currentStatus === 'present'
        ? contentBlacklistStore.singer.entries.find(
            (item) => item.label === 'singer' && item.key === singerId,
          )
        : undefined;
    if (currentStatus === 'present' && !entry) return;
    const success = entry
      ? await contentBlacklistStore.remove(entry)
      : await contentBlacklistStore.addSinger({ singerId, name });
    if (!isCurrent()) return;
    if (success) toastStore.actionCompleted(entry ? '已取消屏蔽' : '已屏蔽歌手');
    else
      toastStore.warning(
        contentBlacklistStore.singer.error || `${entry ? '取消屏蔽' : '屏蔽歌手'}失败，请稍后重试`,
      );
  } finally {
    if (isCurrent()) togglingBlacklist.value = false;
  }
};

watch(
  blacklistScopeSources,
  () => {
    const singerId = blacklistArtistId.value;
    if (
      !disposed &&
      userStore.isLoggedIn &&
      singerId &&
      contentBlacklistStore.status('singer', singerId) === 'unknown'
    ) {
      void contentBlacklistStore.ensureFullyLoaded('singer');
    }
  },
  { immediate: true },
);

const secondaryActions = computed(() => {
  if (!artist.value) return [];
  const actions = [] as {
    icon: typeof iconHeart;
    label: string;
    disabled?: boolean;
    emphasized?: boolean;
    tone?: 'default' | 'favorite';
    onTap: () => void | Promise<void>;
  }[];

  if (userStore.isLoggedIn) {
    actions.push({
      icon: isFollowed.value ? iconHeartFilled : iconHeart,
      label: togglingFollow.value
        ? isFollowed.value
          ? '取消中...'
          : '关注中...'
        : isFollowed.value
          ? '已关注'
          : '关注',
      emphasized: isFollowed.value,
      tone: 'favorite' as const,
      onTap: toggleArtistFollow,
    });

    if (blacklistArtistId.value && blacklistArtistName.value) {
      actions.push({
        icon: iconEyeOff,
        label: togglingBlacklist.value
          ? artistBlacklistStatus.value === 'present'
            ? '取消中...'
            : '屏蔽中...'
          : artistBlacklistStatus.value === 'present'
            ? '取消屏蔽'
            : '屏蔽歌手',
        emphasized: artistBlacklistStatus.value === 'present',
        disabled: togglingBlacklist.value,
        onTap: toggleArtistBlacklist,
      });
    }
  }

  actions.push({
    icon: iconShare,
    label: '分享',
    onTap: handleShareArtist,
  });

  return actions;
});

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: `queue:artist:${artist.value?.id ?? getArtistId()}`,
    title: artist.value?.name || '歌手',
    subtitle: '',
    type: 'artist',
  });
};

const handlePlayAll = async () => {
  const loader = songLoader;
  const generation = songFetchToken;
  const resourceId = getArtistId();
  const requestSortField = sortField.value;
  const requestSortOrder = sortOrder.value;
  const requestQuery = searchQuery.value;
  const isCurrent = () =>
    !disposed &&
    generation === songFetchToken &&
    resourceId === getArtistId() &&
    loader === songLoader;
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  const queueOpts = {
    queueId: `queue:artist:${artist.value?.id ?? getArtistId()}`,
    title: artist.value?.name || '歌手',
    subtitle: '',
    type: 'artist' as const,
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
// 歌手桶里记着上次听到哪一首，定位按钮优先去那儿
const bucketScope = computed(() => {
  const id = String(getArtistId() ?? '');
  if (!id) return null;
  return (
    playerStore.resumeScopes.find((entry) => entry.kind === 'artist' && entry.id === id) ?? null
  );
});

const bucketTrackId = computed(() => bucketScope.value?.trackId ?? '');

const bucketTarget = computed(() => {
  const trackId = bucketTrackId.value;
  if (!trackId) return null;
  const record = resumeRecordForScope(playerStore.$state, bucketScope.value);
  if (!record || !(record.position > 0)) return null;
  return { trackId, position: record.position };
});

// 「先播了、再进这一页」也要记，但只认「此刻就在这一页、而且真的在播放」
// 归属直接比歌曲自带的歌手 ID，不依赖本页歌曲列表是否已经加载到这一首。
const adoptPlayingTrack = () => {
  if (!isActive.value || !playerStore.isPlaying) return;
  const song = playerStore.currentTrackSnapshot;
  if (!song) return;
  const artistId = String(getArtistId() ?? '');
  const owners = [...(song.artists ?? []), ...(song.singers ?? [])];
  if (!artistId || !owners.some((item) => String(item.id ?? '') === artistId)) return;
  // 从搜索/历史等单曲播放进来的，不认领（用户要求）
  const record = resumeRecordOfTrack(playerStore.$state, String(song.id));
  if (record?.entry === 'single') return;
  playerStore.adoptResumeScope('artist', artistId, song);
};

// 停在这一页时，用户点了播放/换了曲目也要认领；离开页面或暂停都不认
watch([() => playerStore.currentTrackId, () => playerStore.isPlaying, isActive], () => {
  adoptPlayingTrack();
});

const locateFeedback = createLocateFeedback();

const LOCATE_COOLDOWN_MS = 3000;
let lastLocateAt = 0;

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
  String(route.name ?? '') === 'artist-detail' &&
  String(route.params.id ?? '') === String(getArtistId());

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

// 有上次听到的记录就定位它；没有记录才退回「定位当前播放」
const locateTooltip = computed(() => (bucketTarget.value ? '定位上次听到' : '定位当前播放'));

// 记录指向的那一首已经不在本页了：把这条续播记录一起删掉
const forgetResumeScopeOf = (trackId: string) => {
  const scope = playerStore.resumeScopes.find(
    (entry) => entry.trackId === trackId && entry.kind === 'artist',
  );
  if (!scope) return;
  playerStore.forgetResumeScope(scope.kind, scope.id);
};

const handleLocate = async () => {
  if (!isCurrentRoute()) return;
  const now = Date.now();
  if (now - lastLocateAt < LOCATE_COOLDOWN_MS) return;
  lastLocateAt = now;
  // 定位对象是「上次听到的那一首」：播放器放的是别的歌也照样滚过去
  const targetId = bucketTarget.value?.trackId ?? String(playerStore.currentTrackId ?? '');
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
  const targetEntry = bucketTarget.value;
  // 没有进度记录就只滚不播；正在播这一首也不用重来
  if (!targetEntry) return;
  if (isCurrentTrack && playerStore.isPlaying) return;
  // 要不要真的播，听「跳转后自动播放」开关
  if (!settingStore.resumeAutoPlayOnLocate) return;
  const targetSong = songs.value.find((song) => String(song.id) === targetId);
  if (targetSong) scheduleResumePlay(targetSong, targetEntry.position);
};

// 从搜索页卡片跳过来时落地即定位
let pendingLocateFromQuery = String(route.query.locate ?? '') === 'resume';
// 气泡每次进入只弹一次，别被分页加载反复触发
let locateHintShownOnce = false;
// 等歌曲列表真正就绪（不被 loading 挡住）再定位，否则虚拟列表还没有行可以滚
watch(
  [() => songs.value.length, loadingSongs],
  ([length, isLoading]) => {
    if (length === 0 || isLoading) return;
    if (pendingLocateFromQuery) {
      pendingLocateFromQuery = false;
      void handleLocate();
      return;
    }
    adoptPlayingTrack();
    void nextTick(() => {
      if (!bucketTarget.value || locateHintShownOnce) return;
      locateHintShownOnce = true;
      showLocateHint();
    });
  },
  { immediate: true },
);

// 页面被路由缓存复用同一实例时，挂载期只消费一次 pendingLocateFromQuery；
// 再次带 locate=resume 进入（例如从播放历史的续播行再点一次）也要重新定位
const relocateFromQuery = () => {
  // 页面被 RouteKeepAlive 缓存着也会收到路由变化，不在这一页就不该动手
  if (!isCurrentRoute()) return;
  if (String(route.query.locate ?? '') !== 'resume') return;
  if (songs.value.length > 0 && !loadingSongs.value) {
    void handleLocate();
    return;
  }
  pendingLocateFromQuery = true;
};

watch(() => route.query.locate, relocateFromQuery);

const getAlbumCardProps = (album: ReturnType<typeof mapAlbumMeta>): ArtistAlbumCardProps => {
  return {
    id: album.id,
    name: album.name,
    coverUrl: album.pic,
    artist: album.singerName,
    publishTime: album.publishTime,
  };
};

const albumSearchQuery = ref('');

const filteredAlbums = computed(() => {
  const query = albumSearchQuery.value.trim().toLowerCase();
  if (!query) return albums.value;
  return albums.value.filter((album) => {
    const name = album.name?.toLowerCase() || '';
    const publishTime = album.publishTime?.toLowerCase() || '';
    return name.includes(query) || publishTime.includes(query);
  });
});

const albumCards = computed(() => filteredAlbums.value.map((entry) => getAlbumCardProps(entry)));

const mapMvItem = (item: Record<string, unknown>): ArtistMvCardProps => {
  const hdpic = String(item.hdpic ?? item.cover ?? '').replace('{size}', '400');
  const cover = String(item.cover ?? '');
  return {
    videoId: item.video_id as string | number,
    hash: String(item.mkv_qhd_hash ?? item.mkv_sd_hash ?? ''),
    title: String(item.video_name ?? ''),
    coverUrl: hdpic || cover,
    artist: String(item.author_name ?? ''),
    duration: Number(item.timelength ?? 0),
    publishDate: String(item.publish_date ?? '').split(' ')[0],
    albumAudioId: item.album_audio_id as string | number | undefined,
  };
};

const fetchMvs = async (page = 1) => {
  if (disposed || loadingMvs.value) return;
  const artistId = getArtistId();
  const requestTag = mvTag.value;
  const requestToken = ++mvFetchToken;
  const isCurrent = () =>
    !disposed &&
    artistId === getArtistId() &&
    requestTag === mvTag.value &&
    requestToken === mvFetchToken;
  loadingMvs.value = true;
  try {
    const res = await getArtistVideos(artistId, page, 30, requestTag);
    if (!isCurrent()) return;

    const record = res && typeof res === 'object' ? (res as Record<string, unknown>) : {};
    const list = extractList(res);
    const total = Number(record.total ?? 0);
    const mapped = list
      .map((item: unknown) =>
        item && typeof item === 'object' ? mapMvItem(item as Record<string, unknown>) : null,
      )
      .filter((item): item is ArtistMvCardProps => item !== null && !!item.videoId);

    if (page === 1) {
      mvs.value = mapped;
    } else {
      mvs.value = [...mvs.value, ...mapped];
    }
    mvTotal.value = total;
    mvPage.value = page;
    mvHasMore.value = mvs.value.length < total;
    mvFetched.value = true;
  } catch {
    if (isCurrent()) toastStore.loadFailed('歌手MV');
  } finally {
    if (isCurrent()) loadingMvs.value = false;
  }
};

// const loadedMvCount = computed(() => (mvFetched.value ? mvTotal.value : 0));

const mvTagOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'official' as const, label: '官方' },
  { value: 'live' as const, label: '现场' },
  { value: 'fan' as const, label: '饭制' },
  { value: 'artist' as const, label: '歌手发布' },
];

const switchMvTag = (tag: typeof mvTag.value) => {
  if (tag === mvTag.value) return;
  mvFetchToken++;
  loadingMvs.value = false;
  mvTag.value = tag;
  mvs.value = [];
  mvTotal.value = 0;
  mvPage.value = 1;
  mvHasMore.value = false;
  mvFetched.value = false;
  void fetchMvs(1);
};

const albumSortOptions = [
  { value: 'new' as const, label: '最新' },
  { value: 'hot' as const, label: '热门' },
];

const resetAlbumPaging = () => {
  albumFetchToken += 1;
  loadingAlbums.value = false;
  albums.value = [];
  albumPage.value = 1;
  albumHasMore.value = false;
  albumFetched.value = false;
};

const switchAlbumSort = (sort: unknown) => {
  if (sort !== 'new' && sort !== 'hot') return;
  settingStore.artistAlbumSort = sort;
  if (sort === albumSort.value) return;
  albumSort.value = sort;
  resetAlbumPaging();
  if (activeTab.value === 'albums') void fetchMoreAlbums();
};

const fetchMoreAlbums = async () => {
  if (disposed || loadingAlbums.value || (albumFetched.value && !albumHasMore.value)) return;
  const artistId = getArtistId();
  const nextPage = albumFetched.value ? albumPage.value + 1 : 1;
  const requestSort = albumSort.value;
  const requestToken = ++albumFetchToken;
  const isCurrent = () =>
    !disposed &&
    requestToken === albumFetchToken &&
    requestSort === albumSort.value &&
    artistId === getArtistId();
  loadingAlbums.value = true;
  try {
    const res = await getArtistAlbums(artistId, nextPage, 30, requestSort);
    if (!isCurrent()) return;

    const fetched = extractList(res).map((item) => mapAlbumMeta(item));
    if (nextPage === 1) {
      albums.value = fetched;
    } else {
      albums.value = [...albums.value, ...fetched];
    }
    albumPage.value = nextPage;
    albumFetched.value = true;
    const totalAlbums = artist.value?.albumCount ?? 0;
    albumHasMore.value =
      fetched.length >= 30 && (totalAlbums <= 0 || albums.value.length < totalAlbums);
  } catch {
    if (isCurrent()) toastStore.loadFailed('歌手专辑');
  } finally {
    if (isCurrent()) {
      loadingAlbums.value = false;
    }
  }
};

const scrollContainerRef = useScrollContainer();

// 双击 tab 回到顶部：本页是 PageScrollContainer 的父组件，useScrollContainer() 只能拿到 null
const pageScrollRef = ref<PageScrollHandle | null>(null);
const { onTabPointerDown, onTabDoubleClick } = useTabDoubleClickTop(() => pageScrollRef.value);
const loadMoreSentinelRef = ref<HTMLElement | null>(null);
let loadMoreObserver: IntersectionObserver | null = null;

const setupLoadMoreObserver = () => {
  loadMoreObserver?.disconnect();
  const root = scrollContainerRef.value ?? null;
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      if (activeTab.value === 'mvs' && mvHasMore.value && !loadingMvs.value) {
        void fetchMvs(mvPage.value + 1);
      }
      if (activeTab.value === 'albums' && albumHasMore.value && !loadingAlbums.value) {
        void fetchMoreAlbums();
      }
    },
    { root, rootMargin: '0px 0px 300px 0px' },
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

watch(scrollContainerRef, () => {
  setupLoadMoreObserver();
});

onMounted(() => {
  void fetchData();
  loadActiveTabData();
  setupLoadMoreObserver();
});

onActivated(() => {
  loadActiveTabData();
  if (!artist.value && !loading.value) {
    // fetchData 会读取当前歌曲排序，不再同时发起一次排序加载。
    songSort.value = settingStore.artistSongSort;
    void fetchData();
  }
  // 其他歌手页可能已修改偏好；恢复缓存时同步排序和数据，避免标签与结果不一致。
  switchSongSort(settingStore.artistSongSort);
  switchAlbumSort(settingStore.artistAlbumSort);
  if (songs.value.length > 0 && !loadingSongs.value) {
    relocateFromQuery();
    adoptPlayingTrack();
    // 每次回到这一页，只要有上次听到的记录就在靶心弹一次；带 locate 进来会直接定位，不弹
    locateHintShownOnce = false;
    if (String(route.query.locate ?? '') !== 'resume' && bucketTarget.value) {
      void nextTick(() => {
        if (locateHintShownOnce) return;
        locateHintShownOnce = true;
        showLocateHint();
      });
    }
  }
});

// 点击和路由恢复共用懒加载逻辑。
const loadActiveTabData = () => {
  if (!isActive.value) return;
  if (activeTab.value === 'mvs' && !mvFetched.value) void fetchMvs(1);
  if (activeTab.value === 'albums' && !albumFetched.value) void fetchMoreAlbums();
};
watch(activeTab, loadActiveTabData);

onUnmounted(() => {
  disposed = true;
  detailFetchToken++;
  songFetchToken++;
  albumFetchToken++;
  mvFetchToken++;
  songLoader?.abort();
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
});
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="artist-detail-page">
    <div class="artist-detail-container bg-bg-main min-h-full">
      <DetailPageSkeleton
        v-if="loading && !artist?.id"
        typeLabel="ARTIST"
        cover="round"
        :expandedHeight="196"
      />

      <DetailPageError v-else-if="!artist?.id" resource-name="歌手" @retry="fetchData" />

      <template v-else-if="artist">
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="ARTIST"
          :title="artist.name"
          :description="artist.intro"
          @description-click="showIntroDialog = true"
          :coverUrl="artist.pic"
          :hasDetails="true"
          distribute-details
          :expandedHeight="196"
        >
          <template #details>
            <div class="contents text-text-secondary">
              <div class="text-[13px] font-semibold text-primary-text">
                {{ artist.songCount || songs.length }} 歌曲 •
                {{ artist.albumCount || albums.length }} 专辑
                <template v-if="artist.mvCount"> • {{ artist.mvCount }} MV </template>
              </div>
              <div
                v-if="artist.fansCount || artist.birthday"
                class="flex items-center gap-3 text-[12px] text-text-secondary"
              >
                <span v-if="artist.fansCount" class="flex items-center gap-1">
                  <span class="font-semibold text-text-main">{{
                    formatFansCount(artist.fansCount)
                  }}</span>
                  粉丝
                </span>
                <span v-if="artist.birthday">🎂 {{ artist.birthday }}</span>
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
              @click="toggleArtistFollow"
              class="action-icon hover:bg-[var(--control-hover-bg)] text-red-500"
            >
              <Icon :icon="isFollowed ? iconHeartFilled : iconHeart" width="18" height="18" />
            </Button>
            <Button
              v-if="userStore.isLoggedIn && blacklistArtistId && blacklistArtistName"
              variant="unstyled"
              size="icon"
              :disabled="togglingBlacklist"
              :tooltip="artistBlacklistStatus === 'present' ? '取消屏蔽' : '屏蔽歌手'"
              :aria-label="artistBlacklistStatus === 'present' ? '取消屏蔽' : '屏蔽歌手'"
              @click="toggleArtistBlacklist"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconEyeOff" width="18" height="18" />
            </Button>
            <Button
              variant="unstyled"
              size="icon"
              @click="handleShareArtist"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconShare" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" />

        <Tabs v-model="activeTab" class="w-full" :style="{ minHeight: tabsMinHeight }">
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
                      <span class="badge-label"
                        >歌曲 <Badge v-if="loadedSongCount > 0" :count="loadedSongCount"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="albums">
                      <span class="badge-label"
                        >专辑
                        <Badge v-if="albumFetched && albums.length > 0" :count="albums.length"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="mvs">
                      <span class="badge-label"
                        >MV <Badge v-if="mvFetched && mvs.length > 0" :count="mvs.length"
                      /></span>
                    </TabsTrigger>
                  </TabsList>

                  <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                    <Select
                      :model-value="songSort"
                      :options="songSortOptions"
                      class="artist-sort-select"
                      aria-label="歌曲排序"
                      content-align="end"
                      @update:model-value="switchSongSort($event)"
                    />
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

                  <!-- 专辑 tab 右侧搜索 -->
                  <div v-if="activeTab === 'albums'" class="flex items-center gap-2">
                    <SongSearchInput v-model="albumSearchQuery" placeholder="搜索专辑..." />
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
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :loading="loadingSongs"
                :active="activeTab === 'songs'"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: `queue:artist:${artist?.id ?? getArtistId()}`,
                  title: artist?.name || '歌手',
                  subtitle: '',
                  type: 'artist',
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
                "
              />
            </TabsContent>

            <TabsContent value="albums" class="mt-4 px-6">
              <div class="flex items-center gap-3 mb-4 px-2">
                <Select
                  :model-value="albumSort"
                  :options="albumSortOptions"
                  class="artist-sort-select"
                  aria-label="专辑排序"
                  content-align="start"
                  @update:model-value="switchAlbumSort($event)"
                />
                <span v-if="albumFetched" class="text-[11px] text-text-secondary ml-auto">
                  共 {{ artist.albumCount || albums.length }} 张
                </span>
              </div>
              <VirtualGrid
                class="px-2"
                :items="albumCards"
                :loading="loadingAlbums && albums.length === 0"
                :active="activeTab === 'albums'"
                :itemMinWidth="180"
                :itemAspectRatio="1"
                :itemChromeHeight="66"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                keyField="id"
              >
                <template #default="{ item }">
                  <AlbumCard v-bind="item" />
                </template>
              </VirtualGrid>
              <div
                v-if="albumHasMore"
                ref="loadMoreSentinelRef"
                class="flex justify-center py-4 text-[12px] text-text-secondary"
              >
                {{ loadingAlbums ? '加载中...' : '' }}
              </div>
            </TabsContent>

            <TabsContent value="mvs" class="mt-4 px-6">
              <div class="flex items-center gap-3 mb-4 px-2">
                <div class="flex items-center gap-1.5">
                  <Button
                    v-for="opt in mvTagOptions"
                    :key="opt.value"
                    variant="unstyled"
                    size="none"
                    :class="['mv-tag-btn', mvTag === opt.value ? 'is-active' : '']"
                    @click="switchMvTag(opt.value)"
                  >
                    {{ opt.label }}
                  </Button>
                </div>
                <span v-if="mvFetched" class="text-[11px] text-text-secondary ml-auto">
                  共 {{ mvTotal }} 个
                </span>
              </div>
              <VirtualGrid
                class="px-2"
                :items="mvs"
                :loading="loadingMvs && mvs.length === 0"
                :active="activeTab === 'mvs'"
                :itemMinWidth="200"
                :itemAspectRatio="16 / 9"
                :itemChromeHeight="66"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                keyField="videoId"
              >
                <template #default="{ item }">
                  <MvCard v-bind="item" />
                </template>
              </VirtualGrid>
              <div
                v-if="mvHasMore"
                ref="loadMoreSentinelRef"
                class="flex justify-center py-4 text-[12px] text-text-secondary"
              >
                {{ loadingMvs ? '加载中...' : '' }}
              </div>
            </TabsContent>
          </div>
        </Tabs>
        <Dialog
          v-model:open="showIntroDialog"
          title="歌手介绍"
          :description="artist.intro"
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

.artist-sort-select {
  min-width: 88px;
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

.mv-tag-btn {
  @apply px-3 py-1.5 rounded-lg text-[12px] font-semibold text-text-secondary transition-all;
  background: transparent;
}

.mv-tag-btn:hover {
  @apply text-text-main;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.mv-tag-btn.is-active {
  @apply text-primary-text;
  background: var(--color-primary-light);
}
</style>
