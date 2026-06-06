<script setup lang="ts">
defineOptions({ name: 'playlist-detail' });
import { ref, shallowRef, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useRouteId } from '@/composables/useRouteId';
import { getPlaylistDetail, getPlaylistTracks } from '@/api/playlist';
import { getPlaylistComments } from '@/api/comment';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import Avatar from '@/components/ui/Avatar.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import CommentList from '@/components/music/CommentList.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import type { Song } from '@/models/song';
import { formatDate } from '@/utils/format';
import { useUserStore } from '@/stores/user';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { mapPlaylistMeta, resolvePlaylistTrackQueryId, mapCommentItem } from '@/utils/mappers';
import { parsePlaylistTracks } from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { Comment } from '@/models/comment';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { logger } from '@/utils/logger';
import {
  iconCurrentLocation,
  iconSearch,
  iconPlay,
  iconList,
  iconMusic,
  iconHeart,
  iconHeartFilled,
  iconInfo,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useToastStore } from '@/stores/toast';
import { toRecord } from '../../../shared/object';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import { isSameSong } from '@/utils/song';

const parseIntSafe = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const { id: currentId, onIdChange } = useRouteId();
// const router = useRouter();
const getPlaylistId = () => currentId.value;

const loading = ref(true);
const playlist = ref<PlaylistMeta | null>(null);

// 使用 shallowRef 极大减少响应式开销
const songs = shallowRef<Song[]>([]);
const loadedSongCount = ref(0);

const playlistFilteredInvalidCount = ref(0);
const activeTab = ref('songs');
const loadingComments = ref(false);
const comments = ref<Comment[]>([]);
const hotComments = ref<Comment[]>([]);
const commentTotal = ref(0);
const commentPage = ref(1);
const hasMoreComments = ref(true);
const showIntroDialog = ref(false);
const showBatchDrawer = ref(false);

// 搜索和定位逻辑
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const userStore = useUserStore();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();

const isOwnerPlaylist = computed(() => {
  const meta = playlist.value;
  const currentUserId = userStore.info?.userid;
  return !!meta && !!currentUserId && meta.listCreateUserid === currentUserId && meta.source !== 2;
});

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
  if (!playlist.value) return false;
  const currentIds = currentPlaylistIds.value;
  if (currentIds.length === 0) return false;
  const currentUserId = userStore.info?.userid;
  return playlistStore.userPlaylists.some((entry) => {
    if (entry.source === 2) return false;
    if (currentUserId && entry.listCreateUserid === currentUserId) return false;
    const entryIds = [
      entry.id,
      entry.listid,
      entry.listCreateListid,
      entry.globalCollectionId,
      entry.listCreateGid,
    ]
      .filter((item): item is string | number => item !== undefined && item !== null && item !== '')
      .map((item) => String(item));
    return entryIds.some((id) => currentIds.includes(id));
  });
});

const songTotalCount = computed(() => {
  const metaCount = playlist.value?.count ?? 0;
  return metaCount > 0 ? metaCount : loadedSongCount.value;
});

const playlistTags = computed(() => {
  const raw = playlist.value?.tags ?? '';
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
});

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

const fetchComments = async (reset = false) => {
  if (loadingComments.value) return;
  if (reset) {
    commentPage.value = 1;
    comments.value = [];
    hotComments.value = [];
    commentTotal.value = 0;
    hasMoreComments.value = true;
  }
  if (!hasMoreComments.value) return;

  loadingComments.value = true;
  try {
    const res = await getPlaylistComments(playlistCommentId.value, commentPage.value, 30, {
      showClassify: commentPage.value === 1,
      showHotwordList: commentPage.value === 1,
    });
    if (
      res &&
      typeof res === 'object' &&
      'status' in res &&
      (res as { status?: number }).status === 1
    ) {
      const record = toRecord(res);
      const data = toRecord(record.data ?? record.info ?? record);
      const listCandidate = data.list ?? data.comments ?? [];
      const hotCandidate = data.hot_list ?? data.weight_list ?? [];
      const list = Array.isArray(listCandidate) ? listCandidate : [];
      const hotList = Array.isArray(hotCandidate) ? hotCandidate : [];
      const mapped = list.map(mapCommentItem).filter((item) => item.content.length > 0);
      const mappedHot = hotList.map(mapCommentItem).filter((item) => item.content.length > 0);
      if (reset) {
        hotComments.value = mappedHot.map((item) => ({ ...item }));
      }
      comments.value = reset ? mapped : [...comments.value, ...mapped];

      // 如果本页没有返回任何有效评论（非 reset），说明已到末尾
      if (!reset && mapped.length === 0) {
        hasMoreComments.value = false;
      } else {
        const totalRaw =
          data.total ?? data.count ?? record.total ?? record.count ?? commentTotal.value;
        const totalValue = parseIntSafe(totalRaw);
        if (totalValue > 0) {
          commentTotal.value = totalValue;
          hasMoreComments.value = comments.value.length < totalValue;
        } else {
          hasMoreComments.value = mapped.length > 0;
        }
      }

      if (hasMoreComments.value) {
        commentPage.value += 1;
      }
    } else {
      hasMoreComments.value = false;
    }
  } catch (e) {
    logger.error('PlaylistDetail', 'Fetch playlist comments error', e);
    hasMoreComments.value = false;
  } finally {
    loadingComments.value = false;
  }
};

// 计算 Tabs 的 sticky top 位置
const tabsTop = computed(() => {
  const headerHeight = sliverHeaderRef.value?.currentHeight || 56;
  return headerHeight;
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

const handleTabChange = (value: string | number) => {
  activeTab.value = String(value);
  if (value === 'comments' && comments.value.length === 0) {
    fetchComments(true);
  }
};

// 滚动加载更多评论（使用 IntersectionObserver）
const scrollContainerRef = useScrollContainer();
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
  const mergedSongs = mergePlaylistLocalChanges(items);
  songs.value = mergedSongs;
  loadedSongCount.value = mergedSongs.length;
  playlistStore.rememberPlaylistSongs(
    playlist.value?.listid ?? playlist.value?.id ?? getPlaylistId(),
    mergedSongs,
    complete && isCurrentPlaylistSongCacheComplete(mergedSongs),
  );
};

const fetchData = async () => {
  loading.value = true;
  try {
    pendingAddedPlaylistSongs = [];
    pendingRemovedPlaylistSongs = [];
    const detailRes = await getPlaylistDetail(getPlaylistId());
    if (detailRes) {
      const { status, data } = detailRes;
      if (status === 1) {
        if (data?.[0]) {
          playlist.value = mapPlaylistMeta(data?.[0]);
        }
      }
    }

    const playlistMeta = playlist.value;
    const currentUserId = userStore.info?.userid;
    const queryId = resolvePlaylistTrackQueryId(getPlaylistId(), {
      listid: playlistMeta?.listid,
      listCreateGid: playlistMeta?.listCreateGid,
      listCreateUserid: playlistMeta?.listCreateUserid,
      currentUserId,
    });

    // 中止上一次加载
    if (songLoader) {
      songLoader.abort();
    }

    // 重置过滤计数
    playlistFilteredInvalidCount.value = 0;

    songLoader = new PagedSongLoader<Song>(
      async (page, pageSize) => {
        const res = await getPlaylistTracks(queryId, page, pageSize);
        if (!res || typeof res !== 'object') return { items: [], hasMore: false };
        const hasStatus = 'status' in res;
        const statusOk = hasStatus && (res as { status?: number }).status === 1;
        const hasPayload = 'data' in res || 'info' in res;
        if (!statusOk && !hasPayload) return { items: [], hasMore: false };

        const payload =
          'data' in res
            ? (res as { data?: unknown }).data
            : 'info' in res
              ? (res as { info?: unknown }).info
              : res;
        const { songs: parsedSongs, filteredCount } = parsePlaylistTracks(payload ?? res);
        playlistFilteredInvalidCount.value += filteredCount;
        // 返回数量不足一页说明没有更多了
        const hasMore = parsedSongs.length + filteredCount >= pageSize;
        return { items: parsedSongs, hasMore };
      },
      {
        pageSize: 200,
        concurrency: 3,
        dedupeKey: (song) => String(song.id),
        logTag: 'PlaylistDetailLoader',
        onPageLoaded(allItems) {
          updateSongsFromLoader(allItems, false);
        },
        onComplete(allItems) {
          updateSongsFromLoader(allItems, true);
        },
        onError() {
          toastStore.loadFailed('歌单歌曲');
        },
      },
    );

    // 首页加载完立即渲染
    await songLoader.loadFirstPage();

    // 后台加载剩余页
    const targetTotal = playlistMeta?.count ?? 0;
    if (!songLoader.fullyLoaded && targetTotal > songLoader.count) {
      void songLoader.loadRemaining();
    }
  } catch (e) {
    console.error('Fetch playlist error:', e);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  fetchData();
  setupCommentObserver();
});

// id 变化时重置数据（仅同路由间切换，如歌单A→歌单B）
onIdChange(() => {
  playlist.value = null;
  songs.value = [];
  loadedSongCount.value = 0;
  playlistFilteredInvalidCount.value = 0;
  comments.value = [];
  hotComments.value = [];
  commentPage.value = 1;
  commentTotal.value = 0;
  hasMoreComments.value = true;
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
  commentObserver?.disconnect();
  commentObserver = null;
});

watch(
  () => playlistCommentId.value,
  (nextId, prevId) => {
    if (nextId !== prevId && activeTab.value === 'comments') {
      fetchComments(true);
    }
  },
);

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
      onTap: async () => {
        if (!playlist.value) return;
        if (!userStore.isLoggedIn) return;
        if (isFavoritePlaylist.value) {
          await playlistStore.unfavoritePlaylist(playlist.value, userStore.info?.userid);
        } else {
          await playlistStore.favoritePlaylist(playlist.value, userStore.info?.userid);
        }
      },
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
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  const queueOpts = {
    queueId: `queue:playlist:${playlist.value?.id ?? getPlaylistId()}`,
    title: playlist.value?.name || '歌单',
    subtitle: playlist.value?.nickname || playlist.value?.list_create_username || '',
    type: 'playlist' as const,
  };
  await replaceQueueAndPlay(
    playlistStore,
    playerStore,
    queueSongs,
    playlistFilteredInvalidCount.value,
    undefined,
    queueOpts,
  );
  // 后台等待全部加载完，静默更新播放队列
  if (songLoader && !songLoader.fullyLoaded) {
    const allSongs = Array.from(await songLoader.waitForAll()) as Song[];
    const sortedAllSongs = sortSongs(allSongs, sortField.value, sortOrder.value, {
      indexSource: allSongs,
    });
    const displayedAllSongs = filterSongsByQuery(sortedAllSongs, searchQuery.value);
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
const handleLocate = () => songListRef.value?.scrollToActive?.();

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
  <PageScrollContainer class="playlist-detail-page">
    <div class="playlist-detail-container bg-bg-main min-h-full">
      <div v-if="loading && !playlist" class="flex items-center justify-center py-40">
        <div
          class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>

      <template v-else-if="playlist">
        <!-- 1. Sliver Header -->
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="PLAYLIST"
          :title="playlist.name"
          :coverUrl="playlist.pic"
          :hasDetails="true"
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <div class="flex items-center gap-2">
                  <Avatar :src="playlist.userPic" :size="20" class="rounded-full overflow-hidden" />
                  <span class="text-[13px] font-semibold text-primary">{{
                    playlist.nickname || 'Unknown'
                  }}</span>
                </div>
                <span class="text-[11px] font-semibold text-text-main/60"
                  >{{ formatDate(playlist.publishDate || playlist.createTime, 'YYYY-MM-DD') }}
                  {{ playlist.publishDate ? '发布' : '创建' }}</span
                >
              </div>
              <div class="flex items-center flex-wrap gap-2 text-[11px] font-semibold">
                <span class="playlist-song-count inline-flex items-center gap-1 text-text-main/50">
                  <Icon :icon="iconMusic" width="12" height="12" />
                  <span>{{ songTotalCount }}</span>
                  <Tooltip
                    v-if="playlistFilteredInvalidCount > 0"
                    side="bottom"
                    align="center"
                    :side-offset="10"
                    contentClass="song-filter-tooltip"
                  >
                    <template #trigger>
                      <Button
                        variant="unstyled"
                        size="none"
                        class="song-filter-info-btn rounded-lg"
                      >
                        <Icon :icon="iconInfo" width="14" height="14" />
                      </Button>
                    </template>
                    <span class="block whitespace-pre-line"
                      >当前列表已过滤 {{ playlistFilteredInvalidCount }} 首无效歌曲</span
                    >
                    <span class="block whitespace-pre-line"
                      >通常是因为歌曲信息缺失无法参与播放</span
                    >
                  </Tooltip>
                </span>
                <span
                  v-for="tag in playlistTags"
                  :key="tag"
                  class="px-2 py-0.5 rounded-md text-[10px] font-semibold text-primary bg-primary/10 border border-primary/20"
                >
                  {{ tag }}
                </span>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow
              :secondaryActions="secondaryActions"
              @play="handlePlayAll"
              @batch="openBatchDrawer"
            />
          </template>

          <template #collapsed-actions>
            <Button
              v-if="!isOwnerPlaylist && userStore.isLoggedIn"
              variant="unstyled"
              size="none"
              @click="
                () => {
                  if (!playlist) return;
                  if (isFavoritePlaylist) {
                    playlistStore.unfavoritePlaylist(playlist, userStore.info?.userid);
                  } else {
                    playlistStore.favoritePlaylist(playlist, userStore.info?.userid);
                  }
                }
              "
              class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-red-500"
            >
              <Icon
                :icon="isFavoritePlaylist ? iconHeartFilled : iconHeart"
                width="18"
                height="18"
              />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              @click="handlePlayAll"
              class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-primary"
            >
              <Icon :icon="iconPlay" width="20" height="20" />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              @click="openBatchDrawer"
              class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
            >
              <Icon :icon="iconList" width="18" height="18" />
            </Button>
          </template>
        </SliverHeader>

        <BatchActionDrawer
          v-model:open="showBatchDrawer"
          :songs="songs"
          :source-id="playlist?.listid || playlist?.id"
        />

        <div v-if="playlist.intro" class="px-6 pt-1.5 pb-1.5">
          <div class="text-[15px] font-semibold text-text-main">歌单介绍</div>
          <div class="mt-1.5 text-[12px] leading-relaxed text-text-secondary line-clamp-1">
            {{ playlist.intro }}
          </div>
          <Button
            variant="unstyled"
            size="none"
            type="button"
            class="mt-0.5 text-[11px] font-semibold text-primary"
            @click="showIntroDialog = true"
          >
            查看详情
          </Button>
        </div>

        <!-- 2. Sticky Tabs + 表头 -->
        <Tabs :model-value="activeTab" class="w-full" @update:model-value="handleTabChange">
          <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
            <div class="px-6 border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="bg-transparent border-none gap-8">
                  <TabsTrigger value="songs">
                    <span class="relative">歌曲 <Badge :count="loadedSongCount" /></span>
                  </TabsTrigger>
                  <TabsTrigger value="comments">
                    <span class="relative">
                      评论
                      <Badge v-if="commentTotal > 0" :count="commentTotal" class="-right-6" />
                    </span>
                  </TabsTrigger>
                </TabsList>

                <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="searchQuery"
                      type="text"
                      placeholder="搜索歌曲..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60 dark:text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
                  </div>
                  <Button
                    variant="unstyled"
                    size="none"
                    @click="handleLocate"
                    class="song-locate-btn p-2 rounded-lg"
                    title="定位当前播放"
                  >
                    <Icon :icon="iconCurrentLocation" width="18" height="18" />
                  </Button>
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
          </div>

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
                }"
                :queueFilteredInvalidCount="playlistFilteredInvalidCount"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
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
                  :comments="hotComments"
                  :loading="loadingComments"
                  resourceType="playlist"
                  :fallbackMixSongId="String(currentId)"
                  compact
                  hide-empty
                />
                <CommentList
                  :comments="comments"
                  :loading="loadingComments"
                  :total="commentTotal"
                  resourceType="playlist"
                  :fallbackMixSongId="String(currentId)"
                  compact
                  :hide-empty="hotComments.length > 0"
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
            </TabsContent>
          </div>
        </Tabs>
        <Dialog
          v-model:open="showIntroDialog"
          :title="'歌单介绍'"
          :description="playlist.intro"
          contentClass="detail-intro-dialog max-w-[720px]"
          descriptionClass="text-[13px]"
          showClose
        />
      </template>
    </div>
  </PageScrollContainer>
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
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

:deep(.song-filter-tooltip) {
  max-width: 280px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-elevated);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  box-shadow: var(--shadow-elevated);
  z-index: 150;
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
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
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
</style>
