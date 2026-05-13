<script setup lang="ts">
defineOptions({ name: 'ranking' });
import { computed, onMounted, ref, watch } from 'vue';
import { getRanks, getRankTop, getRankSongs } from '@/api/playlist';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { mapRankMeta, mapRankSong } from '@/utils/mappers';
import type { RankMeta } from '@/models/rank';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconPlay, iconList, iconChevronDown, iconCurrentLocation, iconSearch } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useToastStore } from '@/stores/toast';
import Badge from '@/components/ui/Badge.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();
const settingStore = useSettingStore();

const loadingRanks = ref(true);
const loadingSongs = ref(false);
const ranks = ref<RankMeta[]>([]);
const selectedRankId = ref<number | null>(null);
const songs = ref<Song[]>([]);
const showBatchDrawer = ref(false);
const showSelectorDialog = ref(false);
const searchQuery = ref('');
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);

const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const selectedRank = computed(
  () => ranks.value.find((item) => item.id === selectedRankId.value) ?? ranks.value[0],
);

const groupedRanks = computed(() => {
  const groups = new Map<string, RankMeta[]>();
  ranks.value.forEach((rank) => {
    const key = rank.rankTypeName?.trim() || '推荐';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rank);
  });
  return Array.from(groups.entries());
});
const activeGroupKey = ref('');

const selectedGroupKey = computed(() => {
  const current = selectedRank.value;
  return current?.rankTypeName?.trim() || '推荐';
});

const activeGroupIndex = computed(() => {
  if (groupedRanks.value.length === 0) return 0;
  const index = groupedRanks.value.findIndex(([key]) => key === activeGroupKey.value);
  return index >= 0 ? index : 0;
});

const activeGroupRanks = computed(() => {
  const groups = groupedRanks.value;
  if (groups.length === 0) return [] as RankMeta[];
  if (groups.length === 1) return groups[0][1];
  const key = activeGroupKey.value || groups[0][0];
  const match = groups.find(([groupKey]) => groupKey === key);
  return match ? match[1] : groups[0][1];
});

const todayRankCover = computed(() => {
  const dayText = 'TOP';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0071E3" />
          <stop offset="100%" stop-color="#5AC8FA" />
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
  try {
    await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, song, {
      queueId: `queue:ranking:${selectedRank.value?.id ?? 'default'}`,
      title: selectedRank.value?.name || '排行榜',
      subtitle: selectedRank.value?.rankTypeName || '实时热门趋势',
      type: 'ranking',
      dynamic: false,
    });
  } catch {
    toastStore.actionFailed('播放');
  }
};

const handlePlayAll = async () => {
  if (songs.value.length === 0) return;
  try {
    await replaceQueueAndPlay(playlistStore, playerStore, songs.value, 0, undefined, {
      queueId: `queue:ranking:${selectedRank.value?.id ?? 'default'}`,
      title: selectedRank.value?.name || '排行榜',
      subtitle: selectedRank.value?.rankTypeName || '实时热门趋势',
      type: 'ranking',
      dynamic: false,
    });
  } catch {
    toastStore.actionFailed('播放');
  }
};

const openBatchDrawer = () => {
  if (songs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

const resolveRankList = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    const list = data?.list ?? data?.info ?? record.list ?? record.info ?? data ?? record;
    return Array.isArray(list) ? list : [];
  }
  return [];
};

const loadRanks = async () => {
  loadingRanks.value = true;
  try {
    const res = await getRankTop();
    const list = resolveRankList(res);
    const mapped = list.map((item) => mapRankMeta(item)).filter((item) => item.id !== 0);
    if (mapped.length === 0) {
      const fallback = await getRanks();
      const fallbackList = resolveRankList(fallback);
      ranks.value = fallbackList.map((item) => mapRankMeta(item)).filter((item) => item.id !== 0);
    } else {
      ranks.value = mapped;
    }
    if (ranks.value.length > 0) {
      selectedRankId.value = ranks.value[0].id;
      try {
        await loadRankSongs(ranks.value[0].id);
      } catch {
        toastStore.loadFailed('排行榜歌曲');
      }
    }
  } catch {
    ranks.value = [];
    toastStore.loadFailed('排行榜');
  } finally {
    loadingRanks.value = false;
  }
};

const loadRankSongs = async (rankId: number) => {
  loadingSongs.value = true;
  selectedRankId.value = rankId;
  songs.value = [];
  try {
    const res = await getRankSongs(rankId, 1, 100);
    const payload = res?.data?.list || res?.data?.info || res?.data?.songlist || res?.data || res;
    const list = Array.isArray(payload) ? payload : [];
    songs.value = list.map((item) => mapRankSong(item));
  } catch {
    songs.value = [];
    toastStore.loadFailed('排行榜歌曲');
  } finally {
    loadingSongs.value = false;
  }
};

const handleRankSelect = async (rankId: number) => {
  showSelectorDialog.value = false;
  if (rankId === selectedRankId.value) return;
  try {
    await loadRankSongs(rankId);
  } catch {
    toastStore.loadFailed('排行榜歌曲');
  }
};

onMounted(() => {
  void loadRanks();
});

watch(
  () => groupedRanks.value,
  (groups) => {
    if (groups.length === 0) {
      activeGroupKey.value = '';
      return;
    }
    const fallbackKey = selectedGroupKey.value || groups[0][0];
    if (!activeGroupKey.value || !groups.some(([key]) => key === activeGroupKey.value)) {
      activeGroupKey.value = fallbackKey;
    }
  },
  { immediate: true },
);

watch(
  () => showSelectorDialog.value,
  (open) => {
    if (open) {
      activeGroupKey.value = selectedGroupKey.value || activeGroupKey.value;
    }
  },
);
</script>

<template>
  <PageScrollContainer class="ranking-view-container">
    <div class="ranking-view bg-bg-main min-h-full">
      <div v-if="loadingRanks" class="flex items-center justify-center py-24">
        <div
          class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>

      <template v-else>
        <SliverHeader
          typeLabel="RANK"
          title="排行榜"
          :coverUrl="todayRankCover"
          :hasDetails="true"
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="text-[13px] font-semibold text-text-secondary">实时热门趋势榜单</div>
            </div>
          </template>

          <template #actions>
            <div class="rank-header-actions">
              <Button
                variant="unstyled"
                size="none"
                class="rank-selector"
                @click="showSelectorDialog = true"
              >
                <span class="truncate">{{ selectedRank?.name || '排行榜选择' }}</span>
                <Icon :icon="iconChevronDown" width="14" height="14" />
              </Button>
              <ActionRow @play="handlePlayAll" @batch="openBatchDrawer" />
            </div>
          </template>

          <template #collapsed-actions>
            <Button
              variant="unstyled"
              size="none"
              @click="showSelectorDialog = true"
              class="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-main"
            >
              <Icon :icon="iconChevronDown" width="18" height="18" />
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

        <BatchActionDrawer v-model:open="showBatchDrawer" :songs="songs" source-id="rank" />

        <div class="song-list-sticky sticky z-[110] bg-bg-main" :style="{ top: '56px' }">
          <div class="px-6 border-b border-border-light/10">
            <div class="flex items-center justify-between h-14">
              <div class="text-[14px] font-semibold text-text-main relative">
                榜单歌曲 <Badge :count="songs.length" />
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
          <div v-if="loadingSongs" class="flex items-center justify-center py-20">
            <div
              class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
            ></div>
          </div>
          <SongList
            v-else
            ref="songListRef"
            :songs="sortedSongs"
            :searchQuery="searchQuery"
            :activeId="activeSongId"
            :showCover="true"
            :queueOptions="{
              queueId: `queue:ranking:${selectedRank?.id ?? 'default'}`,
              title: selectedRank?.name || '排行榜',
              subtitle: selectedRank?.rankTypeName || '实时热门趋势',
              type: 'ranking',
              dynamic: false,
            }"
            :enableDefaultDoubleTapPlay="true"
            :onSongDoubleTapPlay="
              settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
            "
          />
        </div>

        <Dialog
          v-model:open="showSelectorDialog"
          title="排行榜选择"
          showClose
          contentClass="rank-selector-dialog"
        >
          <div v-if="groupedRanks.length > 1" class="rank-selector-tabs">
            <CustomTabBar
              :tabs="groupedRanks.map((group) => group[0])"
              :model-value="activeGroupIndex"
              @update:model-value="(index) => (activeGroupKey = groupedRanks[index]?.[0] || '')"
            />
          </div>
          <div class="rank-selector-list">
            <Button
              v-for="rank in activeGroupRanks"
              :key="rank.id"
              class="rank-selector-item"
              :class="{ active: rank.id === selectedRankId }"
              variant="ghost"
              size="xs"
              @click="handleRankSelect(rank.id)"
            >
              {{ rank.name }}
            </Button>
          </div>
        </Dialog>
      </template>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.rank-header-actions {
  @apply flex items-center gap-3 flex-wrap;
}

.rank-selector {
  @apply inline-flex items-center gap-2 h-9 px-4 rounded-xl border border-border-light bg-black/[0.06] dark:bg-white/[0.06] text-text-main text-[13px] font-semibold transition-all;
  max-width: 220px;
}

.rank-selector:hover {
  @apply border-primary/30 bg-black/[0.08] dark:bg-white/[0.08];
}

.rank-selector-dialog {
  @apply max-w-[520px];
}

.rank-selector-list {
  @apply flex flex-wrap gap-2;
}

.rank-selector-item {
  @apply px-4 py-2 rounded-lg border border-border-light text-[12px] font-semibold text-text-main bg-bg-card transition-all;
}

.rank-selector-item.active {
  @apply border-primary bg-primary/10 text-primary;
}

.rank-selector-item:hover {
  @apply border-primary/40 bg-primary/10 text-primary;
}

.rank-selector-tabs {
  @apply mb-3;
}
</style>
