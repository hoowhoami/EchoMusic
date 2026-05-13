<script setup lang="ts">
defineOptions({ name: 'history' });
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { getUserHistory } from '@/api/user';
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
import { mapHistorySong } from '@/utils/mappers';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconClock, iconCurrentLocation, iconList, iconPlay, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import { useToastStore } from '@/stores/toast';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(false);
const nextBp = ref('');
const remoteSongs = shallowRef<Song[]>([]);
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const isLoggedIn = computed(() => userStore.isLoggedIn);
const songs = computed(() => remoteSongs.value);
const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
const songCount = computed(() => songs.value.length);
const displayedCountLabel = computed(() => `${songCount.value}`);

const mergeHistorySongs = (current: Song[], incoming: Song[]): Song[] => {
  if (current.length === 0) return incoming.slice();

  const merged = current.slice();
  const keyIndexMap = new Map<string, number>();
  merged.forEach((song, index) => {
    keyIndexMap.set(song.historyKey ?? `${song.id}:${song.lastPlayedAt ?? ''}`, index);
  });

  incoming.forEach((song) => {
    const key = song.historyKey ?? `${song.id}:${song.lastPlayedAt ?? ''}`;
    const existingIndex = keyIndexMap.get(key);
    if (existingIndex === undefined) {
      keyIndexMap.set(key, merged.length);
      merged.push(song);
      return;
    }

    merged[existingIndex] = {
      ...merged[existingIndex],
      ...song,
      playCount: Math.max(merged[existingIndex].playCount ?? 0, song.playCount ?? 0) || undefined,
    };
  });

  return merged;
};

const historyCoverUrl = computed(() => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5AC8FA" />
          <stop offset="100%" stop-color="#0071E3" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <g transform="translate(200 200)">
        <circle cx="0" cy="0" r="92" fill="rgba(255,255,255,0.14)" />
        <circle cx="0" cy="0" r="70" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" />
        <line x1="0" y1="0" x2="0" y2="-34" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round" />
        <line x1="0" y1="0" x2="26" y2="16" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round" />
      </g>
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

const resetRemoteState = () => {
  remoteSongs.value = [];
  loading.value = false;
  loadingMore.value = false;
  hasMore.value = false;
  nextBp.value = '';
};

const loadHistory = async (append = false) => {
  if (!isLoggedIn.value) return;
  if (append) {
    if (!hasMore.value || loadingMore.value) return;
    loadingMore.value = true;
  } else {
    loading.value = true;
    nextBp.value = '';
    hasMore.value = false;
  }

  try {
    const res = await getUserHistory(append ? nextBp.value || undefined : undefined);
    const record =
      res && typeof res === 'object' ? (res as unknown as Record<string, unknown>) : undefined;
    const data =
      record?.data && typeof record.data === 'object'
        ? (record.data as Record<string, unknown>)
        : record;
    const rawList = Array.isArray(data?.list)
      ? data?.list
      : Array.isArray(data?.songs)
        ? data?.songs
        : [];
    const mapped = rawList
      .filter(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'info' in item &&
          typeof (item as { info?: unknown }).info === 'object' &&
          (item as { info?: unknown }).info !== null,
      )
      .map((item) => mapHistorySong(item));

    playerStore.hydrateHistoryPlayCounts(mapped);
    remoteSongs.value = append
      ? mergeHistorySongs(remoteSongs.value, mapped)
      : mergeHistorySongs([], mapped);
    nextBp.value = typeof data?.bp === 'string' ? data.bp : '';
    hasMore.value = Boolean(data?.has_more ?? (mapped.length > 0 && nextBp.value));
  } catch {
    if (!append) {
      remoteSongs.value = [];
    }
    hasMore.value = false;
    toastStore.loadFailed('历史记录');
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
};

const handleSongDoubleTapPlay = async (song: Song) => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '最近播放',
    type: 'history',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, undefined, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '最近播放',
    type: 'history',
    dynamic: false,
  });
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();
const handleLoadMore = () => {
  if (isLoggedIn.value) {
    void loadHistory(true);
  }
};

watch(
  () => isLoggedIn.value,
  (loggedIn) => {
    if (loggedIn) {
      void loadHistory();
      return;
    }
    resetRemoteState();
  },
);

onMounted(() => {
  if (isLoggedIn.value) {
    void loadHistory();
  }
});
</script>

<template>
  <PageScrollContainer class="history-view-container">
    <div class="history-view bg-bg-main min-h-full">
      <div
        v-if="!isLoggedIn"
        class="history-empty flex flex-col items-center justify-center min-h-[420px] text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-[24px] bg-primary/10 text-primary flex items-center justify-center mb-5"
        >
          <Icon :icon="iconClock" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">登录后查看播放历史</div>
      </div>

      <template v-else>
        <SliverHeader
          typeLabel="HISTORY"
          title="最近播放"
          :coverUrl="historyCoverUrl"
          :hasDetails="true"
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="text-[13px] font-semibold text-text-secondary">历史记录仅供参考</div>
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
              >
                <div class="inline-flex items-center gap-1.5">
                  <Icon :icon="iconPlay" width="12" height="12" />
                  <span>{{ displayedCountLabel }}</span>
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

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="history" />

        <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: '56px' }">
          <div class="px-6 border-b border-border-light/10">
            <div class="flex items-center justify-between h-14">
              <div class="text-[14px] font-semibold text-text-main relative">
                歌曲 <Badge :count="displayedCountLabel" />
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
            class="history-empty flex flex-col items-center justify-center py-24 text-center"
          >
            <div
              class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
            >
              <Icon :icon="iconClock" width="28" height="28" />
            </div>
            <div class="text-[18px] font-semibold text-text-main">暂无播放历史</div>
            <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
              最近播放的歌曲会展示在这里
            </div>
          </div>
          <SongList
            v-else
            ref="songListRef"
            :songs="sortedSongs"
            itemKeyField="historyKey"
            :searchQuery="searchQuery"
            :activeId="activeSongId"
            :showCover="true"
            :queueOptions="{
              queueId: 'queue:history',
              title: '播放历史',
              subtitle: '最近播放记录',
              type: 'history',
              dynamic: false,
            }"
            :enableDefaultDoubleTapPlay="true"
            :onSongDoubleTapPlay="
              settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
            "
          />
          <div v-if="!loading && hasMore" class="flex justify-center pt-4">
            <Button
              variant="unstyled"
              size="none"
              class="px-4 h-9 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-[12px] font-semibold text-text-main/75 hover:text-text-main transition-colors"
              :disabled="loadingMore"
              @click="handleLoadMore"
            >
              {{ loadingMore ? '加载中...' : '加载更多' }}
            </Button>
          </div>
        </div>
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.history-empty {
  min-height: 320px;
}
</style>
