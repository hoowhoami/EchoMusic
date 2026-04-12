<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { getUserCloud } from '@/api/user';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import { mapCloudSong } from '@/utils/mappers';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconCloud, iconCurrentLocation, iconList, iconPlay, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';

const PAGE_SIZE = 100;

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();

const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(false);
const currentPage = ref(1);
const isBackgroundResolving = ref(false);
const totalSongCount = ref(0);
const cloudCapacity = ref(0);
const cloudAvailable = ref(0);
const songs = shallowRef<Song[]>([]);
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const isLoggedIn = computed(() => userStore.isLoggedIn);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
const displaySongCount = computed(() => totalSongCount.value || songs.value.length);
const usedCapacity = computed(() => Math.max(0, cloudCapacity.value - cloudAvailable.value));
const usageRatio = computed(() => {
  if (cloudCapacity.value <= 0) return 0;
  return Math.min(1, usedCapacity.value / cloudCapacity.value);
});

const cloudCoverUrl = computed(() => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0071E3" />
          <stop offset="100%" stop-color="#5AC8FA" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <g transform="translate(200 200)">
        <path d="M-78 44c-30 0-54-22-54-50 0-27 22-49 49-50 10-34 42-58 81-58 48 0 88 36 93 81 30 3 53 26 53 54 0 31-28 57-62 57H-78z" fill="#FFFFFF" opacity="0.92"/>
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
});

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
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

const resetCloudState = () => {
  songs.value = [];
  loading.value = false;
  loadingMore.value = false;
  hasMore.value = false;
  currentPage.value = 1;
  totalSongCount.value = 0;
  cloudCapacity.value = 0;
  cloudAvailable.value = 0;
  isBackgroundResolving.value = false;
};

const mapCloudPage = (payload: unknown) => {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
  const data =
    record?.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record;
  const rawList = Array.isArray(data?.list) ? data.list : [];
  const mapped = rawList
    .filter((item) => typeof item === 'object' && item !== null)
    .map((item) => mapCloudSong(item));

  return {
    songs: mapped,
    total: Number(data?.list_count ?? data?.count ?? mapped.length) || mapped.length,
    capacity: Number(data?.max_size ?? data?.capacity ?? 0) || 0,
    available: Number(data?.availble_size ?? data?.available ?? 0) || 0,
  };
};

/**
 * 对云盘歌曲去重：如果 id 重复，给后续的歌曲追加序号后缀以保证唯一性。
 * 同时将新 id 加入 seenIds 集合。
 */
const deduplicateCloudSongs = (batch: Song[], seenIds: Set<string>): Song[] => {
  const result: Song[] = [];
  for (const song of batch) {
    let uniqueId = song.id;
    if (seenIds.has(uniqueId)) {
      // id 冲突，追加序号
      let suffix = 2;
      while (seenIds.has(`${song.id}_${suffix}`)) suffix++;
      uniqueId = `${song.id}_${suffix}`;
      result.push({ ...song, id: uniqueId });
    } else {
      result.push(song);
    }
    seenIds.add(uniqueId);
  }
  return result;
};

const resolveAllCloudSongs = async (totalCount: number) => {
  if (isBackgroundResolving.value || songs.value.length >= totalCount) return;
  isBackgroundResolving.value = true;
  const seenIds = new Set(songs.value.map((song) => song.id));
  let page = currentPage.value + 1;

  try {
    while (songs.value.length < totalCount) {
      const res = await getUserCloud(page, PAGE_SIZE);
      const nextBatch = mapCloudPage(res).songs;

      if (nextBatch.length === 0) break;

      const filtered = deduplicateCloudSongs(nextBatch, seenIds);
      if (filtered.length > 0) {
        songs.value = [...songs.value, ...filtered];
      }

      currentPage.value = page;
      hasMore.value = songs.value.length < totalCount;
      page += 1;
    }
  } catch {
    hasMore.value = songs.value.length < totalCount;
  } finally {
    isBackgroundResolving.value = false;
  }
};

const loadCloud = async () => {
  if (!isLoggedIn.value) return;
  loading.value = true;

  try {
    const res = await getUserCloud(1, PAGE_SIZE);
    const parsed = mapCloudPage(res);
    const seenIds = new Set<string>();
    songs.value = deduplicateCloudSongs(parsed.songs, seenIds);
    currentPage.value = 1;
    totalSongCount.value = parsed.total;
    cloudCapacity.value = parsed.capacity;
    cloudAvailable.value = parsed.available;
    hasMore.value = songs.value.length < totalSongCount.value;

    if (songs.value.length > 0 && totalSongCount.value > songs.value.length) {
      void resolveAllCloudSongs(totalSongCount.value);
    }
  } catch {
    songs.value = [];
    totalSongCount.value = 0;
    cloudCapacity.value = 0;
    cloudAvailable.value = 0;
    hasMore.value = false;
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
};

const handleSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song, {
    queueId: 'queue:cloud',
    title: '云盘音乐',
    subtitle: '你的云盘收藏',
    type: 'cloud',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, undefined, {
    queueId: 'queue:cloud',
    title: '云盘音乐',
    subtitle: '你的云盘收藏',
    type: 'cloud',
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
    if (loggedIn) {
      void loadCloud();
      return;
    }
    resetCloudState();
  },
);

onMounted(() => {
  if (isLoggedIn.value) {
    void loadCloud();
  }
});
</script>

<template>
  <div class="cloud-view bg-bg-main min-h-full">
    <div
      v-if="!isLoggedIn"
      class="cloud-login-empty flex flex-col items-center justify-center min-h-[420px] text-center px-6"
    >
      <div
        class="w-18 h-18 rounded-[24px] bg-primary/10 text-primary flex items-center justify-center mb-5"
      >
        <Icon :icon="iconCloud" width="32" height="32" />
      </div>
      <div class="text-[22px] font-semibold text-text-main">登录后查看云盘</div>
    </div>

    <template v-else>
      <SliverHeader
        typeLabel="CLOUD"
        title="音乐云盘"
        :coverUrl="cloudCoverUrl"
        :hasDetails="true"
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="flex flex-col gap-2">
            <div class="text-[12px] font-medium text-text-secondary/75">
              支持基础浏览、播放与容量查看
            </div>
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
            >
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconPlay" width="12" height="12" />
                <span>{{ displaySongCount }}</span>
              </div>
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconCloud" width="12" height="12" />
                <span>{{ formatBytes(cloudCapacity) }}</span>
              </div>
            </div>
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

      <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="cloud" />

      <div class="px-6 pt-[10px] pb-1">
        <div class="cloud-info-card">
          <div class="flex items-center justify-between">
            <div class="text-[13px] font-semibold text-text-main">云盘容量</div>
            <div class="text-[11px] font-semibold text-primary">
              {{ (usageRatio * 100).toFixed(1) }}%
            </div>
          </div>
          <div class="cloud-progress-track">
            <div class="cloud-progress-value" :style="{ width: `${usageRatio * 100}%` }"></div>
          </div>
          <div
            class="flex items-center justify-between text-[11px] font-medium text-text-secondary/80"
          >
            <span>{{ formatBytes(usedCapacity) }} / {{ formatBytes(cloudCapacity) }}</span>
            <span>可用 {{ formatBytes(cloudAvailable) }}</span>
          </div>
        </div>
      </div>

      <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: '56px' }">
        <div class="px-6 border-b border-border-light/10">
          <div class="flex items-center justify-between h-14">
            <div class="text-[14px] font-semibold text-text-main">
              歌曲
              <span class="ml-1 text-[12px] text-text-secondary/70">{{ displaySongCount }}</span>
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
        <div
          v-else-if="songs.length === 0"
          class="cloud-empty flex flex-col items-center justify-center py-24 text-center"
        >
          <div
            class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
          >
            <Icon :icon="iconCloud" width="28" height="28" />
          </div>
          <div class="text-[18px] font-semibold text-text-main">云盘暂无歌曲</div>
          <div class="mt-2 text-[13px] font-medium text-text-secondary/75">上传后会展示在这里</div>
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
        <div v-if="!loading && isBackgroundResolving" class="flex justify-center pt-4">
          <div class="text-[12px] font-semibold text-text-secondary/70">
            正在后台补全剩余云盘歌曲...
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.cloud-login-empty,
.cloud-empty {
  min-height: 320px;
}

.cloud-info-card {
  padding: 14px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border-light) 86%, transparent);
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
}

.cloud-progress-track {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.cloud-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
}
</style>
