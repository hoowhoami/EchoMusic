<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getEverydayRecommend } from '@/api/music';
import { extractList } from '@/utils/extractors';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
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

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();

const loading = ref(true);
const songs = ref<Song[]>([]);
const showBatchDrawer = ref(false);
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const todayLabel = computed(() => new Date().getDate().toString());

const recommendCoverUrl = computed(() => {
  const dayText = todayLabel.value;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0071E3" />
          <stop offset="100%" stop-color="#5AC8FA" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <text x="50%" y="54%" text-anchor="middle" fill="#FFFFFF" font-size="160" font-weight="700" font-family="SF Pro Display, PingFang SC, Arial">
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
  const base = songs.value.slice();
  if (!sortField.value || !sortOrder.value) return base;
  const compareText = (a: string, b: string) =>
    a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' });
  const indexMap = new Map<string, number>();
  songs.value.forEach((song, index) => {
    indexMap.set(song.id, index);
  });
  const direction = sortOrder.value === 'asc' ? 1 : -1;

  return base.sort((a, b) => {
    switch (sortField.value) {
      case 'title':
        return compareText(a.title, b.title) * direction;
      case 'album':
        return compareText(a.album ?? '', b.album ?? '') * direction;
      case 'duration':
        return (a.duration - b.duration) * direction;
      case 'index':
        return ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)) * direction;
      default:
        return 0;
    }
  });
});

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

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

const fetchRecommendSongs = async () => {
  loading.value = true;
  try {
    const res = await getEverydayRecommend();
    songs.value = extractList(res).map((item) => mapTopSong(item));
  } catch (error) {
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
  <div class="recommend-songs-view bg-bg-main min-h-full">
    <SliverHeader
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
        <Button variant="unstyled" size="none"
          @click="handlePlayAll"
          class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-primary"
        >
          <Icon :icon="iconPlay" width="20" height="20" />
        </Button>
        <Button variant="unstyled" size="none"
          @click="openBatchDrawer"
          class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-main opacity-60"
        >
          <Icon :icon="iconList" width="18" height="18" />
        </Button>
      </template>
    </SliverHeader>

    <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="recommend" />

    <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: '56px' }">
      <div class="px-6 border-b border-border-light/10">
        <div class="flex items-center justify-between h-14">
          <div class="text-[14px] font-semibold text-text-main">
            歌曲 <span class="ml-1 text-[12px] text-text-secondary/70">{{ songs.length }}</span>
          </div>
          <div class="flex items-center gap-2">
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
            <Button variant="unstyled" size="none"
              @click="handleLocate"
              class="song-locate-btn p-2 rounded-lg"
              title="定位当前播放"
            >
              <Icon :icon="iconCurrentLocation" width="16" height="16" />
            </Button>
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
        <div class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
      <SongList
        v-else
        ref="songListRef"
        :songs="sortedSongs"
        :searchQuery="searchQuery"
        :activeId="activeSongId"
        :showCover="true"
        :enableDefaultDoubleTapPlay="true"
        :onSongDoubleTapPlay="settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined"
      />
    </div>
  </div>
</template>
