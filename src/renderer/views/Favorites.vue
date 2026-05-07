<script setup lang="ts">
defineOptions({ name: 'favorites' });
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { getUserFollow, getUserVideoCollect } from '@/api/user';
import { mapArtistMeta } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { ArtistMeta } from '@/models/artist';
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
import BackToTop from '@/components/ui/BackToTop.vue';
import Button from '@/components/ui/Button.vue';
import { iconCurrentLocation, iconHeart, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const isLoggedIn = computed(() => userStore.isLoggedIn);
const activeTab = ref('songs');

// ========== 歌曲 Tab ==========
const songs = computed(() => playlistStore.favorites);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

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
  if (songs.value.length === 0) return;
  const queueOpts = {
    queueId: 'queue:favorites',
    title: '我最喜爱',
    subtitle: '收藏歌曲',
    type: 'playlist' as const,
  };
  // 先用已加载的歌曲开始播放
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, undefined, queueOpts);
  // 后台等待全部加载完，静默更新播放队列
  const allSongs = await playlistStore.waitForFavoritesLoaded();
  if (allSongs.length > songs.value.length) {
    playlistStore.setPlaybackQueueWithOptions(allSongs.slice() as Song[], 0, queueOpts);
  }
};

const handleSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song, {
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
const followedSingers = shallowRef<ArtistMeta[]>([]);
const followedUsers = shallowRef<ArtistMeta[]>([]);
const followedLoading = ref(false);
const followedLoaded = ref(false);

const singerCards = computed(() =>
  followedSingers.value.map((artist) => ({
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
const favoritedAlbums = computed(() =>
  playlistStore.userPlaylists.filter((playlist) => playlist.source === 2),
);

const albumCards = computed(() =>
  favoritedAlbums.value.map((album) => ({
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
const LOAD_MORE_THRESHOLD = 240;
let scrollTarget: HTMLElement | null = null;

const handleScroll = () => {
  if (!scrollTarget) return;
  const distanceToBottom =
    scrollTarget.scrollHeight - scrollTarget.scrollTop - scrollTarget.clientHeight;
  if (distanceToBottom < LOAD_MORE_THRESHOLD) {
    if (
      activeTab.value === 'videos' &&
      videosLoaded.value &&
      !videosLoading.value &&
      videosHasMore.value
    ) {
      void fetchVideos();
    }
  }
};

const attachScrollTarget = async () => {
  await nextTick();
  scrollTarget = document.querySelector('.view-port') as HTMLElement | null;
  if (scrollTarget) {
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
  }
};

const detachScrollTarget = () => {
  if (scrollTarget) {
    scrollTarget.removeEventListener('scroll', handleScroll);
    scrollTarget = null;
  }
};

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
  await attachScrollTarget();
});

onUnmounted(() => {
  detachScrollTarget();
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
  <div class="favorites-view bg-bg-main min-h-full pb-10">
    <!-- 未登录状态 -->
    <div
      v-if="!isLoggedIn"
      class="flex flex-col items-center justify-center min-h-[420px] text-center px-6"
    >
      <div
        class="w-18 h-18 rounded-[24px] bg-primary/10 text-primary flex items-center justify-center mb-5"
      >
        <Icon :icon="iconHeart" width="32" height="32" />
      </div>
      <div class="text-[22px] font-semibold text-text-main">登录后查看我最喜爱</div>
    </div>

    <!-- 已登录 -->
    <template v-else>
      <!-- 吸顶头部卡片 -->
      <div class="favorites-header sticky top-0 z-[120] bg-bg-main">
        <div class="px-6 py-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div
              class="w-10 h-10 rounded-[14px] bg-primary/10 text-primary flex items-center justify-center"
            >
              <Icon :icon="iconHeart" width="20" height="20" />
            </div>
            <div class="text-[20px] font-semibold text-text-main tracking-tight">我最喜爱</div>
          </div>
          <div v-if="activeTab === 'songs'" class="overflow-x-auto">
            <ActionRow @play="handlePlayAll" @batch="openBatchDrawer" />
          </div>
        </div>
      </div>

      <Tabs :model-value="activeTab" class="w-full" @update:model-value="handleTabChange">
        <!-- Sticky Tabs -->
        <div class="song-list-sticky sticky top-[64px] z-[110] bg-bg-main">
          <div class="px-6 border-b border-border-light/10">
            <div class="flex items-center justify-between h-14">
              <TabsList class="bg-transparent border-none gap-8">
                <TabsTrigger value="songs">
                  <span class="relative">歌曲 <Badge :count="songs.length" /></span>
                </TabsTrigger>
                <TabsTrigger value="singers">
                  <span class="relative"
                    >歌手 <Badge v-if="followedSingers.length > 0" :count="followedSingers.length"
                  /></span>
                </TabsTrigger>
                <TabsTrigger value="users">
                  <span class="relative"
                    >用户 <Badge v-if="followedUsers.length > 0" :count="followedUsers.length"
                  /></span>
                </TabsTrigger>
                <TabsTrigger value="albums">
                  <span class="relative"
                    >专辑 <Badge v-if="favoritedAlbums.length > 0" :count="favoritedAlbums.length"
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
                    class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg bg-white border border-black/30 shadow-sm text-text-main placeholder:text-text-main/50 dark:bg-white/[0.08] dark:border-white/10 dark:shadow-none outline-none text-[12px] transition-all"
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
              :songs="sortedSongs"
              :loading="false"
              :active="activeTab === 'songs'"
              :searchQuery="searchQuery"
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
              :itemHeight="218"
              :gap="20"
              :overscan="3"
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
              :itemHeight="218"
              :gap="20"
              :overscan="3"
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
              v-if="videosLoading && videosLoaded"
              class="flex justify-center py-6 text-[12px] text-text-secondary"
            >
              加载更多中...
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

    <BackToTop target-selector=".view-port" />
  </div>
</template>

<style scoped>
@reference "@/style.css";

.favorites-header {
  border-bottom: 0.5px solid color-mix(in srgb, var(--color-border-light) 60%, transparent);
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
