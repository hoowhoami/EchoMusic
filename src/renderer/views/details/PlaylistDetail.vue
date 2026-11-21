<script setup lang="ts">
import Tag from '@/components/ui/Tag.vue';
import { useRouteTabs } from '@/composables/useRouteTabs';
import { useTabDoubleClickTop, type PageScrollHandle } from '@/composables/useTabDoubleClickTop';
import { parsePlaylistTags } from '@/utils/playlistTags';
import { createLocateFeedback } from '@/utils/locateFeedback';
import { hideElementTooltip, showElementTooltip } from '@/components/ui/tooltip';
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
defineOptions({ name: 'playlist-detail' });
import {
  ref,
  shallowRef,
  nextTick,
  onMounted,
  onActivated,
  onBeforeUnmount,
  computed,
  watch,
} from 'vue';
import { useRoute } from 'vue-router';
import { useRouteId } from '@/composables/useRouteId';
import {
  dismissResumeHint,
  resumeHintRequest,
  showPageResumeHint,
  takeResumeHintRequest,
} from '@/utils/resumeHint';
import { getPlaylistDetail, getPlaylistTracks, getPlaylistTracksNew } from '@/api/playlist';
import { resolveOwnedPlaylistListId } from '@/utils/playlistTrackSource';
import { orderByPlaylistPosition } from '@/utils/playlistOrder';
import { usePlaylistCoversStore } from '@/stores/playlistCovers';
import { useDetailComments } from '@/composables/useDetailComments';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import DetailPageSkeleton from '@/components/music/DetailPageSkeleton.vue';
import DetailPageError from '@/components/music/DetailPageError.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import Avatar from '@/components/ui/Avatar.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import CommentComposer from '@/components/music/CommentComposer.vue';
import CommentList from '@/components/music/CommentList.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import PlaylistOrderDialog from '@/components/music/PlaylistOrderDialog.vue';
import PlaylistEditDialog from '@/components/music/PlaylistEditDialog.vue';
import { canEditPlaylist } from '@/services/playlistEditing';
import { completeSongMetadata } from '@/services/songMetadata';
import type { PlaylistOrderTarget } from '@/services/playlistOrdering';
import type { Song } from '@/models/song';
import { formatDate } from '@/utils/format';
import { useUserStore } from '@/stores/user';
import Button from '@/components/ui/Button.vue';
import { mapPlaylistMeta, resolvePlaylistTrackQueryId } from '@/utils/mappers';
import { parsePlaylistTracks } from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { usePlaylistStore, matchesFavoriteEntry } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import {
  resumeRecordForScope,
  resumeRecordOfTrack,
  resumeTrackRecords,
} from '@/stores/player/resume';
import { useSettingStore } from '@/stores/setting';
import {
  iconCurrentLocation,
  iconPlay,
  iconList,
  iconArrowsSort,
  iconPencil,
  iconMusic,
  iconHeart,
  iconHeartFilled,
  iconInfo,
  iconShare,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { copyShareTarget, createPlaylistShareTarget } from '@/utils/share';
import { useToastStore } from '@/stores/toast';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import { captureUserSession, userSessionSources } from '@/utils/userSession';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import { isSameSong } from '@/utils/song';
import logger from '@/utils/logger';

const route = useRoute();
const { id: currentId, onIdChange } = useRouteId();
// const router = useRouter();
const getPlaylistId = () => currentId.value;

const loading = ref(true);
// 首屏到手时 loading 就已经是 false 了，剩下的页还在后台拉；
// 只有全部加载完成，才能说「列表里确实没有这一首」。
const songsAllLoaded = ref(false);
const playlist = ref<PlaylistMeta | null>(null);

// 使用 shallowRef 极大减少响应式开销
const songs = shallowRef<Song[]>([]);
const loadedSongCount = ref(0);

const playlistFilteredInvalidCount = ref(0);
const {
  state: { tab: activeTab },
  select: selectTabs,
  isActive,
} = useRouteTabs({ tab: ['songs', 'comments'] });

const showIntroDialog = ref(false);
const showBatchDrawer = ref(false);
const showPlaylistOrder = ref(false);
const showPlaylistEdit = ref(false);

// 搜索和定位逻辑
const searchQuery = ref('');
const songListRef = ref<{
  scrollToActive?: () => void;
  scrollToSong?: (songId: string) => Promise<boolean> | void;
  flashSong?: (songId: string) => void;
} | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);
const userStore = useUserStore();
const playlistStore = usePlaylistStore();
const playlistCoversStore = usePlaylistCoversStore();
void playlistCoversStore.hydrate();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();

const isOwnerPlaylist = computed(() => {
  const meta = playlist.value;
  const currentUserId = userStore.info?.userid;
  return !!meta && !!currentUserId && meta.listCreateUserid === currentUserId && meta.source !== 2;
});

const ownedPlaylistListId = computed(() =>
  resolveOwnedPlaylistListId(getPlaylistId(), {
    ...playlist.value,
    listid: playlistStore.findPlaylistByIdentity(getPlaylistId())?.listid,
    currentUserId: userStore.info?.userid,
  }),
);

const orderPlaylistSongs = (items: readonly Song[]) =>
  ownedPlaylistListId.value !== null
    ? orderByPlaylistPosition(items, (song) => song.playlistSort)
    : Array.from(items);

const coverPlaylistMeta = computed(() => {
  const detail = playlist.value;
  if (!detail) return null;
  const entry = playlistStore.findPlaylistByIdentity(getPlaylistId());
  return {
    ...detail,
    listid: entry?.listid ?? ownedPlaylistListId.value ?? detail.listid,
    type: entry?.type ?? detail.type,
    hasCustomCover:
      entry?.type === 1
        ? entry.hasCustomCover
        : detail.hasCustomCover === true || entry?.hasCustomCover === true,
    pic: entry?.hasCustomCover ? entry.pic : detail.pic,
  };
});
const playlistCoverUrl = computed(() =>
  coverPlaylistMeta.value
    ? playlistCoversStore.coverFor(coverPlaylistMeta.value, userStore.info?.userid)
    : '',
);

const editablePlaylist = computed(() => {
  if (!userStore.isLoggedIn) return null;
  const entry =
    playlistStore.findPlaylistByIdentity(getPlaylistId()) ??
    playlistStore.userPlaylists.find(
      (item) => !!item.listCreateGid && item.listCreateGid === playlist.value?.listCreateGid,
    );
  return entry && canEditPlaylist(entry) && !playlist.value?.isDefault ? entry : null;
});
const handlePlaylistEdited = (updated: PlaylistMeta) => {
  if (!playlist.value) return;
  playlist.value = {
    ...playlist.value,
    name: updated.name,
    tags: updated.tags,
    intro: updated.intro,
    pic: updated.pic,
    hasCustomCover: updated.hasCustomCover,
  };
};

const playlistOrderTarget = computed<PlaylistOrderTarget | null>(() => {
  if (!isOwnerPlaylist.value || !userStore.isLoggedIn) return null;
  // 只能使用当前账号的 listid，不能把公开歌单 ID 或原作者 listid 传给写接口。
  const entry =
    playlistStore.findPlaylistByIdentity(getPlaylistId()) ??
    playlistStore.userPlaylists.find(
      (item) => !!item.listCreateGid && item.listCreateGid === playlist.value?.listCreateGid,
    );
  if (!entry || entry.listCreateUserid !== userStore.info?.userid || entry.source === 2)
    return null;
  const listid = Number(entry.listid ?? entry.id);
  return Number.isSafeInteger(listid) && listid > 0
    ? {
        kind: 'tracks',
        listid,
        queryId: resolvePlaylistTrackQueryId(getPlaylistId(), {
          listid: entry.listid,
          listCreateGid: entry.listCreateGid || entry.globalCollectionId,
        }),
        title: playlist.value?.name ?? '',
      }
    : null;
});
const handlePlaylistOrderSaved = () => {
  sortField.value = null;
  sortOrder.value = null;
  searchQuery.value = '';
};

const currentPlaylistIds = computed(() => {
  const meta = playlist.value;
  if (!meta) return [] as string[];
  return [meta.id, meta.listid, meta.listCreateListid, meta.globalCollectionId, meta.listCreateGid]
    .filter((item): item is string | number => item !== undefined && item !== null && item !== '')
    .map((item) => String(item));
});

const currentPlaylistContentIds = computed(() =>
  Array.from(new Set([getPlaylistId(), ...currentPlaylistIds.value].filter(Boolean))),
);

const isFavoritePlaylist = computed(() => {
  const meta = playlist.value;
  if (!meta) return false;
  const currentUserId = userStore.info?.userid;
  return playlistStore.userPlaylists.some((entry) => {
    if (entry.source === 2) return false;
    if (currentUserId && entry.listCreateUserid === currentUserId) return false;
    // 仅比较全局唯一身份（gid，缺失时回退原创建者组合键，见 matchesFavoriteEntry），
    // 不再用 listid/listCreateListid 这类按账号分配的小整数匹配——
    // 跨歌单撞号会造成「任意歌单都显示已收藏」并误删其他收藏。
    return matchesFavoriteEntry(entry, meta);
  });
});

// 收藏/取消收藏共用入口：失败时明确提示，避免「点了没反应」被误读为已生效。
// 账号切换会让进行中的操作返回失败，这不是操作本身失败，不弹提示。
const togglePlaylistFavorite = async () => {
  const meta = playlist.value;
  if (!meta || !userStore.isLoggedIn) return;
  const isFavorite = isFavoritePlaylist.value;
  const sessionUserId = userStore.info?.userid;
  const succeeded = isFavorite
    ? await playlistStore.unfavoritePlaylist(meta, sessionUserId)
    : await playlistStore.favoritePlaylist(meta, sessionUserId);
  const sessionStillCurrent = userStore.isLoggedIn && userStore.info?.userid === sessionUserId;
  if (!succeeded && sessionStillCurrent)
    toastStore.actionFailed(isFavorite ? '取消收藏' : '收藏歌单');
};

const songTotalCount = computed(() => {
  const metaCount = playlist.value?.count ?? 0;
  return metaCount > 0 ? metaCount : loadedSongCount.value;
});

const playlistTags = computed(() => parsePlaylistTags(playlist.value?.tags));

const playlistCommentId = computed(() => {
  const meta = playlist.value;
  if (!meta) return getPlaylistId();
  if (meta.globalCollectionId) return meta.globalCollectionId;
  if (meta.listCreateGid) return meta.listCreateGid;
  if (meta.listCreateUserid && meta.listCreateListid) {
    return `collection_3_${meta.listCreateUserid}_${meta.listCreateListid}_0`;
  }
  return getPlaylistId();
});

const { loadingComments, comments, hotComments, commentTotal, hasMoreComments, fetchComments } =
  useDetailComments({
    type: 'playlist',
    resourceId: () => playlistCommentId.value,
    isActive: () => isActive.value && activeTab.value === 'comments',
  });

// 排序逻辑
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    // 切换排序顺序: asc -> desc -> null
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

const handleTabChange = (value: string | number) => selectTabs({ tab: String(value) });
const loadActiveTabData = () => {
  if (!isActive.value || !playlist.value) return;
  if (activeTab.value === 'comments' && comments.value.length === 0) void fetchComments(true);
};
watch([activeTab, playlist], loadActiveTabData);

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

// 歌曲分页加载器
let songLoader: PagedSongLoader<Song> | null = null;
let songLoadGeneration = 0;
let disposed = false;
let pendingAddedPlaylistSongs: Song[] = [];
let pendingRemovedPlaylistSongs: Song[] = [];

const isCurrentPlaylistSongCacheComplete = (items: readonly Song[] = songs.value) => {
  const total = playlist.value?.count ?? 0;
  if (total <= 0) return false;
  return items.length + playlistFilteredInvalidCount.value >= total;
};

const hasMatchingSong = (items: readonly Song[], song: Song) =>
  items.some((item) => String(item.id) === String(song.id) || isSameSong(item, song));

const withoutMatchingSongs = (items: readonly Song[], targets: readonly Song[]) =>
  items.filter(
    (item) =>
      !targets.some((song) => String(song.id) === String(item.id) || isSameSong(song, item)),
  );

const mergePlaylistLocalChanges = (items: readonly Song[]) => {
  const withoutRemoved = withoutMatchingSongs(items, pendingRemovedPlaylistSongs);
  const additions = pendingAddedPlaylistSongs.filter(
    (song) => !hasMatchingSong(withoutRemoved, song),
  );
  return [...additions, ...withoutRemoved];
};

const updateSongsFromLoader = (items: readonly Song[], complete = false) => {
  const mergedSongs = mergePlaylistLocalChanges(orderPlaylistSongs(items));
  songs.value = mergedSongs;
  loadedSongCount.value = mergedSongs.length;
  playlistStore.rememberPlaylistSongs(
    playlist.value?.listid ?? playlist.value?.id ?? getPlaylistId(),
    mergedSongs,
    complete && isCurrentPlaylistSongCacheComplete(mergedSongs),
  );
};

const completePlaylistSongPage = (items: readonly Song[], isCurrent: () => boolean) => {
  return completeSongMetadata(items, isCurrent)
    .then((completed) => {
      if (!isCurrent()) return false;
      const changed = new Set<Song>();
      let coverChanged = false;
      const fields = [
        'coverUrl',
        'cover',
        'albumId',
        'albumName',
        'album',
        'artists',
        'singers',
        'artist',
      ] as const;
      completed.forEach((song, index) => {
        const original = items[index];
        if (song === original) return;
        // 加载器、列表和歌单缓存共享对象，仅补展示字段，保留当前音源、权限及排序身份。
        for (const field of fields) {
          if (song[field] === original[field]) continue;
          Object.assign(original, { [field]: song[field] });
          if (field === 'coverUrl' || field === 'cover') coverChanged = true;
          changed.add(original);
        }
      });
      // 不使用旧分页快照替换列表，避免把补查期间删除的歌曲加回来。
      if (changed.size && songs.value.some((song) => changed.has(song))) {
        // shallowRef 的数组通知不会使 SongCard 的同引用 song prop 失效。
        // 只替换补全过的行，令卡片重算封面/歌手，同时复用其他行。
        songs.value = songs.value.map((song) => (changed.has(song) ? { ...song } : song));
      }
      return coverChanged;
    })
    .catch(() => {
      if (isCurrent()) logger.warn('PlaylistDetail', 'Background song metadata completion failed');
      return false;
    });
};

const fetchData = async () => {
  if (disposed) return;
  const playlistId = getPlaylistId();
  const isCurrentSession = captureUserSession(userStore);
  const generation = ++songLoadGeneration;
  const accountGeneration = playlistStore.userCollectionsGeneration;
  const accountId = userStore.info?.userid;
  const hadCompleteSongs = songs.value.length > 0 && isCurrentPlaylistSongCacheComplete();
  const isCurrent = () =>
    !disposed &&
    playlistId === getPlaylistId() &&
    isCurrentSession() &&
    generation === songLoadGeneration &&
    accountGeneration === playlistStore.userCollectionsGeneration &&
    accountId === userStore.info?.userid;
  songLoader?.abort();
  loading.value = songs.value.length === 0;
  songsAllLoaded.value = hadCompleteSongs;
  try {
    pendingAddedPlaylistSongs = [];
    pendingRemovedPlaylistSongs = [];
    const detailRes = await getPlaylistDetail(playlistId);
    if (!isCurrent()) return;
    if (detailRes?.status !== 1 || !detailRes.data?.[0]) return;
    const meta = mapPlaylistMeta(detailRes.data[0]);
    if (!meta.id && !meta.name && !meta.globalCollectionId && !meta.listCreateGid) return;
    playlist.value = meta;
    // 进详情页就登记名字与封面：真正播放时用它建「歌单」桶
    playerStore.registerResumeScope('playlist', String(meta.id ?? getPlaylistId()), {
      name: meta.name,
      cover: meta.pic,
      // 桶 id 是歌单自己的数字 id，路由用的是 collection 串：另存一份，历史页收藏/跳转都要它
      routeId: getPlaylistId(),
      routeType: String(route.query.type ?? ''),
    });

    const playlistMeta = playlist.value;
    const currentUserId = userStore.info?.userid;
    const ownedListId = ownedPlaylistListId.value;
    const queryId = resolvePlaylistTrackQueryId(playlistId, {
      listid: playlistMeta?.listid,
      listCreateGid: playlistMeta?.listCreateGid,
      listCreateUserid: playlistMeta?.listCreateUserid,
      currentUserId,
    });

    // 中止上一次加载
    if (songLoader) {
      songLoader.abort();
    }

    const filteredCounts = new Map<number, number>();
    const coverPages = new Map<number, unknown>();
    const metadataUpdates: Promise<boolean | undefined>[] = [];
    const coverVersion = playlistStore.playlistContentVersions[String(ownedListId)] ?? 0;
    const isCurrentCover = () =>
      isCurrent() &&
      coverVersion === (playlistStore.playlistContentVersions[String(ownedListId)] ?? 0);
    const updateFilteredCount = () => {
      playlistFilteredInvalidCount.value = Array.from(filteredCounts)
        .filter(([page]) => page <= loader.loadedPages)
        .reduce((total, [, count]) => total + count, 0);
    };

    const loader = new PagedSongLoader<Song>(
      async (page, pageSize) => {
        if (!isCurrent()) throw new Error('歌单加载已失效');
        const res =
          ownedListId !== null
            ? await getPlaylistTracksNew(ownedListId, page, pageSize)
            : await getPlaylistTracks(queryId, page, pageSize);
        if (!isCurrent()) throw new Error('歌单加载已失效');
        const payload =
          res && typeof res === 'object'
            ? 'data' in res
              ? res.data
              : 'info' in res
                ? res.info
                : res
            : res;
        const { songs: parsedSongs, filteredCount } = parsePlaylistTracks(payload ?? res);
        filteredCounts.set(page, filteredCount);
        if (ownedListId !== null) coverPages.set(page, res);
        // 返回数量不足一页说明没有更多了
        const hasMore = parsedSongs.length + filteredCount >= pageSize;
        return { items: parsedSongs, hasMore };
      },
      {
        pageSize: ownedListId !== null ? 300 : 200,
        concurrency: 3,
        dedupeKey: (song) => String(song.id),
        logTag: 'PlaylistDetailLoader',
        onPageLoaded(allItems, newItems) {
          if (!isCurrent()) return;
          if (!hadCompleteSongs) {
            updateFilteredCount();
            updateSongsFromLoader(allItems);
          }
          loading.value = false;
          // 只补已接受的新页，排除重复歌曲及超过末页的预取结果；补全不阻塞分页。
          metadataUpdates.push(completePlaylistSongPage(newItems, isCurrent));
        },
        onComplete(allItems) {
          if (!isCurrent()) return;
          updateFilteredCount();
          updateSongsFromLoader(allItems, true);
          songsAllLoaded.value = true;
          if (ownedListId !== null && coverPlaylistMeta.value) {
            const coverMeta = coverPlaylistMeta.value;
            const pages = Array.from(coverPages)
              .filter(([page]) => page <= loader.loadedPages)
              .sort(([a], [b]) => a - b)
              .map(([, response]) => response);
            void playlistCoversStore.updateFromPages(coverMeta, accountId, pages, isCurrentCover);
            // 全部后台补全结束后只重算一次自动封面，不阻塞列表或重新请求歌曲。
            void Promise.all(metadataUpdates)
              .then((changed) => {
                if (changed.some(Boolean) && isCurrentCover())
                  return playlistCoversStore.updateFromPages(
                    coverMeta,
                    accountId,
                    pages,
                    isCurrentCover,
                    allItems,
                  );
              })
              .catch(() => logger.warn('PlaylistDetail', 'Completed playlist cover update failed'));
          }
          coverPages.clear();
        },
        onError() {
          coverPages.clear();
          if (isCurrent()) toastStore.loadFailed('歌单歌曲');
        },
      },
    );

    songLoader = loader;
    // 统一逐页展示；自建歌单仅在更新列表时额外按 sort 排序。
    await loader.loadAll();
  } catch (e) {
    console.error('Fetch playlist error:', e);
    if (isCurrent() && playlist.value) toastStore.loadFailed('歌单详情');
  } finally {
    if (isCurrent()) loading.value = false;
  }
};

onMounted(() => {
  void fetchData();
  setupCommentObserver();
});

onActivated(() => {
  // 失败后的空页面也会被缓存；返回时重新加载，已有内容和进行中的请求继续复用。
  if (!playlist.value && !loading.value) void fetchData();
  if (disposed) return;
  const fromRequest = consumeLocateRequest();
  // 每次回到这一页，只要有上次听到的记录就在靶心弹一次；带着续播请求进来会直接定位，不弹
  locateHintShownOnce = false;
  if (!fromRequest && bucketTarget.value) {
    void nextTick(() => {
      if (locateHintShownOnce) return;
      locateHintShownOnce = true;
      showLocateHint();
    });
  }
});

// id 变化时重置数据（仅同路由间切换，如歌单A→歌单B）
onIdChange(() => {
  playlist.value = null;
  songs.value = [];
  songsAllLoaded.value = false;
  loadedSongCount.value = 0;
  playlistFilteredInvalidCount.value = 0;
  if (songLoader) {
    songLoader.abort();
    songLoader = null;
  }
  fetchData();
  if (activeTab.value === 'comments') {
    fetchComments(true);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  songLoadGeneration++;
  songLoader?.abort();
  commentObserver?.disconnect();
  commentObserver = null;
});

const playlistSessionSources = [
  () => playlistStore.userCollectionsGeneration,
  ...userSessionSources(userStore),
];
watch(
  playlistSessionSources,
  () => {
    songLoadGeneration++;
    songLoader?.abort();
    songLoader = null;
    playlist.value = null;
    songs.value = [];
    loadedSongCount.value = 0;
    playlistFilteredInvalidCount.value = 0;
    pendingAddedPlaylistSongs = [];
    pendingRemovedPlaylistSongs = [];
    loading.value = false;
  },
  { flush: 'sync' },
);
watch(playlistSessionSources, () => {
  if (isActive.value) void fetchData();
});

watch(
  () => playlistCommentId.value,
  (nextId, prevId) => {
    if (nextId !== prevId && activeTab.value === 'comments') {
      fetchComments(true);
    }
  },
);

const handleSharePlaylist = async () => {
  const meta = playlist.value;
  if (!meta) return;
  const target = createPlaylistShareTarget(meta, getPlaylistId());
  if (!target) return;
  try {
    await copyShareTarget(target);
    toastStore.actionCompleted('分享链接已复制');
  } catch {
    toastStore.actionFailed('复制分享链接');
  }
};

const secondaryActions = computed(() => {
  const actions = [] as {
    icon: typeof iconHeart;
    label: string;
    emphasized?: boolean;
    tone?: 'default' | 'favorite';
    onTap: () => void | Promise<void>;
  }[];

  if (!isOwnerPlaylist.value && userStore.isLoggedIn) {
    actions.push({
      icon: iconHeart,
      label: isFavoritePlaylist.value ? '已收藏' : '收藏',
      emphasized: isFavoritePlaylist.value,
      tone: 'favorite',
      onTap: togglePlaylistFavorite,
    });
  }

  if (playlist.value) {
    if (editablePlaylist.value) {
      actions.push({
        icon: iconPencil,
        label: '编辑歌单',
        onTap: () => {
          showPlaylistEdit.value = true;
        },
      });
    }
    actions.push({
      icon: iconShare,
      label: '分享',
      onTap: handleSharePlaylist,
    });
  }

  return actions;
});

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    playlistFilteredInvalidCount.value,
    song,
    {
      queueId: `queue:playlist:${playlist.value?.id ?? getPlaylistId()}`,
      title: playlist.value?.name || '歌单',
      subtitle: playlist.value?.nickname || playlist.value?.list_create_username || '',
      type: 'playlist',
      resumeScope: { kind: 'playlist', id: String(playlist.value?.id ?? getPlaylistId()) } as const,
    },
  );
};

const handleRemovedFromPlaylist = (song: Song) => {
  const beforeCount = songs.value.length;
  songs.value = songs.value.filter((s) => String(s.id) !== String(song.id));
  const removedCount = beforeCount - songs.value.length;
  loadedSongCount.value = songs.value.length;
  playlistStore.forgetPlaylistSongs(
    playlist.value?.listid ?? playlist.value?.id ?? getPlaylistId(),
    [song],
  );
  if (playlist.value && typeof playlist.value.count === 'number' && removedCount > 0) {
    playlist.value = {
      ...playlist.value,
      count: Math.max(0, playlist.value.count - removedCount),
    };
  }
};

const appliedPlaylistChangeIds = new Set<number>();

const applyAddedPlaylistSongs = (incomingSongs: readonly Song[]) => {
  const additions = incomingSongs.filter((song) => !hasMatchingSong(songs.value, song));
  pendingRemovedPlaylistSongs = withoutMatchingSongs(pendingRemovedPlaylistSongs, incomingSongs);
  incomingSongs.forEach((song) => {
    if (!hasMatchingSong(pendingAddedPlaylistSongs, song)) {
      pendingAddedPlaylistSongs.push(song);
    }
  });
  if (additions.length === 0) {
    songs.value = mergePlaylistLocalChanges(songs.value);
    return;
  }
  songs.value = mergePlaylistLocalChanges(songs.value);
  loadedSongCount.value = songs.value.length;
  playlistStore.rememberPlaylistSongs(
    playlist.value?.listid ?? playlist.value?.id ?? getPlaylistId(),
    songs.value,
    isCurrentPlaylistSongCacheComplete(),
  );
  if (playlist.value && typeof playlist.value.count === 'number') {
    playlist.value = { ...playlist.value, count: playlist.value.count + additions.length };
  }
};

const applyRemovedPlaylistSongs = (removedSongs: readonly Song[]) => {
  const beforeCount = songs.value.length;
  pendingAddedPlaylistSongs = withoutMatchingSongs(pendingAddedPlaylistSongs, removedSongs);
  removedSongs.forEach((song) => {
    if (!hasMatchingSong(pendingRemovedPlaylistSongs, song)) {
      pendingRemovedPlaylistSongs.push(song);
    }
  });
  songs.value = mergePlaylistLocalChanges(songs.value);
  const removedCount = beforeCount - songs.value.length;
  if (removedCount === 0) return;
  loadedSongCount.value = songs.value.length;
  playlistStore.rememberPlaylistSongs(
    playlist.value?.listid ?? playlist.value?.id ?? getPlaylistId(),
    songs.value,
    isCurrentPlaylistSongCacheComplete(),
  );
  if (playlist.value && typeof playlist.value.count === 'number') {
    playlist.value = {
      ...playlist.value,
      count: Math.max(0, playlist.value.count - removedCount),
    };
  }
};

const applyPlaylistContentChanges = () => {
  const changesById = new Map<
    number,
    { id: number; action: 'add' | 'remove' | 'refresh'; songs: Song[] }
  >();
  currentPlaylistContentIds.value.forEach((id) => {
    (playlistStore.playlistContentChanges[id] ?? []).forEach((change) => {
      changesById.set(change.id, change);
    });
  });

  Array.from(changesById.values())
    .sort((left, right) => left.id - right.id)
    .forEach((change) => {
      if (appliedPlaylistChangeIds.has(change.id)) return;
      appliedPlaylistChangeIds.add(change.id);
      if (change.action === 'add') {
        applyAddedPlaylistSongs(change.songs);
        return;
      }
      if (change.action === 'remove') {
        applyRemovedPlaylistSongs(change.songs);
        return;
      }
      void fetchData();
    });
};

const handlePlayAll = async () => {
  const loader = songLoader;
  const generation = songLoadGeneration;
  const resourceId = getPlaylistId();
  const requestSortField = sortField.value;
  const requestSortOrder = sortOrder.value;
  const requestQuery = searchQuery.value;
  const isCurrent = () =>
    !disposed &&
    generation === songLoadGeneration &&
    resourceId === getPlaylistId() &&
    loader === songLoader;
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  const queueOpts = {
    queueId: `queue:playlist:${playlist.value?.id ?? getPlaylistId()}`,
    title: playlist.value?.name || '歌单',
    subtitle: playlist.value?.nickname || playlist.value?.list_create_username || '',
    type: 'playlist' as const,
    resumeScope: { kind: 'playlist', id: String(playlist.value?.id ?? getPlaylistId()) } as const,
  };
  const playRequest = replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    playlistFilteredInvalidCount.value,
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
    const allSongs = orderPlaylistSongs(await loader.waitForAll());
    if (!isCurrentQueue() || !loader.fullyLoaded || loader.failed) return;
    const sortedAllSongs = sortSongs(allSongs, requestSortField, requestSortOrder, {
      indexSource: allSongs,
    });
    const displayedAllSongs = filterSongsByQuery(sortedAllSongs, requestQuery);
    if (displayedAllSongs.length > queueSongs.length) {
      playlistStore.setPlaybackQueueWithOptions(
        Array.from(displayedAllSongs) as Song[],
        playlistFilteredInvalidCount.value,
        queueOpts,
      );
    }
  }
};
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};
// 定位按钮：找这个歌单里最近播放过、且位置有效的那一首（歌单桶已取消，改按曲目进度找）
// 桶用的是歌单自己的 id（播放队列也是 queue:playlist:<id>），不是路由里的 collection id
const resumeScopeId = computed(() => String(playlist.value?.id ?? getPlaylistId()));

const bucketScope = computed(
  () =>
    playerStore.resumeScopes.find(
      (entry) => entry.kind === 'playlist' && String(entry.id) === resumeScopeId.value,
    ) ?? null,
);

const bucketTrackId = computed(() => {
  // 有「歌单」桶就以桶为准；没有桶就退回「本歌单里最近一条有进度的曲目」
  const scope = bucketScope.value;
  if (scope?.trackId && (resumeRecordForScope(playerStore.$state, scope)?.position ?? 0) > 0) {
    return scope.trackId;
  }
  if (songs.value.length === 0) return '';
  const ids = new Set(songs.value.map((song) => String(song.id)));
  let best = '';
  let bestAt = -1;
  for (const { trackId, record } of resumeTrackRecords(playerStore.$state)) {
    if (!ids.has(trackId) || !record || !(record.position > 0)) continue;
    const at = Number(record.updatedAt ?? 0);
    if (at > bestAt) {
      bestAt = at;
      best = trackId;
    }
  }
  return best;
});

const bucketTarget = computed(() => {
  const trackId = bucketTrackId.value;
  if (!trackId) return null;
  const scope = bucketScope.value;
  // 定位到桶里那一首时读桶自己那条记录线；退回「最近一首」时读该曲目最近一条线
  const record =
    scope?.trackId === trackId
      ? resumeRecordForScope(playerStore.$state, scope)
      : resumeRecordOfTrack(playerStore.$state, trackId);
  if (!record || !(record.position > 0)) return null;
  return { trackId, position: record.position };
});

// 只有「在本页点了这一页的曲目播放」才建卡（认领走 playTrack 的 resumeScope）。
// 播放中进入详情页、或者回到这一页时，不再把正在播的歌自动认领进来。

// 进这一页就把「这一页的续播卡」贴出来（常驻）：有个 position > 0 的记录才贴，
// 退出页面、或者开始播记录里那一集（不管从哪儿点的）时才收。
const pageResumeHintKey = computed(() => {
  const scope = bucketScope.value;
  return scope && bucketTarget.value ? scope.kind + ':' + scope.id : '';
});

// 页面会被 RouteKeepAlive 缓存住，缓存的页面照样会收到播放状态变化：
// 只有本页在前台时才允许收掉提示卡，否则会把别的页面刚弹出来的那些卡一起收掉。
const dismissPageResumeHint = () => {
  if (isActive.value) dismissResumeHint();
};

const showPageResumeHintNow = () => {
  const scope = bucketScope.value;
  const target = bucketTarget.value;
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
  String(route.name ?? '') === 'playlist-detail' &&
  String(route.params.id ?? '') === String(getPlaylistId());

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

// 同一个按钮 3 秒内只认第一下

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
  while (loading.value && Date.now() - start <= LOCATE_WAIT_MS) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, LOCATE_RETRY_MS);
    });
  }
  return !loading.value;
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

const locateAnchorRef = ref<HTMLElement | null>(null);

// 进入页面时若这里已有上次播放的记录，主动把定位按钮的提示弹出来一次
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
    (entry) =>
      entry.trackId === trackId && entry.kind === 'playlist' && entry.id === resumeScopeId.value,
  );
  if (!scope) return;
  playerStore.forgetResumeScope(scope.kind, scope.id);
};

// play: true = 续播卡点的；false = 别的入口过来的，只定位不播；不传 = 页面上的「定位」按钮
const handleLocate = async () => {
  // 页面被 RouteKeepAlive 缓存着也会收到路由变化，不在这一页就不该动手
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
  if (loading.value || songs.value.length === 0) return false;
  if (!takeResumeHintRequest(pageResumeHintKey.value)) return false;
  void handleLocate();
  return true;
};

// 等歌曲列表真正就绪（不被 loading 挡住）再定位，否则虚拟列表还没有行可以滚
watch(
  [() => songs.value.length, loading],
  ([length, isLoading]) => {
    if (length === 0 || isLoading) return;
    if (consumeLocateRequest()) return;
    void nextTick(() => {
      if (!bucketTarget.value || locateHintShownOnce) return;
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

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const sortedSongs = computed(() =>
  sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  }),
);
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

watch(
  () =>
    currentPlaylistContentIds.value
      .map((id) => `${id}:${playlistStore.playlistContentVersions[id] ?? 0}`)
      .join('|'),
  () => {
    applyPlaylistContentChanges();
  },
  { immediate: true },
);
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="playlist-detail-page">
    <div class="playlist-detail-container bg-bg-main min-h-full">
      <DetailPageSkeleton v-if="loading && !playlist" typeLabel="PLAYLIST" :expandedHeight="176" />

      <DetailPageError v-else-if="!playlist" resource-name="歌单" @retry="fetchData" />

      <template v-else-if="playlist">
        <!-- 1. Sliver Header -->
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="PLAYLIST"
          :title="playlist.name"
          :description="playlist.intro"
          @description-click="showIntroDialog = true"
          :coverUrl="playlistCoverUrl"
          :hasDetails="true"
          distribute-details
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="contents">
              <div class="flex items-center gap-3">
                <div class="flex items-center gap-2">
                  <Avatar :src="playlist.userPic" :size="20" class="rounded-full overflow-hidden" />
                  <span class="text-[13px] font-semibold text-primary-text">{{
                    playlist.nickname || 'Unknown'
                  }}</span>
                </div>
                <span class="text-[11px] font-semibold text-text-secondary"
                  >{{ formatDate(playlist.publishDate || playlist.createTime, 'YYYY-MM-DD') }}
                  {{ playlist.publishDate ? '发布' : '创建' }}</span
                >
              </div>
              <div class="flex items-center flex-wrap gap-2 text-[11px] font-semibold">
                <span
                  class="playlist-song-count inline-flex items-center gap-1 text-text-secondary"
                >
                  <Icon :icon="iconMusic" width="12" height="12" />
                  <span>{{ songTotalCount }}</span>
                  <Button
                    v-if="playlistFilteredInvalidCount > 0"
                    variant="unstyled"
                    size="icon"
                    class="action-icon song-filter-info-btn"
                    aria-label="查看无效歌曲过滤说明"
                    :tooltip="`当前列表已过滤 ${playlistFilteredInvalidCount} 首无效歌曲\n通常是因为歌曲信息缺失无法参与播放`"
                    tooltip-side="bottom"
                  >
                    <Icon :icon="iconInfo" width="14" height="14" />
                  </Button>
                </span>
                <Tag v-for="tag in playlistTags" :key="tag" tone="accent">
                  {{ tag }}
                </Tag>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow
              :secondaryActions="secondaryActions"
              :showPlaybackActions="activeTab === 'songs'"
              :play-disabled="songs.length === 0"
              :batch-disabled="songs.length === 0"
              @play="handlePlayAll"
              @batch="openBatchDrawer"
            />
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
              v-if="!isOwnerPlaylist && userStore.isLoggedIn"
              variant="unstyled"
              size="icon"
              @click="togglePlaylistFavorite"
              class="action-icon rounded-lg hover:bg-[var(--control-hover-bg)] text-red-500"
            >
              <Icon
                :icon="isFavoritePlaylist ? iconHeartFilled : iconHeart"
                width="18"
                height="18"
              />
            </Button>
            <Button
              v-if="editablePlaylist"
              variant="unstyled"
              size="icon"
              tooltip="编辑歌单"
              aria-label="编辑歌单"
              @click="showPlaylistEdit = true"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconPencil" width="18" height="18" />
            </Button>
            <Button
              variant="unstyled"
              size="icon"
              @click="handleSharePlaylist"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconShare" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <BatchActionDrawer
          v-model:open="showBatchDrawer"
          :songs="songs"
          :source-id="playlist?.listid || playlist?.id"
        />

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
                    <Button
                      class="action-icon song-sort-btn"
                      v-if="playlistOrderTarget"
                      variant="soft-secondary"
                      size="icon"
                      :disabled="songs.length === 0"
                      tooltip="调整歌曲顺序"
                      @click="showPlaylistOrder = true"
                    >
                      <Icon :icon="iconArrowsSort" width="16" />
                    </Button>
                    <SongSearchInput v-model="searchQuery" :disabled="songs.length === 0" />
                    <span ref="locateAnchorRef" class="inline-flex">
                      <Button
                        variant="unstyled"
                        size="icon"
                        :disabled="songs.length === 0"
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
                :loading="loading"
                :active="activeTab === 'songs'"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: `queue:playlist:${playlist?.id ?? getPlaylistId()}`,
                  title: playlist?.name || '歌单',
                  subtitle: playlist?.nickname || playlist?.list_create_username || '',
                  type: 'playlist',
                  resumeScope: { kind: 'playlist', id: String(playlist?.id ?? getPlaylistId()) },
                }"
                :queueFilteredInvalidCount="playlistFilteredInvalidCount"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
                "
                :parentPlaylistId="playlist.listid || playlist.id"
                :enableRemoveFromPlaylist="isOwnerPlaylist"
                :onRemovedFromPlaylist="handleRemovedFromPlaylist"
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
                  :resource-id="playlistCommentId"
                  :comments="hotComments"
                  :loading="loadingComments"
                  resourceType="playlist"
                  :fallbackMixSongId="String(currentId)"
                  compact
                  hide-empty
                  @deleted="fetchComments(true)"
                />
                <CommentList
                  :resource-id="playlistCommentId"
                  :comments="comments"
                  :loading="loadingComments"
                  :total="commentTotal"
                  resourceType="playlist"
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
                :resource="{ type: 'playlist', id: String(playlistCommentId), name: playlist.name }"
                @sent="fetchComments(true)"
              />
            </TabsContent>
          </div>
        </Tabs>
        <Dialog
          v-model:open="showIntroDialog"
          :title="'歌单介绍'"
          :description="playlist.intro"
          contentClass="detail-intro-dialog"
          descriptionClass="text-[13px]"
          showClose
        />
      </template>
    </div>
  </PageScrollContainer>
  <PlaylistEditDialog
    v-if="showPlaylistEdit && editablePlaylist"
    v-model:open="showPlaylistEdit"
    :target="editablePlaylist"
    @saved="handlePlaylistEdited"
  />
  <PlaylistOrderDialog
    v-if="showPlaylistOrder && playlistOrderTarget"
    v-model:open="showPlaylistOrder"
    :target="playlistOrderTarget"
    @saved="handlePlaylistOrderSaved"
  />
</template>

<style scoped>
@reference "@/style.css";

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

.playlist-song-count {
  gap: 4px;
}

.song-filter-info-btn {
  --button-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #f59e0b;
  transition: all 0.2s ease;
}

.song-filter-info-btn:hover {
  color: #d97706;
  background: rgba(245, 158, 11, 0.14);
}

.song-filter-info-btn:active {
  transform: scale(0.96);
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
