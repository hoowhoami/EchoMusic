<script setup lang="ts">
import { ref, shallowRef, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
import {
  iconCurrentLocation,
  iconSearch,
  iconPlay,
  iconList,
  iconMusic,
  iconHeart,
  iconInfo,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
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
const getPlaylistId = () => route.params.id as string;

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
    console.error('Fetch playlist comments error:', e);
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

const fetchData = async () => {
  loading.value = true;
  try {
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

    const tracksRes = await getPlaylistTracks(queryId, 1, 200);

    if (tracksRes && typeof tracksRes === 'object') {
      const hasStatus = 'status' in tracksRes;
      const statusOk = hasStatus && (tracksRes as { status?: number }).status === 1;
      const hasPayload = 'data' in tracksRes || 'info' in tracksRes;
      if (statusOk || hasPayload) {
        const payload =
          'data' in tracksRes
            ? (tracksRes as { data?: unknown }).data
            : 'info' in tracksRes
              ? (tracksRes as { info?: unknown }).info
              : tracksRes;
        const { songs: parsedSongs, filteredCount } = parsePlaylistTracks(payload ?? tracksRes);
        songs.value = parsedSongs;
        loadedSongCount.value = parsedSongs.length;
        playlistFilteredInvalidCount.value = filteredCount;
      }
    }

    const targetTotal = playlistMeta?.count ?? 0;
    if (songs.value.length > 0 && targetTotal > songs.value.length) {
      void fetchAllPlaylistTracks(queryId, targetTotal);
    }
  } catch (e) {
    console.error('Fetch playlist error:', e);
  } finally {
    loading.value = false;
  }
};

const fetchAllPlaylistTracks = async (
  queryId: string,
  totalCount: number,
) => {
  const pageSize = 200;
  const seenIds = new Set(songs.value.map((song) => song.id));
  let page = 2;
  let bufferedSongs = [...songs.value];

  try {
    while (bufferedSongs.length < totalCount) {
      const res = await getPlaylistTracks(queryId, page, pageSize);

      if (!res || typeof res !== 'object') break;
      const hasStatus = 'status' in res;
      const statusOk = hasStatus && (res as { status?: number }).status === 1;
      const hasPayload = 'data' in res || 'info' in res;
      if (!statusOk && !hasPayload) break;

      const payload =
        'data' in res
          ? (res as { data?: unknown }).data
          : 'info' in res
            ? (res as { info?: unknown }).info
            : res;
      const { songs: parsedSongs, filteredCount } = parsePlaylistTracks(payload ?? res);
      playlistFilteredInvalidCount.value += filteredCount;
      const nextSongs = parsedSongs.filter((song) => {
        if (seenIds.has(song.id)) return false;
        seenIds.add(song.id);
        return true;
      });

      if (nextSongs.length === 0) break;
      bufferedSongs = [...bufferedSongs, ...nextSongs];
      loadedSongCount.value = bufferedSongs.length;
      page += 1;
    }
    songs.value = bufferedSongs;
  } catch {
    toastStore.loadFailed('歌单歌曲');
  }
};

onMounted(fetchData);
watch(
  () => route.params.id,
  () => {
    playlist.value = null;
    songs.value = [];
    loadedSongCount.value = 0;
    playlistFilteredInvalidCount.value = 0;
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

  if (!isOwnerPlaylist.value) {
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
  await replaceQueueAndPlay(
    playlistStore,
    playerStore,
    songs.value,
    playlistFilteredInvalidCount.value,
    song,
  );
};

const handlePlayAll = async () => {
  if (songs.value.length === 0) return;
  await replaceQueueAndPlay(
    playlistStore,
    playerStore,
    songs.value,
    playlistFilteredInvalidCount.value,
  );
};
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};
const handleLocate = () => songListRef.value?.scrollToActive?.();

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const openCommentPageWithFloor = (comment: Comment) => {
  if (!playlist.value) return;
  void router.push({
    name: 'comment',
    params: { id: getPlaylistId() },
    query: {
      type: 'playlist',
      title: playlist.value.name,
      cover: playlist.value.pic,
      artist: playlist.value.nickname || '',
      floorSpecialId: comment.specialId || '',
      floorTid: comment.tid || String(comment.id),
      floorCode: comment.code || '',
      floorMixSongId: comment.mixSongId || '',
      floorCommentId: String(comment.id),
      floorUserName: comment.userName,
      floorAvatar: comment.avatar,
      floorContent: comment.content,
      floorTime: comment.time,
      floorLikeCount: String(comment.likeCount),
      floorReplyCount: String(comment.replyCount ?? 0),
      floorIsHot: comment.isHot ? '1' : '0',
      floorIsStar: comment.isStar ? '1' : '0',
    },
  });
};

const sortedSongs = computed(() => {
  const data = songs.value;
  if (!sortField.value || !sortOrder.value || data.length === 0) return data;
  if (sortField.value === 'index') {
    return sortOrder.value === 'asc' ? data : [...data].reverse();
  }

  const direction = sortOrder.value === 'asc' ? 1 : -1;
  const compareText = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
    
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
</script>

<template>
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
                >{{
                  formatDate(playlist.publishDate || playlist.createTime, 'YYYY-MM-DD')
                }}
                创建</span
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
                    <Button variant="unstyled" size="none" class="song-filter-info-btn rounded-lg">
                      <Icon :icon="iconInfo" width="14" height="14" />
                    </Button>
                  </template>
                  <span class="block whitespace-pre-line"
                    >当前列表已过滤 {{ playlistFilteredInvalidCount }} 首无效歌曲</span
                  >
                  <span class="block whitespace-pre-line">通常是因为歌曲信息缺失无法参与播放</span>
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

      <BatchActionDrawer
        v-model:open="showBatchDrawer"
        :songs="songs"
        :source-id="playlist?.listid || playlist?.id"
      />

      <div v-if="playlist.intro" class="px-6 pt-[6px] pb-[6px]">
        <div class="text-[15px] font-semibold text-text-main">歌单介绍</div>
        <div class="mt-[6px] text-[12px] leading-relaxed text-text-secondary line-clamp-1">
          {{ playlist.intro }}
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
              :loading="loading"
              :active="activeTab === 'songs'"
              :searchQuery="searchQuery"
              :activeId="activeSongId"
              :showCover="true"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
              "
              :parentPlaylistId="playlist.listid || playlist.id"
              :enableRemoveFromPlaylist="isOwnerPlaylist"
            />
          </TabsContent>

          <TabsContent value="comments" class="px-6 pt-5 pb-10">
            <div class="max-w-4xl mx-auto">
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
        :title="'歌单介绍'"
        :description="playlist.intro"
        contentClass="max-w-[720px]"
        descriptionClass="text-[13px]"
        showClose
      />
    </template>
  </div>
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
  background: var(--color-bg-card);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.12);
  z-index: 150;
}

:deep(.song-list) {
  @apply px-0;
}
</style>
