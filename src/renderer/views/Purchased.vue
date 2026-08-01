<script setup lang="ts">
defineOptions({ name: 'purchased' });
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { getPurchasedSongs, getPurchasedAlbum } from '@/api/purchased';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useThemeStore } from '@/stores/theme';
import { createThemedIconCoverUrl } from '@/utils/cover';
import type { AlbumMeta } from '@/models/album';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import VirtualGrid from '@/components/ui/VirtualGrid.vue';
import AlbumCard from '@/components/music/AlbumCard.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Badge from '@/components/ui/Badge.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import Button from '@/components/ui/Button.vue';
import { iconCurrentLocation, iconList, iconPlay, iconSearch, iconShoppingBag } from '@/icons';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const PAGE_SIZE = 30;

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const themeStore = useThemeStore();

const activeTab = ref('songs');
const sliverHeaderRef = ref<InstanceType<typeof SliverHeader> | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);

const isLoggedIn = computed(() => userStore.isLoggedIn);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const searchQuery = ref('');
const albumSearchQuery = ref('');
const showBatchDrawer = ref(false);

const songs = shallowRef<Song[]>([]);
const albums = shallowRef<AlbumMeta[]>([]);
const songsLoading = ref(false);
const albumsLoading = ref(false);
const songsHasMore = ref(false);
const albumsHasMore = ref(false);
const songsPage = ref(1);
const albumsPage = ref(1);
const totalSongs = ref(0);
const totalAlbums = ref(0);
const songsLoadingMore = ref(false);
const albumsLoadingMore = ref(false);

const coverUrl = computed(() => createThemedIconCoverUrl(themeStore.sourceColor, iconShoppingBag));

const parsePurchasedSongList = (payload: unknown): { songs: Song[]; total: number } => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record;
  const total = Number(data.total ?? 0);
  const rawList = Array.isArray(data.goods) ? data.goods : [];
  const songs = rawList
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const audioInfo =
        item.audio_info && typeof item.audio_info === 'object'
          ? (item.audio_info as Record<string, unknown>)
          : {};
      const hash = String(
        audioInfo.hash_high ||
          audioInfo.hash_flac ||
          audioInfo.hash_320 ||
          audioInfo.hash_128 ||
          item.hash ||
          '',
      );
      const durationMs = Number(audioInfo.duration || 0);
      const duration = durationMs > 0 ? Math.floor(durationMs / 1000) : 0;
      const artist = String(item.author_name || '');
      const title = String(item.songname || '');
      return {
        id: String(item.album_audio_id || item.good_scid || hash || ''),
        title,
        name: title,
        artist,
        artists: artist ? [{ name: artist }] : [],
        singers: artist ? [{ name: artist }] : [],
        album: String(audioInfo.album_name || ''),
        albumName: String(audioInfo.album_name || ''),
        albumId: String(audioInfo.album_id || item.album_id || ''),
        coverUrl: String(item.album_cover || '').replace('{size}', '400'),
        duration,
        hash,
        mixSongId: Number(item.album_audio_id || item.good_scid || 0),
        audioUrl: '',
      } as Song;
    });
  return { songs, total };
};

const parsePurchasedAlbumList = (payload: unknown): { albums: AlbumMeta[]; total: number } => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record;
  const total = Number(data.total ?? 0);
  const rawList = Array.isArray(data.goods) ? data.goods : [];
  const albums = rawList
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const cover = String(item.cover || '').replace('{size}', '400');
      return {
        id: Number(item.album_id || 0),
        album_id: Number(item.album_id || 0),
        name: String(item.album_name || ''),
        albumname: String(item.album_name || ''),
        pic: cover,
        imgurl: cover,
        sizable_cover: cover,
        singerName: String(item.singer_name || ''),
        singername: String(item.singer_name || ''),
        publishTime: '',
        publishtime: '',
        songCount: 0,
        playCount: 0,
        heat: 0,
        intro: '',
        language: '',
        type: '',
        company: '',
        singerId: 0,
        albumid: Number(item.album_id || 0),
        album_name: String(item.album_name || ''),
      } as AlbumMeta;
    });
  return { albums, total };
};

const loadSongs = async () => {
  if (!isLoggedIn.value) return;
  songsLoading.value = true;
  try {
    const res = await getPurchasedSongs(1, PAGE_SIZE);
    const { songs: parsed, total } = parsePurchasedSongList(res);
    songs.value = parsed;
    songsPage.value = 1;
    totalSongs.value = total;
    songsHasMore.value = songs.value.length < total;
  } catch {
    songs.value = [];
    totalSongs.value = 0;
    songsHasMore.value = false;
  } finally {
    songsLoading.value = false;
  }
};

const loadMoreSongs = async () => {
  if (!isLoggedIn.value || songsLoadingMore.value || !songsHasMore.value) return;
  songsLoadingMore.value = true;
  try {
    const nextPage = songsPage.value + 1;
    const res = await getPurchasedSongs(nextPage, PAGE_SIZE);
    const { songs: parsed } = parsePurchasedSongList(res);
    if (parsed.length > 0) {
      songs.value = [...songs.value, ...parsed];
      songsPage.value = nextPage;
      songsHasMore.value = songs.value.length < totalSongs.value;
    } else {
      songsHasMore.value = false;
    }
  } catch {
    songsHasMore.value = false;
  } finally {
    songsLoadingMore.value = false;
  }
};

const loadAlbums = async () => {
  if (!isLoggedIn.value) return;
  albumsLoading.value = true;
  try {
    const res = await getPurchasedAlbum(1, PAGE_SIZE);
    const { albums: parsed, total } = parsePurchasedAlbumList(res);
    albums.value = parsed;
    albumsPage.value = 1;
    totalAlbums.value = total;
    albumsHasMore.value = albums.value.length < total;
  } catch {
    albums.value = [];
    totalAlbums.value = 0;
    albumsHasMore.value = false;
  } finally {
    albumsLoading.value = false;
  }
};

const loadMoreAlbums = async () => {
  if (!isLoggedIn.value || albumsLoadingMore.value || !albumsHasMore.value) return;
  albumsLoadingMore.value = true;
  try {
    const nextPage = albumsPage.value + 1;
    const res = await getPurchasedAlbum(nextPage, PAGE_SIZE);
    const { albums: parsed } = parsePurchasedAlbumList(res);
    if (parsed.length > 0) {
      albums.value = [...albums.value, ...parsed];
      albumsPage.value = nextPage;
      albumsHasMore.value = albums.value.length < totalAlbums.value;
    } else {
      albumsHasMore.value = false;
    }
  } catch {
    albumsHasMore.value = false;
  } finally {
    albumsLoadingMore.value = false;
  }
};

const handleTabChange = (tab: string | number) => {
  const tabStr = String(tab);
  activeTab.value = tabStr;
  if (tabStr === 'songs' && songs.value.length === 0 && !songsLoading.value) {
    void loadSongs();
  } else if (tabStr === 'albums' && albums.value.length === 0 && !albumsLoading.value) {
    void loadAlbums();
  }
};

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
  return sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  });
});

const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const albumCards = computed(() =>
  albums.value.map((album) => ({
    id: album.id,
    name: album.name || album.albumname || album.album_name || '',
    coverUrl: album.pic || album.imgurl || album.sizable_cover || '',
    artist: album.singerName || album.singername || '',
    publishTime: album.publishTime || album.publishtime || '',
  })),
);

const filteredAlbumCards = computed(() => {
  const query = albumSearchQuery.value.trim().toLowerCase();
  if (!query) return albumCards.value;
  return albumCards.value.filter((card) => {
    const name = card.name.toLowerCase();
    const artist = card.artist.toLowerCase();
    return name.includes(query) || artist.includes(query);
  });
});

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:purchased',
    title: '已购音乐',
    subtitle: '已购单曲',
    type: 'purchased',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: 'queue:purchased',
    title: '已购音乐',
    subtitle: '已购单曲',
    type: 'purchased',
    dynamic: false,
  });
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

watch(
  () => isLoggedIn.value,
  (loggedIn) => {
    if (!loggedIn) {
      songs.value = [];
      albums.value = [];
      totalSongs.value = 0;
      totalAlbums.value = 0;
      songsHasMore.value = false;
      albumsHasMore.value = false;
      songsPage.value = 1;
      albumsPage.value = 1;
    }
  },
);

onMounted(() => {
  if (isLoggedIn.value) {
    void loadSongs();
    void loadAlbums();
  }
});
</script>

<template>
  <PageScrollContainer class="purchased-view-container">
    <div class="purchased-view bg-bg-main min-h-full">
      <div
        v-if="!isLoggedIn"
        class="purchased-login-empty flex flex-col items-center justify-center min-h-105 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5"
        >
          <Icon :icon="iconShoppingBag" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">登录后查看已购音乐</div>
      </div>

      <template v-else>
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="PURCHASED"
          title="已购音乐"
          :coverUrl="coverUrl"
          :hasDetails="true"
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="text-[13px] font-semibold text-text-secondary">
                浏览您已购买的单曲和专辑，随时畅听。
              </div>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
              >
                <div class="inline-flex items-center gap-1.5">
                  <Icon :icon="iconShoppingBag" width="12" height="12" />
                  <span>{{ totalSongs }} 首歌曲</span>
                </div>
                <span v-if="totalAlbums > 0">{{ totalAlbums }} 张专辑</span>
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

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="purchased" />

        <Tabs
          :model-value="activeTab"
          class="w-full"
          :style="{ minHeight: tabsMinHeight }"
          @update:model-value="handleTabChange"
        >
          <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList class="bg-transparent border-none gap-8">
                    <TabsTrigger value="songs">
                      <span class="relative">单曲 <Badge :count="totalSongs" /></span>
                    </TabsTrigger>
                    <TabsTrigger value="albums">
                      <span class="relative">专辑 <Badge :count="totalAlbums" /></span>
                    </TabsTrigger>
                  </TabsList>

                  <div class="flex items-center gap-2">
                    <div class="relative" v-if="activeTab === 'songs'">
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
                    <div v-else-if="activeTab === 'albums'" class="relative">
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
                    <Button
                      v-if="activeTab === 'songs'"
                      variant="unstyled"
                      size="none"
                      @click="handleLocate"
                      class="song-locate-btn p-2 rounded-lg"
                      title="定位当前播放"
                    >
                      <Icon :icon="iconCurrentLocation" width="16" height="16" />
                    </Button>
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
          </div>

          <TabsContent value="songs" class="w-full">
            <div class="px-6 pb-12">
              <div
                v-if="!songsLoading && songs.length === 0"
                class="purchased-empty flex flex-col items-center justify-center py-24 text-center"
              >
                <div
                  class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
                >
                  <Icon :icon="iconShoppingBag" width="28" height="28" />
                </div>
                <div class="text-[18px] font-semibold text-text-main">暂无已购单曲</div>
                <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
                  购买的单曲会展示在这里
                </div>
              </div>
              <SongList
                v-else
                ref="songListRef"
                :loading="songsLoading"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
                :activeId="activeSongId"
                :showCover="true"
                :queueOptions="{
                  queueId: 'queue:purchased',
                  title: '已购音乐',
                  subtitle: '已购单曲',
                  type: 'purchased',
                  dynamic: false,
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
                "
              />
              <div
                v-if="songsHasMore && !songsLoading"
                ref="songsLoadMoreSentinel"
                class="flex justify-center pt-6 pb-4"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="songsLoadingMore"
                  @click="loadMoreSongs"
                >
                  {{ songsLoadingMore ? '加载中...' : '加载更多' }}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="albums" class="w-full px-6 pt-4 pb-12">
            <div
              v-if="!albumsLoading && albums.length === 0"
              class="purchased-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
              >
                <Icon :icon="iconShoppingBag" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">暂无已购专辑</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
                购买的专辑会展示在这里
              </div>
            </div>
            <VirtualGrid
              v-else
              :items="filteredAlbumCards"
              :loading="albumsLoading"
              :active="activeTab === 'albums'"
              :itemMinWidth="180"
              :itemAspectRatio="1"
              :itemChromeHeight="66"
              :gap="20"
              :overscan="3"
              :paddingBottom="20"
              :stateMinHeight="320"
              emptyText="暂无已购专辑"
              keyField="id"
            >
              <template #default="{ item }">
                <AlbumCard v-bind="item" />
              </template>
            </VirtualGrid>
            <div v-if="albumsHasMore && !albumsLoading" class="flex justify-center pt-6 pb-4">
              <Button
                variant="ghost"
                size="sm"
                :disabled="albumsLoadingMore"
                @click="loadMoreAlbums"
              >
                {{ albumsLoadingMore ? '加载中...' : '加载更多' }}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.purchased-login-empty,
.purchased-empty {
  min-height: 320px;
}
</style>
