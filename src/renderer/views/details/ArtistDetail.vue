<script setup lang="ts">
import { ref, shallowRef, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getArtistDetail,
  getArtistSongs,
  getArtistAlbums,
  followArtist,
  unfollowArtist,
} from '@/api/artist';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { mapAlbumMeta, mapArtistDetailMeta, mapArtistSong } from '@/utils/mappers';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconCurrentLocation,
  iconSearch,
  iconPlay,
  iconList,
  iconHeart,
  iconHeartFilled,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import { extractFirstObject, extractList } from '@/utils/extractors';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const route = useRoute();
const router = useRouter();
const getArtistId = () =>
  String(Array.isArray(route.params.id) ? (route.params.id[0] ?? '') : (route.params.id ?? ''));

const loading = ref(true);
const loadingSongs = ref(true);
const loadingAlbums = ref(true);
const artist = ref<ReturnType<typeof mapArtistDetailMeta> | null>(null);

// 使用 shallowRef 避免对成千上万个歌曲对象进行深层响应式代理，极大提升性能
const songs = shallowRef<Song[]>([]);
const albums = shallowRef<ReturnType<typeof mapAlbumMeta>[]>([]);

const activeTab = ref('songs');
const loadedSongCount = ref(0);
const loadedAlbumCount = computed(() => albums.value.length);
const showBatchDrawer = ref(false);
const showIntroDialog = ref(false);
const togglingFollow = ref(false);

const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);

const tabsTop = computed(() => {
  const headerHeight = sliverHeaderRef.value?.currentHeight || 52;
  return headerHeight;
});

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

  // 仅在需要排序时创建副本
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

const fetchAllArtistSongs = async (totalCount: number) => {
  if (songs.value.length >= totalCount) return;
  const artistId = getArtistId();
  const pageSize = 200;
  const seenIds = new Set(songs.value.map((song) => song.id));
  let page = 2;

  let bufferedSongs = [...songs.value];

  try {
    while (bufferedSongs.length < totalCount) {
      const res = await getArtistSongs(artistId, page, pageSize, 'hot');
      const nextSongs = extractList(res).map((item) => mapArtistSong(artistId, item));
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
    toastStore.loadFailed('歌手歌曲');
  }
};

const fetchData = async () => {
  const artistId = getArtistId();
  loading.value = true;
  loadingSongs.value = true;
  loadingAlbums.value = true;

  // 1. 获取歌手详情
  const detailTask = getArtistDetail(artistId)
    .then((res) => {
      const detailRaw = extractFirstObject(res);
      if (detailRaw) {
        artist.value = mapArtistDetailMeta(detailRaw);
      }
      loading.value = false;
    })
    .catch(() => {
      loading.value = false;
    });

  // 2. 获取歌曲列表
  const songsTask = getArtistSongs(artistId, 1, 200, 'hot')
    .then((res) => {
      const fetched = extractList(res).map((item) => mapArtistSong(artistId, item));
      songs.value = fetched;
      loadedSongCount.value = fetched.length;
      loadingSongs.value = false;

      const totalSongs = artist.value?.songCount ?? fetched.length;
      if (totalSongs > fetched.length) {
        void fetchAllArtistSongs(totalSongs);
      }
    })
    .catch(() => {
      loadingSongs.value = false;
    });

  // 3. 获取专辑列表
  const albumsTask = getArtistAlbums(artistId, 1, 30, 'hot')
    .then((res) => {
      const fetched = extractList(res).map((item) => mapAlbumMeta(item));
      albums.value = fetched;
      loadingAlbums.value = false;
    })
    .catch(() => {
      loadingAlbums.value = false;
    });

  await Promise.allSettled([detailTask, songsTask, albumsTask]);
};

watch(
  () => route.params.id,
  () => {
    artist.value = null;
    songs.value = [];
    albums.value = [];
    loadedSongCount.value = 0;
    searchQuery.value = '';
    sortField.value = null;
    sortOrder.value = null;
    activeTab.value = 'songs';
    void fetchData();
  },
);

const isFollowed = computed(() => artist.value?.isFollowed === true);

const isRequestSuccessful = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.status === 1 || record.code === 200 || record.error_code === 0;
};

const toggleArtistFollow = async () => {
  if (!artist.value || togglingFollow.value) return;

  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('关注歌手');
    await router.push({ name: 'login' });
    return;
  }

  togglingFollow.value = true;
  const previousFollowed = artist.value.isFollowed === true;

  try {
    const response = previousFollowed
      ? await unfollowArtist(artist.value.id)
      : await followArtist(artist.value.id);

    if (isRequestSuccessful(response)) {
      artist.value = {
        ...artist.value,
        isFollowed: !previousFollowed,
      };
      if (previousFollowed) {
        toastStore.actionCompleted('取消关注');
      } else {
        toastStore.actionSucceeded('关注');
      }
    } else {
      toastStore.actionFailed(previousFollowed ? '取消关注' : '关注');
    }
  } catch (error) {
    toastStore.actionFailed(previousFollowed ? '取消关注' : '关注');
  } finally {
    togglingFollow.value = false;
  }
};

const secondaryActions = computed(() => {
  if (!artist.value) return [];

  return [
    {
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

onMounted(() => {
  void fetchData();
});
</script>

<template>
  <div class="artist-detail-container bg-bg-main min-h-full">
    <div v-if="loading && !artist" class="flex items-center justify-center py-40">
      <div
        class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
      ></div>
    </div>

    <template v-else-if="artist">
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="ARTIST"
        :title="artist.name"
        :coverUrl="artist.pic"
        :hasDetails="false"
        :expandedHeight="176"
      >
        <template #details>
          <div class="flex flex-col gap-1 text-text-main/60">
            <div class="text-[13px] font-semibold text-primary">
              {{ artist.songCount || songs.length }} 歌曲 •
              {{ artist.albumCount || albums.length }} 专辑
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
            @click="toggleArtistFollow"
            class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-red-500"
          >
            <Icon :icon="isFollowed ? iconHeartFilled : iconHeart" width="18" height="18" />
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

      <div v-if="artist.intro" class="px-6 pt-[6px] pb-[6px]">
        <div class="text-[15px] font-semibold text-text-main">歌手介绍</div>
        <div class="mt-[6px] text-[12px] leading-relaxed text-text-secondary line-clamp-1">
          {{ artist.intro }}
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

      <Tabs v-model="activeTab" class="w-full">
        <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: `${tabsTop}px` }">
          <div class="px-6 border-b border-border-light/10">
            <div class="flex items-center justify-between h-14">
              <TabsList class="bg-transparent border-none gap-8">
                <TabsTrigger value="songs">
                  <span class="relative">歌曲 <Badge :count="loadedSongCount" /></span>
                </TabsTrigger>
                <TabsTrigger value="albums">
                  <span class="relative">专辑 <Badge :count="loadedAlbumCount" /></span>
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
              :searchQuery="searchQuery"
              :loading="loadingSongs"
              :active="activeTab === 'songs'"
              :showCover="true"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
              "
            />
          </TabsContent>

          <TabsContent value="albums" class="mt-4 px-6">
            <div
              v-if="loadingAlbums && albums.length === 0"
              class="flex items-center justify-center py-20"
            >
              <div
                class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"
              ></div>
            </div>
            <div v-else class="artist-album-grid px-2">
              <AlbumCard
                v-for="albumItem in albums"
                :key="albumItem.id"
                :id="albumItem.id"
                :name="albumItem.name"
                :coverUrl="albumItem.pic"
                :artist="albumItem.singerName"
                :publishTime="albumItem.publishTime"
              />
            </div>
          </TabsContent>
        </div>
      </Tabs>
      <Dialog
        v-model:open="showIntroDialog"
        title="歌手介绍"
        :description="artist.intro"
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

:deep(.song-list) {
  @apply px-0;
}
.artist-album-grid {
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.artist-album-grid :deep(.card-container) {
  height: 230px;
}

.artist-album-grid :deep(.cover-wrapper) {
  height: 170px;
  aspect-ratio: auto;
}
</style>
