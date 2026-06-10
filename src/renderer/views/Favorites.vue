<script setup lang="ts">
defineOptions({ name: 'favorites' });
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { useThemeStore } from '@/stores/theme';
import { getUserFollow, getUserVideoCollect } from '@/api/user';
import { mapArtistMeta } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { ArtistMeta } from '@/models/artist';
import { getAccentGradientPair } from '@/utils/color';
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
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import ArtistCard from '@/components/music/ArtistCard.vue';
import MvCard from '@/components/music/MvCard.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Button from '@/components/ui/Button.vue';
import { useScrollContainer } from '@/composables/usePageScroll';
import { iconCurrentLocation, iconHeart, iconList, iconPlay, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const themeStore = useThemeStore();

const isLoggedIn = computed(() => userStore.isLoggedIn);
const activeTab = ref('songs');
const sliverHeaderRef = ref<InstanceType<typeof SliverHeader> | null>(null);
const tabsTop = computed(() => sliverHeaderRef.value?.currentHeight || 56);

// ========== 歌曲 Tab ==========
const songs = computed(() => playlistStore.favorites);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const favoriteCoverUrl = computed(() => {
  const { from, to } = getAccentGradientPair(themeStore.sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}" />
          <stop offset="100%" stop-color="${to}" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <circle cx="104" cy="96" r="52" fill="#FFFFFF" opacity="0.14" />
      <circle cx="308" cy="304" r="72" fill="#FFFFFF" opacity="0.10" />
      <g transform="translate(200 196)">
        <rect x="-92" y="-92" width="184" height="184" rx="46" fill="#FFFFFF" opacity="0.18" />
        <g transform="translate(-84 -84) scale(7)" color="#FFFFFF">
          ${iconHeart.body}
        </g>
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
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
    subtitle: '收藏歌曲',
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
    subtitle: '收藏歌曲',
    type: 'playlist',
  });
};

const handleLocate = () => songListRef.value?.scrollToActive?.();
const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

// ========== 关注 Tab ==========
const singerSearchQuery = ref('');
const followedSingers = shallowRef<ArtistMeta[]>([]);
const followedUsers = shallowRef<ArtistMeta[]>([]);
const followedLoading = ref(false);
const followedLoaded = ref(false);

const filteredSingers = computed(() => {
  const query = singerSearchQuery.value.trim().toLowerCase();
  if (!query) return followedSingers.value;
  return followedSingers.value.filter((artist) => {
    const name = artist.name?.toLowerCase() || '';
    return name.includes(query);
  });
});

const singerCards = computed(() =>
  filteredSingers.value.map((artist) => ({
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
  followedUsers.value.map((artist) => ({
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
  if (followedLoaded.value || followedLoading.value) return;
  followedLoading.value = true;
  try {
    const res = await getUserFollow();
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
    toastStore.loadFailed('关注列表');
  } finally {
    followedLoading.value = false;
  }
};
// ========== 专辑 Tab ==========
const albumSearchQuery = ref('');

const favoritedAlbums = computed(() =>
  playlistStore.userPlaylists.filter((playlist) => playlist.source === 2),
);

const filteredAlbums = computed(() => {
  const query = albumSearchQuery.value.trim().toLowerCase();
  if (!query) return favoritedAlbums.value;
  return favoritedAlbums.value.filter((album) => {
    const name = album.name?.toLowerCase() || '';
    const artist = album.nickname?.toLowerCase() || album.list_create_username?.toLowerCase() || '';
    return name.includes(query) || artist.includes(query);
  });
});

const albumCards = computed(() =>
  filteredAlbums.value.map((album) => ({
    id: String(album.listCreateListid ?? album.id),
    name: album.name,
    coverUrl: album.pic,
    artist: album.nickname || album.list_create_username || '',
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
const videosLoading = ref(false);
const videosLoaded = ref(false);
const videosPage = ref(1);
const videosHasMore = ref(true);
const VIDEOS_PAGE_SIZE = 30;

const fetchVideos = async (reset = false) => {
  if (videosLoading.value) return;
  if (!reset && !videosHasMore.value) return;
  if (reset) {
    videosPage.value = 1;
    videosHasMore.value = true;
  }
  videosLoading.value = true;
  try {
    const res = await getUserVideoCollect(videosPage.value, VIDEOS_PAGE_SIZE);
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
      videosPage.value += 1;
      videosLoaded.value = true;
    }
  } catch {
    toastStore.loadFailed('收藏视频');
    videosHasMore.value = false;
  } finally {
    videosLoading.value = false;
  }
};

// ========== 滚动加载 ==========
const scrollContainerRef = useScrollContainer();
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
const handleTabChange = (value: string | number) => {
  activeTab.value = String(value);
  if ((value === 'singers' || value === 'users') && !followedLoaded.value) {
    void fetchFollowed();
  }
  if (value === 'videos' && !videosLoaded.value) {
    void fetchVideos(true);
  }
};

// ========== 生命周期 ==========
onMounted(async () => {
  if (isLoggedIn.value) {
    // 确保收藏歌曲已加载
    if (playlistStore.favorites.length === 0) {
      void playlistStore.fetchLikedPlaylistSongs();
    }
  }
  await nextTick();
  setupLoadMoreObserver();
});

onUnmounted(() => {
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
});

watch(isLoggedIn, (value) => {
  if (value) {
    void playlistStore.fetchLikedPlaylistSongs();
    followedLoaded.value = false;
    videosLoaded.value = false;
  }
});
</script>

<template>
  <PageScrollContainer class="favorites-view">
    <div class="bg-bg-main min-h-full pb-10">
      <!-- 未登录状态 -->
      <div
        v-if="!isLoggedIn"
        class="flex flex-col items-center justify-center min-h-105 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5"
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
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="text-[13px] font-semibold text-text-secondary">
                收藏的歌曲、歌手、用户、专辑与视频
              </div>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
              >
                <div class="inline-flex items-center gap-1.5">
                  <Icon :icon="iconHeart" width="12" height="12" />
                  <span>{{ songs.length }} 首歌曲</span>
                </div>
                <span v-if="followedSingers.length > 0">{{ followedSingers.length }} 位歌手</span>
                <span v-if="favoritedAlbums.length > 0">{{ favoritedAlbums.length }} 张专辑</span>
                <span v-if="videos.length > 0">{{ videos.length }} 个视频</span>
              </div>
            </div>
          </template>

          <template #actions>
            <ActionRow
              v-if="activeTab === 'songs'"
              @play="handlePlayAll"
              @batch="openBatchDrawer"
            />
          </template>

          <template #collapsed-actions>
            <template v-if="activeTab === 'songs'">
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
          </template>
        </SliverHeader>

        <Tabs :model-value="activeTab" class="w-full" @update:model-value="handleTabChange">
          <!-- Sticky Tabs -->
          <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
            <div class="px-6 border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="favorites-tab-list bg-transparent border-none gap-8">
                  <TabsTrigger value="songs">
                    <span class="relative">歌曲 <Badge :count="songs.length" /></span>
                  </TabsTrigger>
                  <TabsTrigger value="singers">
                    <span class="relative"
                      >歌手
                      <Badge v-if="followedSingers.length > 0" :count="followedSingers.length"
                    /></span>
                  </TabsTrigger>
                  <TabsTrigger value="users">
                    <span class="relative"
                      >用户 <Badge v-if="followedUsers.length > 0" :count="followedUsers.length"
                    /></span>
                  </TabsTrigger>
                  <TabsTrigger value="albums">
                    <span class="relative"
                      >专辑
                      <Badge v-if="favoritedAlbums.length > 0" :count="favoritedAlbums.length"
                    /></span>
                  </TabsTrigger>
                  <TabsTrigger value="videos">
                    <span class="relative"
                      >视频 <Badge v-if="videos.length > 0" :count="videos.length"
                    /></span>
                  </TabsTrigger>
                </TabsList>

                <!-- 歌曲 tab 右侧操作 -->
                <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="searchQuery"
                      type="text"
                      placeholder="搜索歌曲..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
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

                <!-- 歌手 tab 右侧搜索 -->
                <div v-if="activeTab === 'singers'" class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="singerSearchQuery"
                      type="text"
                      placeholder="搜索歌手..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
                  </div>
                </div>

                <!-- 专辑 tab 右侧搜索 -->
                <div v-if="activeTab === 'albums'" class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="albumSearchQuery"
                      type="text"
                      placeholder="搜索专辑..."
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
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
          </div>

          <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="favorites" />

          <div class="pb-12">
            <!-- 歌曲 -->
            <TabsContent value="songs" class="px-6">
              <SongList
                ref="songListRef"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :loading="false"
                :active="activeTab === 'songs'"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: 'queue:favorites',
                  title: '我最喜爱',
                  subtitle: '收藏歌曲',
                  type: 'playlist',
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
                "
                rowPaddingClass="px-0"
              />
            </TabsContent>

            <!-- 歌手 -->
            <TabsContent value="singers" class="px-6 pt-4">
              <VirtualGrid
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
                  <ArtistCard v-bind="item" />
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 用户 -->
            <TabsContent value="users" class="px-6 pt-4">
              <VirtualGrid
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
                  <ArtistCard v-bind="item" />
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 专辑 -->
            <TabsContent value="albums" class="px-6 pt-4">
              <VirtualGrid
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
                  <AlbumCard v-bind="item" />
                </template>
              </VirtualGrid>
            </TabsContent>

            <!-- 视频 -->
            <TabsContent value="videos" class="px-6 pt-4">
              <VirtualGrid
                :items="videos"
                :loading="videosLoading && !videosLoaded"
                :active="activeTab === 'videos'"
                :itemMinWidth="260"
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
                  <MvCard
                    :videoId="item.id"
                    :hash="item.hash"
                    :title="item.title"
                    :coverUrl="item.coverUrl"
                    :artist="item.artist"
                    :duration="item.duration"
                    :albumAudioId="item.albumAudioId"
                  />
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
                class="flex justify-center py-6 text-[12px] text-text-secondary opacity-60"
              >
                没有更多了
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.favorites-tab-list :deep(.tab-trigger) {
  font-size: 14px;
  font-weight: 600;
}

.song-locate-btn {
  color: var(--color-text-main);
  opacity: 0.6;
  transition: all 0.2s ease;
}

.song-locate-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}
</style>
