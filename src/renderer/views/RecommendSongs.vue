<script setup lang="ts">
defineOptions({ name: 'recommend-songs' });
import { computed, onMounted, ref } from 'vue';
import { getEverydayRecommend } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { getAccentGradientPair } from '@/utils/color';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { mapTopSong } from '@/utils/mappers';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconPlay, iconList, iconCurrentLocation, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const themeStore = useThemeStore();

const loading = ref(true);
const songs = ref<Song[]>([]);
const showBatchDrawer = ref(false);
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const todayLabel = computed(() => new Date().getDate().toString());

const recommendCoverUrl = computed(() => {
  const dayText = todayLabel.value;
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
      <text x="50%" y="62%" text-anchor="middle" fill="#FFFFFF" font-size="160" font-weight="700" font-family="SF Pro Display, PingFang SC, Arial">
        ${dayText}
      </text>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
});

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

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:daily-recommend',
    title: '每日推荐',
    subtitle: '为你量身定制',
    type: 'daily-recommend',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    queueId: 'queue:daily-recommend',
    title: '每日推荐',
    subtitle: '为你量身定制',
    type: 'daily-recommend',
    dynamic: false,
  });
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

const fetchRecommendSongs = async () => {
  loading.value = true;
  try {
    const res = await getEverydayRecommend();
    songs.value = extractList(res).map((item) => mapTopSong(item));
  } catch {
    songs.value = [];
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  void fetchRecommendSongs();
});
</script>

<template>
  <PageScrollContainer class="recommend-songs-container">
    <div class="recommend-songs-view bg-bg-main min-h-full">
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="RECOMMEND"
        title="每日推荐"
        :coverUrl="recommendCoverUrl"
        :hasDetails="true"
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="flex flex-col gap-2">
            <div class="text-[13px] font-semibold text-text-secondary">为你量身定制的每日歌单</div>
          </div>
        </template>

        <template #actions>
          <ActionRow @play="handlePlayAll" @batch="openBatchDrawer" />
        </template>

        <template #collapsed-actions>
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

      <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="recommend" />

      <Tabs model-value="songs" class="w-full" :style="{ minHeight: tabsMinHeight }">
        <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
          <div class="px-6">
            <div class="border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="bg-transparent border-none gap-8">
                  <TabsTrigger value="songs">
                    <span class="relative">歌曲 <Badge :count="songs.length" /></span>
                  </TabsTrigger>
                </TabsList>

                <div class="flex items-center gap-2">
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
                    <Icon :icon="iconCurrentLocation" width="16" height="16" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <SongListHeader
            :sortField="sortField"
            :sortOrder="sortOrder"
            :showCover="true"
            paddingClass="px-6"
            @sort="handleSort"
          />
        </div>

        <div class="px-6 pb-12">
          <div v-if="loading" class="flex items-center justify-center py-20">
            <div
              class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
            ></div>
          </div>
          <SongList
            v-else
            ref="songListRef"
            :songs="displayedSongs"
            :contextSongs="sortedSongs"
            :searchQuery="searchQuery"
            :disableInternalFilter="true"
            :activeId="activeSongId"
            :showCover="true"
            :queueOptions="{
              queueId: 'queue:daily-recommend',
              title: '每日推荐',
              subtitle: '为你量身定制',
              type: 'daily-recommend',
              dynamic: false,
            }"
            :enableDefaultDoubleTapPlay="true"
            :onSongDoubleTapPlay="
              settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
            "
          />
        </div>
      </Tabs>
    </div>
  </PageScrollContainer>
</template>
