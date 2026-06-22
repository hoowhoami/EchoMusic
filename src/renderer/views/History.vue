<script setup lang="ts">
defineOptions({ name: 'history' });
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { getAccentGradientPair } from '@/utils/color';
import { useHistoryStore, type LocalHistoryEntry } from '@/stores/historyStore';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import { iconClock, iconCurrentLocation, iconList, iconPlay, iconSearch, iconTrash } from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { useToastStore } from '@/stores/toast';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const themeStore = useThemeStore();
const historyStore = useHistoryStore();
const route = useRoute();

/** 动画状态：切歌置顶时触发列表滚动效果 */
const animatingList = ref(false);
let animTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => historyStore.playRecordVersion,
  () => {
    if (animTimer !== null) clearTimeout(animTimer);
    animatingList.value = false;
    // 在下一帧启动动画，确保 CSS class 被移除后重新应用
    requestAnimationFrame(() => {
      animatingList.value = true;
      animTimer = setTimeout(() => {
        animatingList.value = false;
        animTimer = null;
      }, 300);
    });
  },
);

const searchQuery = ref('');
const showBatchDrawer = ref(false);
const showClearDialog = ref(false);
const clearCountdown = ref(0);
let clearCountdownTimer: ReturnType<typeof setInterval> | null = null;

watch(showClearDialog, (open) => {
  if (open) {
    clearCountdown.value = 5;
    clearCountdownTimer = setInterval(() => {
      clearCountdown.value--;
      if (clearCountdown.value <= 0) {
        if (clearCountdownTimer) clearInterval(clearCountdownTimer);
        clearCountdownTimer = null;
      }
    }, 1000);
  } else {
    if (clearCountdownTimer) {
      clearInterval(clearCountdownTimer);
      clearCountdownTimer = null;
    }
    clearCountdown.value = 0;
  }
});

const confirmClear = () => {
  if (clearCountdown.value > 0) return;
  historyStore.clear();
  showClearDialog.value = false;
  toastStore.success('播放历史已清空');
};

const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);

const mapLocalEntryToSong = (entry: LocalHistoryEntry): Song => ({
  ...entry.song,
  lastPlayedAt: entry.lastPlayedAt,
  playCount: entry.playCount,
  historyKey: entry.historyKey,
});

// 只展示本地历史
const songs = computed(() => historyStore.entries.map(mapLocalEntryToSong));

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

/** 切歌时自动滚动到高亮的当前播放歌曲 */
watch(activeSongId, async () => {
  if (!activeSongId.value) return;
  await nextTick();
  songListRef.value?.scrollToActive?.();
});

const songCount = computed(() => songs.value.length);
const displayedCountLabel = computed(() => `${songCount.value}`);

const historyCoverUrl = computed(() => {
  const { from, to } = getAccentGradientPair(themeStore.sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${to}" />
          <stop offset="100%" stop-color="${from}" />
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
  return sortSongs(songs.value, sortField.value, sortOrder.value, {
    indexSource: songs.value,
  });
});
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '最近播放',
    type: 'history',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
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

const handleBatchRemove = (selected: Song[]) => {
  const keys = selected.map((s) => s.historyKey).filter(Boolean) as string[];
  if (keys.length > 0) {
    historyStore.removeEntries(keys);
  }
  toastStore.actionCompleted(`已从播放历史移除 ${selected.length} 首`);
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

let unregisterContextMenu: (() => void) | null = null;

onMounted(() => {
  void historyStore.hydrate();
  unregisterContextMenu = registerSongContextMenuExtension({
    id: 'history-remove-song',
    label: '从播放历史中移除',
    order: 1000,
    danger: true,
    visible: () => route.name === 'history',
    onSelect: (song: Song) => {
      if (song.historyKey) historyStore.removeEntry(song.historyKey);
    },
  });
});

onUnmounted(() => {
  unregisterContextMenu?.();
  if (clearCountdownTimer) clearInterval(clearCountdownTimer);
  if (animTimer) clearTimeout(animTimer);
});
</script>

<template>
  <PageScrollContainer class="history-view-container">
    <div class="history-view bg-bg-main min-h-full">
      <div
        v-if="songCount === 0"
        class="history-empty flex flex-col items-center justify-center min-h-105 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5"
        >
          <Icon :icon="iconClock" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">暂无播放历史</div>
        <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
          最近播放的歌曲会展示在这里
        </div>
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
              <div class="text-[13px] font-semibold text-text-secondary">
                记录过往播放轨迹，快速回溯曾听过的歌曲与内容。
              </div>
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

        <BatchActionDrawer
          v-model:open="showBatchDrawer"
          :songs="songs"
          source-id="history"
          remove-context="history"
          :on-batch-remove="handleBatchRemove"
        />

        <Tabs model-value="songs" class="w-full">
          <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: '56px' }">
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList class="bg-transparent border-none gap-8">
                    <TabsTrigger value="songs">
                      <span class="relative">歌曲 <Badge :count="displayedCountLabel" /></span>
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
                    <Button
                      variant="unstyled"
                      size="none"
                      :disabled="songCount === 0"
                      @click="showClearDialog = true"
                      class="song-locate-btn p-2 rounded-lg text-text-main/40 hover:text-danger transition-colors"
                      title="清空播放历史"
                    >
                      <Icon :icon="iconTrash" width="16" height="16" />
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
            <div class="history-song-list-wrapper" :class="{ 'is-scrolling-in': animatingList }">
              <SongList
                ref="songListRef"
                :songs="displayedSongs"
                :contextSongs="sortedSongs"
                :promotedKey="historyStore.promotedKey"
                :removingKeys="historyStore.removingKeys"
                itemKeyField="historyKey"
                :searchQuery="searchQuery"
                :disableInternalFilter="true"
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
            </div>
          </div>
        </Tabs>
      </template>
    </div>
  </PageScrollContainer>

  <Dialog
    v-model:open="showClearDialog"
    title="清空播放历史"
    description="确认清空全部本地播放历史？此操作不可撤销。"
  >
    <template #footer>
      <div class="flex justify-end gap-3">
        <Button variant="outline" size="sm" @click="showClearDialog = false"> 取消 </Button>
        <Button variant="primary" size="sm" :disabled="clearCountdown > 0" @click="confirmClear">
          确认清空<span v-if="clearCountdown > 0"> ({{ clearCountdown }}s)</span>
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.history-empty {
  min-height: 320px;
}

/* 切歌置顶滚动动画 */
.history-song-list-wrapper {
  overflow: hidden;
}

.history-song-list-wrapper.is-scrolling-in {
  animation: historyListScrollIn 280ms cubic-bezier(0.33, 0, 0.2, 1);
}

@keyframes historyListScrollIn {
  from {
    transform: translateY(-52px);
    opacity: 0.92;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
