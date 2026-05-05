<script setup lang="ts">
defineOptions({ name: 'album-detail' });
import { ref, shallowRef, onMounted, onBeforeUnmount, computed } from 'vue';
import { extractFirstObject, extractList } from '@/utils/extractors';
import { useRoute, useRouter } from 'vue-router';
import { useRouteId } from '@/utils/useRouteId';
import {
  getAlbumDetail,
  getAlbumSongs,
  favoriteAlbum as favoriteAlbumApi,
  unfavoriteAlbum as unfavoriteAlbumApi,
} from '@/api/album';
import { getAlbumComments } from '@/api/comment';
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
import {
  iconCurrentLocation,
  iconSearch,
  iconPlay,
  iconList,
  iconHeart,
  iconHeartFilled,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { isRecord, toRecord } from '../../../shared/object';
import { PagedSongLoader } from '@/utils/PagedSongLoader';

const parseIntSafe = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const route = useRoute();
const router = useRouter();
const { id: currentId, onIdChange } = useRouteId();
const getAlbumId = () => currentId.value;

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
      hasMoreComments.value =
        mapped.length > 0 &&
        (totalValue > 0 ? comments.value.length < totalValue : mapped.length >= 30);

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

// 歌曲分页加载器
let songLoader: PagedSongLoader<Song> | null = null;

const handleTabChange = (value: string | number) => {
  activeTab.value = String(value);
  if (value === 'comments' && comments.value.length === 0) {
    fetchComments(true);
  }
};

// 滚动加载更多评论
const maybeFetchMoreComments = () => {
  if (activeTab.value !== 'comments') return;
  if (loadingComments.value || !hasMoreComments.value) return;

  const scrollTop =
    window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const fullHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;

  // 距离底部 400px 时触发加载
  if (fullHeight - scrollTop - viewportHeight <= 400) {
    fetchComments();
  }
};

const fetchData = async () => {
  loading.value = true;
  loadingSongs.value = true;
  const albumId = getAlbumId();

  // 1. 先获取专辑详情
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

  // 2. 中止上一次加载
  if (songLoader) {
    songLoader.abort();
  }

  // 3. 创建加载器获取歌曲
  songLoader = new PagedSongLoader<Song>(
    async (page, pageSize) => {
      const res = await getAlbumSongs(albumId, page, pageSize);
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
        songs.value = allItems.slice();
        loadedSongCount.value = allItems.length;
      },
      onComplete(allItems) {
        songs.value = allItems.slice();
        loadedSongCount.value = allItems.length;
      },
      onError() {
        toastStore.loadFailed('专辑歌曲');
      },
    },
  );

  const songsTask = songLoader
    .loadFirstPage()
    .then(() => {
      loadingSongs.value = false;
      // 首页加载完后，只要还有更多数据就继续加载剩余页
      if (!songLoader!.fullyLoaded) {
        void songLoader!.loadRemaining();
      }
    })
    .catch((e) => {
      console.error('Fetch album songs error:', e);
      loadingSongs.value = false;
    });

  await Promise.allSettled([detailTask, songsTask]);
};

onMounted(() => {
  fetchData();
  window.addEventListener('scroll', maybeFetchMoreComments, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', maybeFetchMoreComments);
});

// id 变化时重置数据（仅同路由间切换，如专辑A→专辑B）
onIdChange(() => {
  album.value = null;
  albumArtists.value = [];
  songs.value = [];
  loadedSongCount.value = 0;
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
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song, {
    queueId: `queue:album:${album.value?.id ?? getAlbumId()}`,
    title: album.value?.name || '专辑',
    subtitle: album.value?.singerName || '',
    type: 'album',
  });
};

const handlePlayAll = async () => {
  if (songs.value.length === 0) return;
  const queueOpts = {
    queueId: `queue:album:${album.value?.id ?? getAlbumId()}`,
    title: album.value?.name || '专辑',
    subtitle: album.value?.singerName || '',
    type: 'album' as const,
  };
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, undefined, queueOpts);
  // 后台等待全部加载完，静默更新播放队列
  if (songLoader && !songLoader.fullyLoaded) {
    const allSongs = await songLoader.waitForAll();
    if (allSongs.length > songs.value.length) {
      playlistStore.setPlaybackQueueWithOptions(allSongs.slice() as Song[], 0, queueOpts);
    }
  }
};
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};
const handleLocate = () => songListRef.value?.scrollToActive?.();

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
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
        :hasDetails="true"
        :expandedHeight="196"
      >
        <template #details>
          <div class="flex flex-col gap-1.5 text-text-main/60">
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
            @play="handlePlayAll"
            @batch="openBatchDrawer"
          />
        </template>

        <template #collapsed-actions>
          <Button
            v-if="userStore.isLoggedIn"
            variant="unstyled"
            size="none"
            @click="toggleFavoriteAlbum"
            class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-red-500"
          >
            <Icon :icon="isFavoriteAlbum ? iconHeartFilled : iconHeart" width="18" height="18" />
          </Button>
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
              :queueOptions="{
                queueId: `queue:album:${album?.id ?? getAlbumId()}`,
                title: album?.albumname || '专辑',
                subtitle: album?.singerName || '',
                type: 'album',
              }"
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
                resourceType="album"
                :fallbackMixSongId="String(currentId)"
                compact
                hide-empty
              />
              <CommentList
                :comments="comments"
                :loading="loadingComments"
                :total="commentTotal"
                resourceType="album"
                :fallbackMixSongId="String(currentId)"
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
        contentClass="detail-intro-dialog max-w-[720px]"
        descriptionClass="text-[13px]"
        showClose
      />
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
