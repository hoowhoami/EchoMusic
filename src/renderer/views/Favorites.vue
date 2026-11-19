<script setup lang="ts">
import { watchUserSession } from '@/utils/watchUserSession';

import { useRouteTabs } from '@/composables/useRouteTabs';
import { useTabDoubleClickTop, type PageScrollHandle } from '@/composables/useTabDoubleClickTop';
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
defineOptions({ name: 'favorites' });
import {
  computed,
  nextTick,
  onActivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useVideoCollectionStore } from '@/stores/videoCollection';
import { usePlaylistCoversStore } from '@/stores/playlistCovers';
import { useToastStore } from '@/stores/toast';
import { useThemeStore } from '@/stores/theme';
import { getAlbumCategories } from '@/api/album';
import { deleteUserFollow, getUserFollow, getUserVideoCollect } from '@/api/user';
import { unfollowArtist } from '@/api/artist';
import { mapArtistMeta } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { ArtistMeta } from '@/models/artist';
import { createThemedIconCoverUrl } from '@/utils/cover';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader, {
  type SortField,
  type SortOrder,
} from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import CardBatchDrawer from '@/components/music/CardBatchDrawer.vue';
import ContextMenuPanel from '@/components/music/ContextMenuPanel.vue';
import PlaylistOrderDialog from '@/components/music/PlaylistOrderDialog.vue';
import type { PlaylistOrderTarget } from '@/services/playlistOrdering';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Button from '@/components/ui/Button.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { iconCurrentLocation, iconHeart, iconList, iconPlay, iconArrowsSort } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const videoCollectionStore = useVideoCollectionStore();
const playlistCoversStore = usePlaylistCoversStore();
void playlistCoversStore.hydrate();
const toastStore = useToastStore();
const themeStore = useThemeStore();

const isLoggedIn = computed(() => userStore.isLoggedIn);
const currentUserKey = computed(() =>
  String(userStore.info?.userid ?? userStore.info?.userId ?? ''),
);
const {
  state: { tab: activeTab },
  select: selectTabs,
  isActive,
} = useRouteTabs({ tab: ['songs', 'singers', 'users', 'albums', 'audiobooks', 'videos'] });
const sliverHeaderRef = ref<InstanceType<typeof SliverHeader> | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

// ========== 歌曲 Tab ==========
const songs = computed(() => playlistStore.favorites);
const favoritesLoading = computed(() => playlistStore.favoritesLoading);
// 加载状态跟随实际请求，不能从会被缓存保留的刷新查询参数推导。
const routeRefreshLoading = ref(false);
let refreshGeneration = 0;
const songListLoading = computed(
  () => songs.value.length === 0 && (favoritesLoading.value || routeRefreshLoading.value),
);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
const showPlaylistOrder = ref(false);
const playlistOrderTarget = computed<PlaylistOrderTarget | null>(() => {
  const liked = playlistStore.likedPlaylist;
  if (!isLoggedIn.value || !liked || liked.listCreateUserid !== userStore.info?.userid) return null;
  const listid = Number(liked.listid ?? liked.id);
  return Number.isSafeInteger(listid) && listid > 0
    ? {
        kind: 'tracks',
        listid,
        queryId: playlistStore.likedPlaylistQueryId ?? liked.id,
        title: liked.name,
      }
    : null;
});
const handlePlaylistOrderSaved = () => {
  sortField.value = null;
  sortOrder.value = null;
  searchQuery.value = '';
};

const favoriteCoverUrl = computed(() => {
  const liked = playlistStore.likedPlaylist;
  const cover = liked ? playlistCoversStore.coverFor(liked, userStore.info?.userid) : '';
  return cover || createThemedIconCoverUrl(themeStore.sourceColor, iconHeart);
});

const sortedSongs = computed(() => {
  return sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  });
});
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') sortOrder.value = 'desc';
    else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  const queueOpts = {
    queueId: 'queue:favorites',
    title: '我最喜爱',
    subtitle: '',
    type: 'playlist' as const,
  };
  // 先用已加载的歌曲开始播放
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, queueOpts);
  // 后台等待全部加载完，静默更新播放队列
  const allSongs = Array.from(await playlistStore.waitForFavoritesLoaded()) as Song[];
  const sortedAllSongs = sortSongs(allSongs, sortField.value, sortOrder.value, {
    indexSource: allSongs,
  });
  const displayedAllSongs = filterSongsByQuery(sortedAllSongs, searchQuery.value);
  if (displayedAllSongs.length > queueSongs.length) {
    playlistStore.setPlaybackQueueWithOptions(
      Array.from(displayedAllSongs) as Song[],
      0,
      queueOpts,
    );
  }
};

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:favorites',
    title: '我最喜爱',
    subtitle: '',
    type: 'playlist',
  });
};

const handleLocate = () => songListRef.value?.scrollToActive?.();
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

/** 批量取消收藏：逐首从「我喜欢」云歌单移除，进度回传给批量抽屉 */
const handleBatchUnfavorite = async (
  songsToRemove: Song[],
  onProgress?: (done: number, total: number) => void,
) => {
  const total = songsToRemove.length;
  let done = 0;
  let failed = 0;
  for (const song of songsToRemove) {
    const removed = await playlistStore.removeFavoriteSong(song);
    if (removed) {
      done += 1;
    } else {
      failed += 1;
    }
    onProgress?.(done + failed, total);
  }
  if (failed > 0) {
    throw new Error(`已取消收藏 ${done} 首，${failed} 首失败`);
  }
  toastStore.actionCompleted(`已取消收藏 ${done} 首`);
};

// ========== 卡片 Tab 公共：排序 ==========
type CardTab = 'singers' | 'users' | 'albums' | 'audiobooks' | 'videos';
type CardSortField = 'default' | 'name' | 'time';

const CARD_TABS: CardTab[] = ['singers', 'users', 'albums', 'audiobooks', 'videos'];
const CARD_TAB_LABELS: Record<CardTab, string> = {
  singers: '歌手',
  users: '用户',
  albums: '专辑',
  audiobooks: '有声/长专',
  videos: '视频',
};
const CARD_TAB_ACTIONS: Record<CardTab, string> = {
  singers: '取消关注',
  users: '取消关注',
  albums: '取消收藏',
  audiobooks: '取消收藏',
  videos: '取消收藏',
};

const cardSortField = ref<CardSortField>('default');
const cardSortOrder = ref<'asc' | 'desc'>('asc');
const sortMenuOpen = ref(false);
const sortMenuPoint = ref({ x: 0, y: 0 });

const activeCardTab = computed<CardTab | null>(() =>
  CARD_TABS.includes(activeTab.value as CardTab) ? (activeTab.value as CardTab) : null,
);

// 歌手 / 用户 / 视频没有关注或收藏时间字段，收藏时间排序只对专辑与有声/长专开放
const cardTimeSortEnabled = computed(
  () => activeTab.value === 'albums' || activeTab.value === 'audiobooks',
);

const applyCardSort = <T,>(
  list: T[],
  readName: (item: T) => string | undefined,
  readTime?: (item: T) => number | undefined,
): T[] => {
  const field = cardSortField.value;
  if (field === 'default') return list;
  const direction = cardSortOrder.value === 'asc' ? 1 : -1;
  const entries = list.map((item, index) => ({
    item,
    index,
    name: (readName(item) ?? '').toLowerCase(),
    time: readTime ? (readTime(item) ?? 0) : 0,
  }));
  entries.sort((left, right) => {
    if (field === 'name') {
      const compared = left.name.localeCompare(right.name, 'zh-Hans-CN');
      if (compared !== 0) return compared * direction;
    } else if (left.time !== right.time) {
      return (left.time - right.time) * direction;
    }
    return left.index - right.index;
  });
  return entries.map((entry) => entry.item);
};

interface CardSortOption {
  label: string;
  field: CardSortField;
  order: 'asc' | 'desc';
}

const cardSortOptions = computed<CardSortOption[]>(() => {
  const options: CardSortOption[] = [
    { label: '默认顺序', field: 'default', order: 'asc' },
    { label: '名称正序', field: 'name', order: 'asc' },
    { label: '名称倒序', field: 'name', order: 'desc' },
  ];
  if (cardTimeSortEnabled.value) {
    options.push(
      { label: '收藏时间正序', field: 'time', order: 'asc' },
      { label: '收藏时间倒序', field: 'time', order: 'desc' },
    );
  }
  return options;
});

const isCardSortOptionActive = (option: CardSortOption) =>
  cardSortField.value === option.field &&
  (option.field === 'default' || cardSortOrder.value === option.order);

const applyCardSortOption = (option: CardSortOption) => {
  cardSortField.value = option.field;
  cardSortOrder.value = option.order;
  sortMenuOpen.value = false;
};

const openSortMenu = (event: MouseEvent) => {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  sortMenuPoint.value = rect
    ? { x: rect.left, y: rect.bottom + 6 }
    : { x: event.clientX, y: event.clientY };
  sortMenuOpen.value = !sortMenuOpen.value;
};

// ========== 关注 Tab ==========
const singerSearchQuery = ref('');
const userSearchQuery = ref('');
const followedSingers = shallowRef<ArtistMeta[]>([]);
const followedUsers = shallowRef<ArtistMeta[]>([]);
const followedLoading = ref(false);
const followedLoaded = ref(false);
let accountGeneration = 0;

const isCurrentAccountRequest = (generation: number, userKey: string) =>
  generation === accountGeneration && userKey === currentUserKey.value && isLoggedIn.value;

const filteredSingers = computed(() => {
  const query = singerSearchQuery.value.trim().toLowerCase();
  if (!query) return followedSingers.value;
  return followedSingers.value.filter((artist) => {
    const name = artist.name?.toLowerCase() || '';
    return name.includes(query);
  });
});

const filteredUsers = computed(() => {
  const query = userSearchQuery.value.trim().toLowerCase();
  if (!query) return followedUsers.value;
  return followedUsers.value.filter((artist) => {
    const name = artist.name?.toLowerCase() || '';
    return name.includes(query);
  });
});

const singerCards = computed(() =>
  applyCardSort(filteredSingers.value, (artist) => artist.name).map((artist) => ({
    id: artist.id,
    name: artist.name,
    coverUrl: artist.pic,
    songCount: artist.songCount,
    albumCount: artist.albumCount,
    fansCount: artist.fansCount,
    sourceDesc: (artist as unknown as Record<string, unknown>).sourceDesc as string | undefined,
    isSinger: true,
  })),
);

const userCards = computed(() =>
  applyCardSort(filteredUsers.value, (artist) => artist.name).map((artist) => ({
    id: artist.id,
    name: artist.name,
    coverUrl: artist.pic,
    songCount: artist.songCount,
    albumCount: artist.albumCount,
    fansCount: artist.fansCount,
    sourceDesc: (artist as unknown as Record<string, unknown>).sourceDesc as string | undefined,
    isSinger: false,
  })),
);

const fetchFollowed = async () => {
  if (!isLoggedIn.value) return;
  if (!currentUserKey.value) return;
  if (followedLoaded.value || followedLoading.value) return;
  const requestGeneration = accountGeneration;
  const requestUserKey = currentUserKey.value;
  followedLoading.value = true;
  try {
    const res = await getUserFollow();
    if (!isCurrentAccountRequest(requestGeneration, requestUserKey)) return;
    if (res && typeof res === 'object' && 'data' in res) {
      const data = (res as { data?: { lists?: unknown[] } }).data;
      const lists = Array.isArray(data?.lists) ? data.lists : [];
      const singers: ArtistMeta[] = [];
      const users: ArtistMeta[] = [];
      lists.forEach((item) => {
        const record = item as Record<string, unknown>;
        const artist = mapArtistMeta({
          singerid: record.singerid,
          singername: record.nickname,
          imgurl: record.pic,
          id: record.singerid || record.userid,
          name: record.nickname,
          pic: record.pic,
        });
        // 附加其他信息以便区分
        Object.assign(artist, {
          is_star: record.is_star,
          iden: record.iden,
          source_desc: typeof record.source_desc === 'string' ? record.source_desc : '',
        });

        if (record.singerid && record.iden_type === 1) {
          singers.push(artist);
        } else {
          users.push(artist);
        }
      });
      followedSingers.value = singers;
      followedUsers.value = users;
    }
    followedLoaded.value = true;
  } catch {
    if (!isCurrentAccountRequest(requestGeneration, requestUserKey)) return;
    toastStore.loadFailed('关注列表');
  } finally {
    if (!isCurrentAccountRequest(requestGeneration, requestUserKey)) return;
    followedLoading.value = false;
  }
};

const resetFollowed = () => {
  followedSingers.value = [];
  followedUsers.value = [];
  followedLoaded.value = false;
  followedLoading.value = false;
  singerSearchQuery.value = '';
  userSearchQuery.value = '';
};

// ========== 专辑 Tab ==========
const albumSearchQuery = ref('');

const favoritedAlbums = computed(() =>
  playlistStore.userPlaylists.filter((playlist) => playlist.source === 2),
);

// 收藏列表接口不返回专辑类别，只能按专辑 ID 回查：'2' 是有声/长专，其余按音乐专辑处理
const albumCategories = ref<Record<string, '1' | '2'>>({});
const albumCategoriesLoading = ref(false);
let albumCategoriesGeneration = 0;

type AlbumLike = { listCreateListid?: unknown; id?: unknown };

const albumCategoryKey = (album: AlbumLike) => String(album.listCreateListid ?? album.id);

const isAudiobookAlbum = (album: AlbumLike) =>
  albumCategories.value[albumCategoryKey(album)] === '2';

const fetchMissingAlbumCategories = async () => {
  const generation = albumCategoriesGeneration;
  const ids = Array.from(
    new Set(
      favoritedAlbums.value
        .map((album) => albumCategoryKey(album))
        .filter((id) => id.length > 0 && albumCategories.value[id] === undefined),
    ),
  );
  if (!ids.length || albumCategoriesLoading.value) return;
  albumCategoriesLoading.value = true;
  try {
    const categories = await getAlbumCategories(ids);
    if (generation !== albumCategoriesGeneration) return;
    const next = { ...albumCategories.value };
    for (const id of ids) next[id] = categories.get(id) === '2' ? '2' : '1';
    albumCategories.value = next;
  } catch {
    // 回查失败时保持「按音乐专辑处理」，不阻塞收藏列表展示
  } finally {
    if (generation === albumCategoriesGeneration) albumCategoriesLoading.value = false;
  }
};

// 收藏列表变化（首次加载、刷新、切换账号）时补齐尚未回查的类别
watch(
  () => favoritedAlbums.value.map((album) => albumCategoryKey(album)).join(','),
  () => {
    void fetchMissingAlbumCategories();
  },
  { immediate: true },
);

const audiobookAlbums = computed(() => favoritedAlbums.value.filter(isAudiobookAlbum));
const musicAlbums = computed(() =>
  favoritedAlbums.value.filter((album) => !isAudiobookAlbum(album)),
);

const filteredAlbums = computed(() => {
  const query = albumSearchQuery.value.trim().toLowerCase();
  if (!query) return musicAlbums.value;
  return musicAlbums.value.filter((album) => {
    const name = album.name?.toLowerCase() || '';
    const artist = album.nickname?.toLowerCase() || album.list_create_username?.toLowerCase() || '';
    return name.includes(query) || artist.includes(query);
  });
});

const albumCards = computed(() =>
  applyCardSort(
    filteredAlbums.value,
    (album) => album.name,
    (album) => album.createTime,
  ).map((album) => ({
    id: albumCategoryKey(album),
    name: album.name,
    coverUrl: album.pic,
    artist: album.nickname || album.list_create_username || '',
  })),
);

// ========== 有声/长专 Tab ==========
const audiobookSearchQuery = ref('');

const filteredAudiobookAlbums = computed(() => {
  const query = audiobookSearchQuery.value.trim().toLowerCase();
  if (!query) return audiobookAlbums.value;
  return audiobookAlbums.value.filter((album) => {
    const name = album.name?.toLowerCase() || '';
    const artist = album.nickname?.toLowerCase() || album.list_create_username?.toLowerCase() || '';
    return name.includes(query) || artist.includes(query);
  });
});

const audiobookCards = computed(() =>
  applyCardSort(
    filteredAudiobookAlbums.value,
    (album) => album.name,
    (album) => album.createTime,
  ).map((album) => ({
    id: albumCategoryKey(album),
    name: album.name,
    coverUrl: album.pic,
    artist: album.nickname || album.list_create_username || '',
    query: { category: '2' },
  })),
);

// ========== 视频 Tab ==========
interface VideoItem {
  id: string | number;
  hash: string;
  title: string;
  coverUrl: string;
  artist: string;
  duration: number;
  albumAudioId: string | number;
}

const videos = shallowRef<VideoItem[]>([]);
const videoSearchQuery = ref('');
const videosLoading = ref(false);
const videosLoaded = ref(false);
const videosPage = ref(1);
const videosHasMore = ref(true);
const VIDEOS_PAGE_SIZE = 30;
let videosGeneration = 0;

const fetchVideos = async (reset = false) => {
  if (!isLoggedIn.value) return;
  if (!currentUserKey.value) return;
  if (videosLoading.value) return;
  if (!reset && !videosHasMore.value) return;
  const requestGeneration = accountGeneration;
  const requestUserKey = currentUserKey.value;
  const requestPage = reset ? 1 : videosPage.value;
  const requestVideosGeneration = videosGeneration;
  const isCurrentVideoRequest = () =>
    requestVideosGeneration === videosGeneration &&
    isCurrentAccountRequest(requestGeneration, requestUserKey);
  if (reset) {
    videosPage.value = 1;
    videosHasMore.value = true;
  }
  videosLoading.value = true;
  try {
    const res = await getUserVideoCollect(requestPage, VIDEOS_PAGE_SIZE);
    if (!isCurrentVideoRequest()) return;
    if (res && typeof res === 'object' && 'data' in res) {
      const data = (res as { data?: { info?: unknown[]; ctotal?: number } }).data;
      const info = Array.isArray(data?.info) ? data.info : [];
      const mapped: VideoItem[] = info.map((item) => {
        const record = item as Record<string, unknown>;
        const relateSong = record.relate_song as { relate_songs?: Record<string, unknown>[] };
        const firstSong = relateSong?.relate_songs?.[0];
        // 封面：优先使用 hdpic 替换 size 占位符
        let coverUrl = '';
        if (typeof record.hdpic === 'string' && record.hdpic) {
          coverUrl = record.hdpic.replace('{size}', '400');
        }
        return {
          id: record.video_id as string | number,
          hash: (record.mkv_sd_hash || record.mv_hash || '') as string,
          title: (record.video_name || '') as string,
          coverUrl,
          artist: (record.provider || firstSong?.author_name || '') as string,
          duration: (record.timelength || 0) as number,
          albumAudioId: (firstSong?.album_audio_id || '') as string | number,
        };
      });
      if (reset) {
        videos.value = mapped;
      } else {
        videos.value = [...videos.value, ...mapped];
      }
      videosHasMore.value = mapped.length >= VIDEOS_PAGE_SIZE;
      videosPage.value = requestPage + 1;
      videosLoaded.value = true;
    }
  } catch {
    if (!isCurrentVideoRequest()) return;
    toastStore.loadFailed('收藏视频');
    videosHasMore.value = false;
  } finally {
    if (!isCurrentVideoRequest()) return;
    videosLoading.value = false;
  }
};

const resetVideos = () => {
  videosGeneration += 1;
  videos.value = [];
  videosLoading.value = false;
  videosLoaded.value = false;
  videosPage.value = 1;
  videosHasMore.value = true;
  videoSearchQuery.value = '';
};

const filteredVideos = computed(() => {
  const query = videoSearchQuery.value.trim().toLowerCase();
  if (!query) return videos.value;
  return videos.value.filter((video) => (video.title || '').toLowerCase().includes(query));
});

const videoCards = computed(() => applyCardSort(filteredVideos.value, (video) => video.title));

watch(
  () => videoCollectionStore.revision,
  () => {
    // 失活时也要让旧数据失效，返回页面后由 loadActiveTabData 补拉。
    resetVideos();
    if (!isActive.value) return;
    if (activeTab.value === 'videos') void fetchVideos(true);
  },
);

// ========== 卡片 Tab 公共：定位 / 批量 ==========
type CardGridHandle = { scrollToIndex?: (index: number, behavior?: ScrollBehavior) => void };
interface CardEntry {
  id: string | number;
  name: string;
  coverUrl: string;
  subtitle: string;
}

const singerGridRef = ref<CardGridHandle | null>(null);
const userGridRef = ref<CardGridHandle | null>(null);
const albumGridRef = ref<CardGridHandle | null>(null);
const audiobookGridRef = ref<CardGridHandle | null>(null);
const videoGridRef = ref<CardGridHandle | null>(null);

const cardGridFor = (tab: CardTab): CardGridHandle | null =>
  tab === 'singers'
    ? singerGridRef.value
    : tab === 'users'
      ? userGridRef.value
      : tab === 'albums'
        ? albumGridRef.value
        : tab === 'audiobooks'
          ? audiobookGridRef.value
          : videoGridRef.value;

// 与卡片列表同序，供定位与批量共用
const cardListFor = (tab: CardTab): CardEntry[] => {
  if (tab === 'videos') {
    return videoCards.value.map((video) => ({
      id: video.id,
      name: video.title,
      coverUrl: video.coverUrl,
      subtitle: video.artist,
    }));
  }
  if (tab === 'singers' || tab === 'users') {
    const cards = tab === 'singers' ? singerCards.value : userCards.value;
    return cards.map((card) => ({
      id: card.id,
      name: card.name,
      coverUrl: card.coverUrl,
      subtitle: card.sourceDesc ?? '',
    }));
  }
  const cards = tab === 'albums' ? albumCards.value : audiobookCards.value;
  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    coverUrl: card.coverUrl,
    subtitle: card.artist,
  }));
};

const activeCardItems = computed(() => {
  const tab = activeCardTab.value;
  return tab ? cardListFor(tab) : [];
});

const flashedCardKey = ref('');
let flashCardTimer = 0;

const clearCardFlash = () => {
  if (flashCardTimer) {
    window.clearTimeout(flashCardTimer);
    flashCardTimer = 0;
  }
  flashedCardKey.value = '';
};

// 定位：滚到当前播放歌曲对应的歌手 / 专辑卡片，并短暂高亮
const locateActiveCard = () => {
  const tab = activeCardTab.value;
  if (!tab) return;
  const track = playerStore.currentTrackSnapshot as {
    name?: string;
    artist?: string;
    album?: string;
    albumName?: string;
  } | null;
  const names =
    tab === 'albums' || tab === 'audiobooks'
      ? [track?.albumName, track?.album]
      : tab === 'videos'
        ? [track?.artist, track?.name]
        : [track?.artist];
  const keywords = names
    .map((name) => (name ?? '').trim().toLowerCase())
    .filter((name) => name.length > 0);
  const list = cardListFor(tab);
  const exact =
    keywords.length > 0
      ? list.findIndex((card) => keywords.includes(card.name.trim().toLowerCase()))
      : -1;
  const index =
    exact >= 0
      ? exact
      : list.findIndex((card) =>
          keywords.some((keyword) => card.name.toLowerCase().includes(keyword)),
        );
  if (index < 0) {
    toastStore.actionFailed('定位当前播放');
    return;
  }
  cardGridFor(tab)?.scrollToIndex?.(index, 'smooth');
  clearCardFlash();
  flashedCardKey.value = String(list[index].id);
  flashCardTimer = window.setTimeout(() => {
    flashCardTimer = 0;
    flashedCardKey.value = '';
  }, 1800);
};

const batchTarget = ref<CardTab | null>(null);
const batchDrawerOpen = ref(false);

const batchItems = computed(() => {
  const tab = batchTarget.value;
  if (!tab) return [];
  return cardListFor(tab).map((card) => ({
    key: String(card.id),
    name: card.name,
    subtitle: card.subtitle,
    cover: card.coverUrl,
  }));
});

const batchLabel = computed(() => (batchTarget.value ? CARD_TAB_LABELS[batchTarget.value] : ''));
const batchActionLabel = computed(() =>
  batchTarget.value ? CARD_TAB_ACTIONS[batchTarget.value] : '',
);

const openCardBatch = (tab: CardTab) => {
  if (cardListFor(tab).length === 0) return;
  batchTarget.value = tab;
  batchDrawerOpen.value = true;
};

const isApiSuccess = (res: unknown) => {
  if (!res || typeof res !== 'object') return true;
  const status = (res as { status?: unknown }).status;
  return status === undefined || status === 1;
};

// 批量取消关注 / 取消收藏，返回失败条数
const confirmCardBatch = async (keys: string[]): Promise<number> => {
  const tab = batchTarget.value;
  if (!tab) return keys.length;
  let failed = 0;
  for (const key of keys) {
    try {
      if (tab === 'singers') {
        if (!isApiSuccess(await unfollowArtist(key))) failed += 1;
      } else if (tab === 'users') {
        if (!isApiSuccess(await deleteUserFollow({ tuid: key }))) failed += 1;
      } else if (tab === 'albums' || tab === 'audiobooks') {
        if (!(await playlistStore.unfavoriteAlbum(key))) failed += 1;
      } else {
        await videoCollectionStore.toggle(key);
      }
    } catch {
      failed += 1;
    }
  }
  if (tab === 'singers' || tab === 'users') {
    followedLoaded.value = false;
    await fetchFollowed();
  }
  return failed;
};

// ========== 滚动加载 ==========
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
      if (
        activeTab.value === 'videos' &&
        videosLoaded.value &&
        !videosLoading.value &&
        videosHasMore.value
      ) {
        void fetchVideos();
      }
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

watch(scrollContainerRef, () => {
  setupLoadMoreObserver();
});

// ========== Tab 切换懒加载 ==========
const handleTabChange = (value: string | number) => selectTabs({ tab: String(value) });

// ========== 生命周期 ==========
const refreshFavorites = async () => {
  const generation = ++refreshGeneration;
  if (!isLoggedIn.value || !currentUserKey.value) {
    routeRefreshLoading.value = false;
    return;
  }
  routeRefreshLoading.value = true;
  try {
    if (!playlistStore.likedPlaylistQueryId && !playlistStore.likedPlaylistListId) {
      await playlistStore.fetchUserPlaylists();
      return;
    }
    await playlistStore.fetchLikedPlaylistSongs();
  } finally {
    if (generation === refreshGeneration) routeRefreshLoading.value = false;
  }
};

const loadActiveTabData = () => {
  if (!isActive.value) return;
  if (!isLoggedIn.value) return;
  if (!currentUserKey.value) return;
  if ((activeTab.value === 'singers' || activeTab.value === 'users') && !followedLoaded.value) {
    void fetchFollowed();
  }
  if (activeTab.value === 'videos' && !videosLoaded.value) {
    void fetchVideos(true);
  }
  if (activeTab.value === 'albums' || activeTab.value === 'audiobooks') {
    void fetchMissingAlbumCategories();
  }
};

watch(activeTab, loadActiveTabData);

onMounted(async () => {
  void refreshFavorites();
  await nextTick();
  setupLoadMoreObserver();
  loadActiveTabData();
});

onActivated(() => {
  loadActiveTabData();
  if (!playlistStore.favoritesLoaded || playlistStore.favoritesLoading) {
    void refreshFavorites();
  }
});

onUnmounted(() => {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
});

watchUserSession(userStore, ({ isLoggedIn: loggedIn }) => {
  accountGeneration += 1;
  albumCategoriesGeneration += 1;
  albumCategories.value = {};
  if (!loggedIn) {
    resetFollowed();
    resetVideos();
    return;
  }

  resetFollowed();
  resetVideos();
  void refreshFavorites();
  loadActiveTabData();
});
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="favorites-view">
    <div class="bg-bg-main min-h-full pb-10">
      <!-- 未登录状态 -->
      <div
        v-if="!isLoggedIn"
        class="flex flex-col items-center justify-center min-h-105 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary-text flex items-center justify-center mb-5"
        >
          <Icon :icon="iconHeart" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">登录后查看我最喜爱</div>
      </div>

      <!-- 已登录 -->
      <template v-else>
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="FAVORITES"
          title="我最喜爱"
          :coverUrl="favoriteCoverUrl"
          :hasDetails="true"
          distribute-details
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="contents">
              <div class="text-[13px] font-semibold text-text-secondary">
                集中管理收藏的歌曲、歌手、用户、专辑、有声书与视频。
              </div>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary"
              >
                <div class="inline-flex items-center gap-1.5">
                  <Icon :icon="iconHeart" width="12" height="12" />
                  <span>{{ songs.length }} 首歌曲</span>
                </div>
                <span v-if="followedSingers.length > 0">{{ followedSingers.length }} 位歌手</span>
                <span v-if="musicAlbums.length > 0">{{ musicAlbums.length }} 张专辑</span>
                <span v-if="audiobookAlbums.length > 0">
                  {{ audiobookAlbums.length }} 张有声/长专
                </span>
                <span v-if="videos.length > 0">{{ videos.length }} 个视频</span>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow
              v-if="activeTab === 'songs'"
              :play-disabled="songs.length === 0"
              :batch-disabled="songs.length === 0"
              @play="handlePlayAll"
              @batch="openBatchDrawer"
            />
            <Button
              v-else-if="activeCardTab"
              variant="soft-secondary"
              size="default"
              :disabled="activeCardItems.length === 0"
              @click="openCardBatch(activeCardTab)"
            >
              <Icon :icon="iconList" width="16" height="16" />
              <span>批量</span>
            </Button>
          </template>

          <template #collapsed-actions>
            <template v-if="activeTab === 'songs'">
              <Button
                variant="unstyled"
                size="icon"
                :disabled="songs.length === 0"
                @click="handlePlayAll"
                class="action-icon hover:bg-[var(--control-hover-bg)] text-primary-text"
              >
                <Icon :icon="iconPlay" width="20" height="20" />
              </Button>
              <Button
                variant="unstyled"
                size="icon"
                :disabled="songs.length === 0"
                @click="openBatchDrawer"
                class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
              >
                <Icon :icon="iconList" width="18" height="18" />
              </Button>
            </template>
            <Button
              v-else-if="activeCardTab"
              variant="unstyled"
              size="icon"
              :disabled="activeCardItems.length === 0"
              @click="openCardBatch(activeCardTab)"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconList" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <Tabs
          :model-value="activeTab"
          class="w-full"
          :style="{ minHeight: tabsMinHeight }"
          @update:model-value="handleTabChange"
        >
          <!-- Sticky Tabs -->
          <PageStickyHeader
            class="song-list-sticky sticky z-110 bg-bg-main"
            :style="{ top: `${tabsTop}px` }"
          >
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList
                    class="favorites-tab-list bg-transparent border-none gap-8"
                    @pointerdown="onTabPointerDown"
                    @dblclick="onTabDoubleClick"
                  >
                    <TabsTrigger value="songs">
                      <span class="badge-label">歌曲 <Badge :count="songs.length" /></span>
                    </TabsTrigger>
                    <TabsTrigger value="singers">
                      <span class="badge-label"
                        >歌手
                        <Badge v-if="followedSingers.length > 0" :count="followedSingers.length"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="users">
                      <span class="badge-label"
                        >用户 <Badge v-if="followedUsers.length > 0" :count="followedUsers.length"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="albums">
                      <span class="badge-label"
                        >专辑 <Badge v-if="musicAlbums.length > 0" :count="musicAlbums.length"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="audiobooks">
                      <span class="badge-label"
                        >有声/长专
                        <Badge v-if="audiobookAlbums.length > 0" :count="audiobookAlbums.length"
                      /></span>
                    </TabsTrigger>
                    <TabsTrigger value="videos">
                      <span class="badge-label"
                        >视频 <Badge v-if="videos.length > 0" :count="videos.length"
                      /></span>
                    </TabsTrigger>
                  </TabsList>

                  <!-- 歌曲 tab 右侧操作 -->
                  <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                    <Button
                      class="action-icon song-sort-btn"
                      v-if="playlistOrderTarget"
                      variant="soft-secondary"
                      size="icon"
                      tooltip="调整歌曲顺序"
                      :disabled="songs.length === 0"
                      @click="showPlaylistOrder = true"
                    >
                      <Icon :icon="iconArrowsSort" width="16" />
                    </Button>
                    <SongSearchInput v-model="searchQuery" :disabled="songs.length === 0" />
                    <Button
                      variant="unstyled"
                      size="icon"
                      @click="handleLocate"
                      class="action-icon song-locate-btn"
                      tooltip="定位当前播放"
                      :disabled="songs.length === 0"
                    >
                      <Icon :icon="iconCurrentLocation" width="18" height="18" />
                    </Button>
                  </div>

                  <!-- 卡片 tab 右侧操作：排序 / 搜索 / 定位 -->
                  <div v-if="activeCardTab" class="flex items-center gap-2">
                    <Button
                      class="action-icon card-sort-btn"
                      variant="soft-secondary"
                      size="icon"
                      tooltip="排序"
                      :disabled="activeCardItems.length === 0"
                      @click="openSortMenu"
                    >
                      <Icon :icon="iconArrowsSort" width="16" />
                    </Button>
                    <SongSearchInput
                      v-if="activeTab === 'singers'"
                      v-model="singerSearchQuery"
                      placeholder="搜索歌手..."
                      :disabled="activeCardItems.length === 0"
                    />
                    <SongSearchInput
                      v-else-if="activeTab === 'albums'"
                      v-model="albumSearchQuery"
                      placeholder="搜索专辑..."
                      :disabled="activeCardItems.length === 0"
                    />
                    <SongSearchInput
                      v-else-if="activeTab === 'audiobooks'"
                      v-model="audiobookSearchQuery"
                      placeholder="搜索有声/长专..."
                      :disabled="activeCardItems.length === 0"
                    />
                    <SongSearchInput
                      v-else-if="activeTab === 'users'"
                      v-model="userSearchQuery"
                      placeholder="搜索用户..."
                      :disabled="activeCardItems.length === 0"
                    />
                    <SongSearchInput
                      v-else-if="activeTab === 'videos'"
                      v-model="videoSearchQuery"
                      placeholder="搜索视频..."
                      :disabled="activeCardItems.length === 0"
                    />
                    <Button
                      variant="unstyled"
                      size="icon"
                      @click="locateActiveCard"
                      class="action-icon card-locate-btn"
                      tooltip="定位当前播放"
                      :disabled="activeCardItems.length === 0"
                    >
                      <Icon :icon="iconCurrentLocation" width="18" height="18" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 歌曲 tab 的排序表头 -->
            <SongListHeader
              v-if="activeTab === 'songs'"
              :sortField="sortField"
              :sortOrder="sortOrder"
              :showCover="true"
              paddingClass="px-6"
              @sort="handleSort"
            />
          </PageStickyHeader>

          <BatchActionDrawer
            v-model:open="showBatchDrawer"
            :songs="songs"
            source-id="favorites"
            remove-context="favorites"
            :on-batch-remove="handleBatchUnfavorite"
          />

          <div class="pb-12">
            <!-- 歌曲 -->
            <TabsContent value="songs" class="px-6">
              <SongList
                ref="songListRef"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :loading="songListLoading"
                :active="activeTab === 'songs'"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: 'queue:favorites',
                  title: '我最喜爱',
                  subtitle: '',
                  type: 'playlist',
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
                "
                rowPaddingClass="px-0"
              />
            </TabsContent>

            <!-- 歌手 -->
            <TabsContent value="singers" class="px-6 pt-4">
              <VirtualGrid
                ref="singerGridRef"
                :items="singerCards"
                :loading="followedLoading"
                :active="activeTab === 'singers'"
                :itemMinWidth="180"
                :itemAspectRatio="1"
                :itemChromeHeight="68"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                :stateMinHeight="320"
                emptyText="暂无关注歌手"
                keyField="id"
              >
                <template #default="{ item }">
                  <div
                    class="favorites-card"
                    :class="{ 'is-flash': flashedCardKey === String(item.id) }"
                  >
                    <ArtistCard v-bind="item" />
                  </div>
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 用户 -->
            <TabsContent value="users" class="px-6 pt-4">
              <VirtualGrid
                ref="userGridRef"
                :items="userCards"
                :loading="followedLoading"
                :active="activeTab === 'users'"
                :itemMinWidth="180"
                :itemAspectRatio="1"
                :itemChromeHeight="68"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                :stateMinHeight="320"
                emptyText="暂无关注用户"
                keyField="id"
              >
                <template #default="{ item }">
                  <div
                    class="favorites-card"
                    :class="{ 'is-flash': flashedCardKey === String(item.id) }"
                  >
                    <ArtistCard v-bind="item" />
                  </div>
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 专辑 -->
            <TabsContent value="albums" class="px-6 pt-4">
              <VirtualGrid
                ref="albumGridRef"
                :items="albumCards"
                :loading="false"
                :active="activeTab === 'albums'"
                :itemMinWidth="180"
                :itemAspectRatio="1"
                :itemChromeHeight="66"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                :stateMinHeight="320"
                emptyText="暂无收藏专辑"
                keyField="id"
              >
                <template #default="{ item }">
                  <div
                    class="favorites-card"
                    :class="{ 'is-flash': flashedCardKey === String(item.id) }"
                  >
                    <AlbumCard v-bind="item" />
                  </div>
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 有声/长专 -->
            <TabsContent value="audiobooks" class="px-6 pt-4">
              <VirtualGrid
                ref="audiobookGridRef"
                :items="audiobookCards"
                :loading="albumCategoriesLoading && audiobookCards.length === 0"
                :active="activeTab === 'audiobooks'"
                :itemMinWidth="180"
                :itemAspectRatio="1"
                :itemChromeHeight="66"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                :stateMinHeight="320"
                emptyText="暂无收藏有声/长专"
                keyField="id"
              >
                <template #default="{ item }">
                  <div
                    class="favorites-card"
                    :class="{ 'is-flash': flashedCardKey === String(item.id) }"
                  >
                    <AlbumCard v-bind="item" />
                  </div>
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 视频 -->
            <TabsContent value="videos" class="px-6 pt-4">
              <VirtualGrid
                ref="videoGridRef"
                :items="videoCards"
                :loading="videosLoading && !videosLoaded"
                :active="activeTab === 'videos'"
                :itemMinWidth="240"
                :itemAspectRatio="16 / 9"
                :itemChromeHeight="66"
                :gap="20"
                :overscan="3"
                :paddingBottom="20"
                :stateMinHeight="320"
                emptyText="暂无收藏视频"
                keyField="id"
              >
                <template #default="{ item }">
                  <div
                    class="favorites-card"
                    :class="{ 'is-flash': flashedCardKey === String(item.id) }"
                  >
                    <MvCard
                      :videoId="item.id"
                      :hash="item.hash"
                      :title="item.title"
                      :coverUrl="item.coverUrl"
                      :artist="item.artist"
                      :duration="item.duration"
                      :albumAudioId="item.albumAudioId"
                    />
                  </div>
                </template>
              </VirtualGrid>
              <div
                ref="loadMoreSentinelRef"
                v-if="videosHasMore && videosLoaded"
                class="flex justify-center py-6 text-[12px] text-text-secondary"
              >
                {{ videosLoading ? '加载更多中...' : '继续下滑加载更多' }}
              </div>
              <div
                v-else-if="videosLoaded && !videosHasMore && videos.length > 0"
                class="flex justify-center py-6 text-[12px] text-text-secondary"
              >
                没有更多了
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </template>
    </div>
  </PageScrollContainer>
  <PlaylistOrderDialog
    v-if="showPlaylistOrder && playlistOrderTarget"
    v-model:open="showPlaylistOrder"
    :target="playlistOrderTarget"
    @saved="handlePlaylistOrderSaved"
  />
  <ContextMenuPanel
    :open="sortMenuOpen"
    :x="sortMenuPoint.x"
    :y="sortMenuPoint.y"
    :scroll-lock-el="scrollContainerRef"
    @close="sortMenuOpen = false"
  >
    <button
      v-for="option in cardSortOptions"
      :key="`${option.field}-${option.order}`"
      type="button"
      class="song-context-item"
      @click="applyCardSortOption(option)"
    >
      {{ isCardSortOptionActive(option) ? '✓ ' : '' }}{{ option.label }}
    </button>
  </ContextMenuPanel>
  <CardBatchDrawer
    v-model:open="batchDrawerOpen"
    :items="batchItems"
    :label="batchLabel"
    :action-label="batchActionLabel"
    :on-confirm="confirmCardBatch"
  />
</template>

<style scoped>
@reference "@/style.css";

.favorites-tab-list :deep(.tab-trigger) {
  font-size: 14px;
  font-weight: 600;
}

/* 定位当前播放：命中卡片短暂高亮，时长与歌曲行一致 */
.favorites-card {
  border-radius: 12px;
}

.favorites-card.is-flash {
  animation: favorites-card-flash 1.8s ease-out;
}

@keyframes favorites-card-flash {
  0%,
  55% {
    box-shadow:
      0 0 0 2px var(--color-primary),
      0 0 18px 0 color-mix(in srgb, var(--color-primary) 45%, transparent);
  }
  100% {
    box-shadow:
      0 0 0 2px transparent,
      0 0 0 0 transparent;
  }
}
</style>
