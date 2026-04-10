<script setup lang="ts">
import { ref, shallowRef, onMounted, computed, watch } from 'vue';
import { extractFirstObject, extractList } from '@/utils/extractors';
import { useRoute, useRouter } from 'vue-router';
import {
  getAlbumDetail,
  getAlbumSongs,
  favoriteAlbum as favoriteAlbumApi,
  unfavoriteAlbum as unfavoriteAlbumApi,
} from '@/api/album';
import { getAlbumComments, getFloorComments } from '@/api/comment';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import CommentList from '@/components/music/CommentList.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song, SongArtist } from '@/models/song';
import Button from '@/components/ui/Button.vue';
import { mapAlbumDetailMeta, mapAlbumSong, mapCommentItem } from '@/utils/mappers';
import type { AlbumMeta } from '@/models/album';
import type { Comment } from '@/models/comment';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { iconCurrentLocation, iconSearch, iconPlay, iconList, iconHeart, iconX } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const parseIntSafe = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const route = useRoute();
const router = useRouter();
const getAlbumId = () => route.params.id as string;

const isSameRoute = (name: string, targetId: string | number) => {
  const routeId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id;
  return route.name === name && String(routeId) === String(targetId);
};

const loading = ref(true);
const album = ref<AlbumMeta | null>(null);

// 使用 shallowRef 极大减少响应式开销
const songs = shallowRef<Song[]>([]);
const loadedSongCount = ref(0);

const activeTab = ref('songs');
const loadingComments = ref(false);
const comments = ref<Comment[]>([]);
const hotComments = ref<Comment[]>([]);
const commentTotal = ref(0);
const commentPage = ref(1);
const hasMoreComments = ref(true);
const showBatchDrawer = ref(false);
const showIntroDialog = ref(false);
const showFloor = ref(false);
const floorLoading = ref(false);
const floorReplies = ref<Comment[]>([]);
const floorTotal = ref(0);
const floorPage = ref(1);
const floorHasMore = ref(true);
const activeFloorComment = ref<Comment | null>(null);
const floorMessage = ref('');
const floorLoadMoreMessage = ref('');
const floorBodyRef = ref<HTMLElement | null>(null);

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
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);

// 计算 Tabs 的 sticky top 位置
const tabsTop = computed(() => {
  const headerHeight = sliverHeaderRef.value?.currentHeight || 52;
  return headerHeight;
});

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

const isAlbumArtistClickable = (artist: SongArtist) => {
  if (!artist.id) return false;
  return !isSameRoute('artist-detail', artist.id);
};

const openAlbumArtist = (artist: SongArtist) => {
  if (!artist.id || !isAlbumArtistClickable(artist)) return;
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

const toggleFavoriteAlbum = async () => {
  const meta = album.value;
  if (!meta) return;
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('收藏专辑');
    return;
  }

  if (isFavoriteAlbum.value) {
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
    const listId = target?.listid ?? target?.id;
    if (!listId) return;
    try {
      const res = await unfavoriteAlbumApi(listId);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        await playlistStore.fetchUserPlaylists();
        toastStore.actionCompleted('已取消收藏专辑');
      } else {
        toastStore.actionFailed('取消收藏专辑');
      }
    } catch {
      toastStore.actionFailed('取消收藏专辑');
    }
    return;
  }

  try {
    const res = await favoriteAlbumApi(meta.id, meta.name, meta.singerId);
    if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
      await playlistStore.fetchUserPlaylists();
      toastStore.actionSucceeded('收藏专辑');
    } else {
      toastStore.actionFailed('收藏专辑');
    }
  } catch {
    toastStore.actionFailed('收藏专辑');
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

const sortedSongs = computed(() => {
  const data = songs.value;
  if (!sortField.value || !sortOrder.value || data.length === 0) return data;
  if (sortField.value === 'index') {
    return sortOrder.value === 'asc' ? data : [...data].reverse();
  }

  const direction = sortOrder.value === 'asc' ? 1 : -1;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });

  return [...data].sort((a, b) => {
    switch (sortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.album ?? '', b.album ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      default:
        return 0;
    }
  });
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
    const res = await getAlbumComments(getAlbumId(), commentPage.value, 30, {
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

      const totalRaw =
        data.total ?? data.count ?? record.total ?? record.count ?? commentTotal.value;
      const totalValue = parseIntSafe(totalRaw);
      if (totalValue > 0) {
        commentTotal.value = totalValue;
        hasMoreComments.value = comments.value.length < totalValue;
      } else {
        hasMoreComments.value = mapped.length > 0;
      }

      if (hasMoreComments.value) {
        commentPage.value += 1;
      }
    } else {
      hasMoreComments.value = false;
    }
  } catch (e) {
    console.error('Fetch album comments error:', e);
    hasMoreComments.value = false;
    toastStore.loadFailed('专辑评论');
  } finally {
    loadingComments.value = false;
  }
};

const loadingSongs = ref(true);

const handleTabChange = (value: string | number) => {
  activeTab.value = String(value);
  if (value === 'comments' && comments.value.length === 0) {
    fetchComments(true);
  }
};

const fetchData = async () => {
  loading.value = true;
  loadingSongs.value = true;
  const albumId = getAlbumId();

  // 1. 先获取专辑详情，用于展示 Header
  const detailTask = getAlbumDetail(albumId)
    .then((detailRes) => {
      const detailRaw = extractFirstObject(detailRes);
      if (detailRaw) {
        album.value = mapAlbumDetailMeta(detailRaw);
        albumArtists.value = parseAlbumArtists(detailRaw);
      } else {
        albumArtists.value = [];
      }
      loading.value = false;
    })
    .catch((e) => {
      console.error('Fetch album detail error:', e);
      loading.value = false;
    });

  // 2. 获取歌曲列表
  const songsTask = getAlbumSongs(albumId, 1, 30)
    .then((songsRes) => {
      const fetched = extractList(songsRes).map((item) => mapAlbumSong(item));
      songs.value = fetched;
      loadedSongCount.value = fetched.length;
      loadingSongs.value = false;

      // 优先使用详情接口给出的总数，避免并发请求下读取到旧值
      const totalSongs = album.value?.songCount ?? fetched.length;
      if (totalSongs > fetched.length) {
        void fetchAllAlbumSongs(totalSongs);
      }
    })
    .catch((e) => {
      console.error('Fetch album songs error:', e);
      loadingSongs.value = false;
    });

  await Promise.allSettled([detailTask, songsTask]);
};

const fetchAllAlbumSongs = async (totalCount: number) => {
  if (songs.value.length >= totalCount) return;
  const pageSize = 30;
  const albumId = getAlbumId();
  const seenIds = new Set(songs.value.map((song) => song.id));
  let page = 2;
  let bufferedSongs = [...songs.value];

  try {
    while (bufferedSongs.length < totalCount) {
      const res = await getAlbumSongs(albumId, page, pageSize);
      if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) break;
      const nextSongs = extractList(res).map((item) => mapAlbumSong(item));
      const filtered = nextSongs.filter((song) => {
        if (seenIds.has(song.id)) return false;
        seenIds.add(song.id);
        return true;
      });
      if (filtered.length === 0) break;
      bufferedSongs = [...bufferedSongs, ...filtered];
      loadedSongCount.value = bufferedSongs.length;
      page += 1;
    }
    songs.value = bufferedSongs;
  } catch {
    toastStore.loadFailed('专辑歌曲');
  }
};

onMounted(fetchData);

watch(
  () => route.params.id,
  () => {
    album.value = null;
    albumArtists.value = [];
    songs.value = [];
    loadedSongCount.value = 0;
    comments.value = [];
    hotComments.value = [];
    commentPage.value = 1;
    commentTotal.value = 0;
    hasMoreComments.value = true;
    fetchData();
    if (activeTab.value === 'comments') {
      fetchComments(true);
    }
  },
);

const secondaryActions = computed(() => {
  if (!userStore.isLoggedIn || !album.value) return [];
  return [
    {
      icon: iconHeart,
      label: isFavoriteAlbum.value ? '已收藏' : '收藏',
      emphasized: isFavoriteAlbum.value,
      tone: 'favorite' as const,
      onTap: async () => {
        if (!album.value) return;
        await toggleFavoriteAlbum();
      },
    },
  ];
});

const handleSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song);
};

const handlePlayAll = async () => {
  if (songs.value.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value);
};
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};
const handleLocate = () => songListRef.value?.scrollToActive?.();

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const openCommentPageWithFloor = (comment: Comment) => {
  activeFloorComment.value = comment;
  floorReplies.value = [];
  floorTotal.value = 0;
  floorPage.value = 1;
  floorHasMore.value = true;
  floorMessage.value = '';
  floorLoadMoreMessage.value = '';
  showFloor.value = true;
  void fetchFloorReplies(true);
};

const handleFloorScroll = () => {
  if (!floorBodyRef.value) return;
  if (floorLoading.value || !floorHasMore.value) return;
  const { scrollTop, scrollHeight, clientHeight } = floorBodyRef.value;
  if (scrollHeight - scrollTop - clientHeight < 240) {
    void fetchFloorReplies();
  }
};

const fetchFloorReplies = async (reset = false) => {
  if (!activeFloorComment.value) return;
  if (floorLoading.value) return;
  if (!floorHasMore.value && !reset) return;
  if (reset) {
    floorPage.value = 1;
    floorReplies.value = [];
    floorHasMore.value = true;
  }
  floorLoading.value = true;
  try {
    const comment = activeFloorComment.value;
    const specialId = comment.specialId ?? '';
    const tid = comment.tid ?? String(comment.id);
    if (!specialId || !tid) {
      floorMessage.value = '楼层评论暂不可用';
      floorHasMore.value = false;
      return;
    }
    const res = await getFloorComments({
      specialId,
      tid,
      mixSongId: comment.mixSongId,
      code: comment.code,
      resourceType: 'album',
      page: floorPage.value,
      pagesize: 30,
    });
    if (res && typeof res === 'object') {
      const payload = (res as { data?: unknown }).data ?? res;
      const record = payload as Record<string, unknown>;
      const list = Array.isArray(record.list) ? record.list : [];
      const mapped = list.map(mapCommentItem);
      floorReplies.value = reset ? mapped : [...floorReplies.value, ...mapped];
      const totalCount = Number(record.comments_num ?? 0) || 0;
      floorTotal.value = totalCount;
      floorHasMore.value =
        totalCount > 0 ? floorReplies.value.length < totalCount : mapped.length >= 30;
      if (floorHasMore.value) floorPage.value += 1;
      if (floorReplies.value.length === 0) {
        floorMessage.value = String(record.message ?? '') || '暂无回复';
      }
    }
  } catch {
    floorLoadMoreMessage.value = '加载更多失败，点击重试';
    toastStore.loadFailed('楼层评论');
  } finally {
    floorLoading.value = false;
  }
};
</script>

<template>
  <div class="album-detail-container bg-bg-main min-h-full">
    <div v-if="loading && !album" class="flex items-center justify-center py-40">
      <div
        class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
      ></div>
    </div>

    <template v-else-if="album">
      <!-- 1. Sliver Header -->
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="ALBUM"
        :title="album.name"
        :coverUrl="album.pic"
        :hasDetails="false"
        :expandedHeight="176"
      >
        <template #details>
          <div class="flex flex-col gap-1 text-text-main/60">
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
            <div class="text-[11px] font-semibold opacity-60">
              {{ album.publishTime }} • {{ albumSongCount }} 首歌曲
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
            variant="unstyled"
            size="none"
            @click="handlePlayAll"
            class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-primary"
          >
            <Icon :icon="iconPlay" width="20" height="20" />
          </Button>
          <Button
            variant="unstyled"
            size="none"
            @click="openBatchDrawer"
            class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-main opacity-60"
          >
            <Icon :icon="iconList" width="18" height="18" />
          </Button>
        </template>
      </SliverHeader>

      <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" />

      <div v-if="album.intro" class="px-6 pt-[6px] pb-[6px]">
        <div class="text-[15px] font-semibold text-text-main">专辑介绍</div>
        <div class="mt-[6px] text-[12px] leading-relaxed text-text-secondary line-clamp-1">
          {{ album.intro }}
        </div>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="mt-[2px] text-[11px] font-semibold text-primary"
          @click="showIntroDialog = true"
        >
          查看详情
        </Button>
      </div>

      <!-- 2. Sticky Tabs + 表头 -->
      <Tabs :model-value="activeTab" class="w-full" @update:model-value="handleTabChange">
        <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: `${tabsTop}px` }">
          <div class="px-6 border-b border-border-light/10">
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
                    class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg bg-white border border-black/30 shadow-sm text-text-main placeholder:text-text-main/50 dark:bg-white/[0.08] dark:border-white/10 dark:shadow-none outline-none text-[12px] transition-all"
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
              :songs="sortedSongs"
              :loading="loadingSongs"
              :active="activeTab === 'songs'"
              :searchQuery="searchQuery"
              :activeId="activeSongId"
              :showCover="true"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
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
                :comments="hotComments"
                :loading="loadingComments"
                :onTapReplies="openCommentPageWithFloor"
                compact
                hide-empty
              />
              <CommentList
                :comments="comments"
                :loading="loadingComments"
                :total="commentTotal"
                :onTapReplies="openCommentPageWithFloor"
                compact
                :hide-empty="hotComments.length > 0"
              />

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
        title="专辑介绍"
        :description="album.intro"
        contentClass="max-w-[720px]"
        descriptionClass="text-[13px]"
        showClose
      />
      <Dialog
        v-model:open="showFloor"
        contentClass="comment-floor-dialog"
        bodyClass="comment-floor-dialog-body"
      >
        <div class="comment-floor-header">
          <div class="comment-floor-title">楼层评论</div>
          <Button class="comment-floor-close" variant="ghost" size="xs" @click="showFloor = false">
            <Icon :icon="iconX" width="20" height="20" />
          </Button>
        </div>
        <div class="comment-floor-body" ref="floorBodyRef" @scroll="handleFloorScroll">
          <div class="comment-floor-section">原评论</div>
          <CommentList
            v-if="activeFloorComment"
            :comments="[activeFloorComment]"
            :showDivider="false"
            :loading="false"
            compact
          />
          <div class="comment-floor-section">
            回复{{ floorTotal > 0 ? ` (${floorTotal})` : '' }}
          </div>
          <CommentList
            :comments="floorReplies"
            :loading="floorLoading"
            :showDivider="true"
            compact
          />
          <div v-if="!floorLoading && floorReplies.length === 0" class="comment-floor-empty">
            {{ floorMessage || '暂无回复' }}
          </div>
          <div
            v-if="floorHasMore || floorLoading || floorReplies.length > 0"
            class="comment-load-more comment-load-more-floor"
          >
            <div v-if="floorLoading" class="comment-loading-inline">
              <div class="comment-loading-spinner"></div>
              <span>加载中...</span>
            </div>
            <Button
              v-else-if="floorHasMore"
              variant="outline"
              size="xs"
              @click="fetchFloorReplies()"
            >
              {{ floorLoadMoreMessage || '加载更多' }}
            </Button>
            <div v-else class="comment-end-hint">已加载全部评论</div>
          </div>
        </div>
      </Dialog>
    </template>
  </div>
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
  color: var(--color-primary);
}

.album-singer-link.is-link {
  cursor: pointer;
}

.album-artist-separator {
  font-size: 13px;
  font-weight: 600;
  opacity: 0.5;
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

:global(.comment-floor-dialog) {
  width: min(620px, calc(100vw - 40px));
  max-width: calc(100vw - 40px);
  max-height: min(720px, calc(100vh - 24px));
  padding: 24px 2px 24px 24px;
  border-radius: 24px;
  overflow: hidden;
}

:global(.comment-floor-dialog .dialog-scroll-area) {
  margin-top: 0;
  overflow-y: auto;
  min-height: 0;
}

:global(.comment-floor-dialog .comment-floor-dialog-body) {
  padding-right: 16px;
  margin-top: 0;
}

.comment-floor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.comment-floor-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
}

.comment-floor-close {
  flex-shrink: 0;
}

.comment-floor-body {
  max-height: min(580px, calc(100vh - 180px));
  overflow-y: auto;
  padding-right: 8px;
}

.comment-floor-section {
  margin: 10px 0 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.comment-floor-empty {
  padding: 8px 0 0;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.comment-load-more {
  display: flex;
  justify-content: center;
  margin: 18px 0 12px;
}

.comment-load-more-floor {
  margin-bottom: 0;
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
