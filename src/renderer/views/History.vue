<script setup lang="ts">
import { useRouteTabs } from '@/composables/useRouteTabs';
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
defineOptions({ name: 'history' });
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  ref,
  watch,
} from 'vue';
import { useRoute } from 'vue-router';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { createThemedIconCoverUrl } from '@/utils/cover';
import { useHistoryStore, type LocalHistoryEntry } from '@/stores/historyStore';
import { useUserStore } from '@/stores/user';
import { captureUserSession, userSessionSources } from '@/utils/userSession';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import SongSearchInput from '@/components/music/SongSearchInput.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconClock,
  iconCurrentLocation,
  iconList,
  iconPlay,
  iconSearch,
  iconShare,
  iconTrash,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { useToastStore } from '@/stores/toast';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import { getCurrentSharerName } from '@/utils/share';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import HistoryStatsContent from '@/components/history/stats/HistoryStatsContent.vue';
import { buildHistoryStats } from '../../shared/historyStats';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();
const themeStore = useThemeStore();
const historyStore = useHistoryStore();
const route = useRoute();
const userStore = useUserStore();
const metadataActive = ref(true);
let metadataGeneration = 0;
let metadataDisposed = false;
watch(
  [() => historyStore.entries, () => route.name, metadataActive, ...userSessionSources(userStore)],
  () => {
    const generation = ++metadataGeneration;
    if (metadataDisposed || !metadataActive.value || route.name !== 'history') return;
    const ownsSession = captureUserSession(userStore);
    void historyStore.completeMetadata(
      () =>
        !metadataDisposed &&
        metadataActive.value &&
        route.name === 'history' &&
        generation === metadataGeneration &&
        ownsSession(),
    );
  },
  { immediate: true },
);
onActivated(() => {
  metadataActive.value = true;
});
onDeactivated(() => {
  metadataActive.value = false;
  metadataGeneration++;
});

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
const confirmClear = () => {
  if (!showClearDialog.value || songCount.value === 0) return;
  historyStore.clear();
  showClearDialog.value = false;
  toastStore.success('播放历史已清空');
};

const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const {
  state: { tab: activeTab },
  select: selectTabs,
} = useRouteTabs({ tab: ['songs', 'stats'] });
// 统计内容组件实例；分享导出时经 $el 取根 DOM 克隆
const historyStatsRef = ref<{ $el: HTMLElement } | null>(null);
const sharingStats = ref(false);

const handleTabChange = (value: string | number) => {
  const next = String(value);
  void selectTabs({ tab: next });
};

const mapLocalEntryToSong = (entry: LocalHistoryEntry): Song => ({
  ...entry.song,
  lastPlayedAt: entry.lastPlayedAt,
  playCount: entry.playCount,
  historyKey: entry.historyKey,
});

// 只展示本地历史
const songs = computed(() => historyStore.entries.map(mapLocalEntryToSong));

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);

const formatShareTimestamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

// 统计快照：逐行对齐 EchoMusicNext buildStats 的口径（见 src/shared/historyStats.ts）
const historyStats = computed(() => buildHistoryStats(historyStore.entries));
const statsLoading = computed(
  () => !historyStore.hydrated && historyStore.entries.length === 0,
);
// 本地历史加载无失败态暴露，错误文案恒为空，保留结构以便与 Next 的错误空态对齐
const statsErrorMessage = ref('');
const retryStats = () => {
  void historyStore.hydrate();
};

/** 播放统计区中的歌曲（hero「再听一次」与 Top 歌曲 tile 共用） */
const resolveEntryId = (song: Song) => String(song.mixSongId || song.fileId || song.id || '0');
const playStatSong = async (id: string) => {
  const entry = historyStore.entries.find((item) => resolveEntryId(item.song) === id);
  if (!entry) return;
  await replaceQueueAndPlay(playlistStore, playerStore, [entry.song], 0, entry.song, {
    queueId: 'queue:history',
    title: '播放历史',
    subtitle: '',
    type: 'history',
    dynamic: false,
  });
};

const songCount = computed(() => songs.value.length);
const displayedCountLabel = computed(() => `${songCount.value}`);
const openClearDialog = () => {
  if (songCount.value === 0) return;
  showClearDialog.value = true;
};
const historySecondaryActions = computed(() => [
  {
    icon: iconTrash,
    label: '清空历史',
    onTap: openClearDialog,
    disabled: songCount.value === 0,
  },
]);

const historyCoverUrl = computed(() => createThemedIconCoverUrl(themeStore.sourceColor, iconClock));

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
    subtitle: '',
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
    subtitle: '',
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

const waitForAnimationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const waitForPaint = async () => {
  await waitForAnimationFrame();
  await waitForAnimationFrame();
};

const waitForImages = async (root: HTMLElement) => {
  const images = Array.from(root.querySelectorAll('img')).filter((image) => !image.complete);
  if (images.length === 0) return;

  await Promise.race([
    Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
  ]);
};

const buildHistoryStatsShareText = () => {
  const sharer = getCurrentSharerName();
  const updatedAt = formatShareTimestamp();
  return {
    title: `${sharer} 的听歌统计`,
    updatedAt,
  };
};

const createStatsCaptureStage = (shareText: ReturnType<typeof buildHistoryStatsShareText>) => {
  const statsRootEl = historyStatsRef.value?.$el as HTMLElement | undefined;
  if (!statsRootEl) return null;

  const stage = document.createElement('div');
  stage.className = 'history-share-capture-stage';
  Object.assign(stage.style, {
    position: 'fixed',
    left: '16px',
    top: '16px',
    zIndex: '2147483647',
    width: `${Math.min(1180, Math.max(760, window.innerWidth - 32))}px`,
    padding: '16px',
    // 导出背景独立于窗口透明度；主题底色即使带 alpha，也有实色底板承接。
    background: `linear-gradient(var(--surface-main-base), var(--surface-main-base)), ${themeStore.isDark ? '#18181b' : '#ffffff'}`,
    pointerEvents: 'none',
    transformOrigin: 'top left',
    visibility: 'hidden',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '16px',
    marginBottom: '14px',
    padding: '2px 2px 0',
  });

  const title = document.createElement('div');
  title.textContent = shareText.title;
  Object.assign(title.style, {
    minWidth: '0',
    color: 'var(--color-text-main)',
    fontSize: '22px',
    fontWeight: '800',
    lineHeight: '1.2',
  });

  const updatedAt = document.createElement('div');
  updatedAt.textContent = `更新时间：${shareText.updatedAt}`;
  Object.assign(updatedAt.style, {
    flex: '0 0 auto',
    color: 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: '700',
    lineHeight: '1.4',
    opacity: '0.78',
    whiteSpace: 'nowrap',
  });

  header.append(title, updatedAt);
  stage.appendChild(header);

  const clone = statsRootEl.cloneNode(true) as HTMLElement;
  clone.classList.add('is-share-capture');
  stage.appendChild(clone);
  document.body.appendChild(stage);
  return stage;
};

const captureStageToClipboard = async (stage: HTMLElement) => {
  const capture = window.electron?.share?.captureRectToClipboard;
  if (!capture) return false;

  const margin = 16;
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
  const scale = Math.min(
    1,
    (viewportWidth - margin * 2) / Math.max(1, stage.offsetWidth),
    (viewportHeight - margin * 2) / Math.max(1, stage.offsetHeight),
  );

  stage.style.transform = `scale(${scale})`;
  stage.style.visibility = 'visible';
  await waitForPaint();

  const rect = stage.getBoundingClientRect();
  const x = Math.max(0, Math.ceil(rect.left));
  const y = Math.max(0, Math.ceil(rect.top));
  const width = Math.max(1, Math.min(viewportWidth - x, Math.floor(rect.right) - x));
  const height = Math.max(1, Math.min(viewportHeight - y, Math.floor(rect.bottom) - y));

  return capture({ x, y, width, height });
};

const handleShareStats = async () => {
  if (sharingStats.value) return;
  if (!window.electron?.share?.captureRectToClipboard) {
    toastStore.unavailable('听歌统计');
    return;
  }

  sharingStats.value = true;
  let stage: HTMLElement | null = null;
  try {
    await nextTick();
    const shareText = buildHistoryStatsShareText();
    stage = createStatsCaptureStage(shareText);
    if (!stage) {
      toastStore.actionFailed('复制听歌统计');
      return;
    }

    await waitForImages(stage);
    await waitForPaint();
    const copied = await captureStageToClipboard(stage);
    if (copied) {
      toastStore.actionCompleted('听歌统计已复制');
    } else {
      toastStore.actionFailed('复制听歌统计');
    }
  } catch {
    toastStore.actionFailed('复制听歌统计');
  } finally {
    stage?.remove();
    sharingStats.value = false;
  }
};

const statsSecondaryActions = computed(() => [
  {
    icon: iconShare,
    label: '分享',
    onTap: handleShareStats,
    disabled: sharingStats.value,
  },
]);

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
  metadataDisposed = true;
  metadataGeneration++;
  unregisterContextMenu?.();
  if (animTimer) clearTimeout(animTimer);
});
</script>

<template>
  <PageScrollContainer class="history-view-container">
    <div class="history-view bg-bg-main min-h-full">
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="HISTORY"
        title="最近播放"
        :coverUrl="historyCoverUrl"
        :hasDetails="true"
        distribute-details
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="contents">
            <div class="text-[13px] font-semibold text-text-secondary">
              记录过往播放轨迹，快速回溯曾听过的歌曲与内容。
            </div>
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary"
            >
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconPlay" width="12" height="12" />
                <span>{{ displayedCountLabel }} 首歌曲</span>
              </div>
            </div>
          </div>
        </template>

        <template #actions>
          <ActionRow
            v-if="activeTab === 'songs'"
            :playDisabled="songCount === 0"
            :batchDisabled="songCount === 0"
            :secondaryActions="historySecondaryActions"
            @play="handlePlayAll"
            @batch="openBatchDrawer"
          />
          <ActionRow
            v-else
            :showPlaybackActions="false"
            :secondaryActions="statsSecondaryActions"
          />
        </template>

        <template #collapsed-actions>
          <template v-if="activeTab === 'songs'">
            <Button
              variant="unstyled"
              size="icon"
              :disabled="songCount === 0"
              @click="handlePlayAll"
              class="action-icon hover:bg-[var(--control-hover-bg)] text-primary-text"
            >
              <Icon :icon="iconPlay" width="20" height="20" />
            </Button>
            <Button
              variant="unstyled"
              size="icon"
              :disabled="songCount === 0"
              @click="openBatchDrawer"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            >
              <Icon :icon="iconList" width="18" height="18" />
            </Button>
            <Button
              variant="unstyled"
              size="icon"
              :disabled="songCount === 0"
              @click="openClearDialog"
              class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
              tooltip="清空播放历史"
              aria-label="清空播放历史"
            >
              <Icon :icon="iconTrash" width="18" height="18" />
            </Button>
          </template>

          <Button
            v-else
            variant="unstyled"
            size="icon"
            :disabled="sharingStats"
            @click="handleShareStats"
            class="action-icon hover:bg-[var(--control-hover-bg)] icon-action"
            tooltip="分享听歌统计"
            aria-label="分享听歌统计"
          >
            <Icon :icon="iconShare" width="18" height="18" />
          </Button>
        </template>
      </SliverHeader>

      <BatchActionDrawer
        v-model:open="showBatchDrawer"
        :songs="songs"
        item-key-field="historyKey"
        source-id="history"
        remove-context="history"
        :on-batch-remove="handleBatchRemove"
      />

      <Tabs
        :model-value="activeTab"
        class="w-full"
        :style="{ minHeight: tabsMinHeight }"
        @update:model-value="handleTabChange"
      >
        <PageStickyHeader
          class="song-list-sticky sticky z-110 bg-bg-main"
          :style="{ top: `${tabsTop}px` }"
        >
          <div class="px-6">
            <div class="border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="bg-transparent border-none gap-8">
                  <TabsTrigger value="songs">
                    <span class="badge-label">歌曲 <Badge :count="displayedCountLabel" /></span>
                  </TabsTrigger>
                  <TabsTrigger value="stats">
                    <span class="relative">统计</span>
                  </TabsTrigger>
                </TabsList>

                <div v-if="activeTab === 'songs'" class="flex items-center gap-2">
                  <SongSearchInput v-model="searchQuery" />
                  <Button
                    variant="unstyled"
                    size="icon"
                    @click="handleLocate"
                    class="action-icon song-locate-btn"
                    tooltip="定位当前播放"
                  >
                    <Icon :icon="iconCurrentLocation" width="16" height="16" />
                  </Button>
                </div>
                <div
                  v-else
                  class="hidden sm:flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary"
                >
                  <Icon :icon="iconClock" width="14" height="14" />
                  <span>最近 {{ historyStats.latestPlayedLabel }}</span>
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
        </PageStickyHeader>

        <div class="pb-12">
          <TabsContent value="songs" class="px-6">
            <div
              v-if="songCount === 0"
              class="history-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-card bg-primary/10 text-primary-text flex items-center justify-center mb-4"
              >
                <Icon :icon="iconClock" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">暂无播放历史</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary">
                最近播放的歌曲会展示在这里
              </div>
            </div>
            <div
              v-else-if="displayedSongs.length === 0"
              class="history-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-card bg-primary/10 text-primary-text flex items-center justify-center mb-4"
              >
                <Icon :icon="iconSearch" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">未找到相关歌曲</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary">换个关键词试试</div>
            </div>
            <div
              v-else
              class="history-song-list-wrapper"
              :class="{ 'is-scrolling-in': animatingList }"
            >
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
                  subtitle: '',
                  type: 'history',
                  dynamic: false,
                }"
                :enableDefaultDoubleTapPlay="true"
                :onSongDoubleTapPlay="
                  settingStore.playbackQueueMode === 'context' ? handleSongDoubleTapPlay : undefined
                "
              />
            </div>
          </TabsContent>

          <TabsContent value="stats" class="px-6 pt-5">
            <HistoryStatsContent
              ref="historyStatsRef"
              :stats="historyStats"
              :loading="statsLoading"
              :error-message="statsErrorMessage"
              @play="playStatSong"
              @retry="retryStats"
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  </PageScrollContainer>

  <Dialog
    v-model:open="showClearDialog"
    title="清空播放历史"
    description="确认清空全部本地播放历史？此操作不可撤销。"
  >
    <template #footer>
      <div class="flex justify-end gap-3">
        <Button variant="outline" size="default" @click="showClearDialog = false"> 取消 </Button>
        <Button variant="danger" size="default" :disabled="songCount === 0" @click="confirmClear">
          确认清空
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

/* ── 分享导出（对齐 Next HistoryStatsCapture：禁入场动画、隐藏播放按钮） ── */
.stats-content.is-share-capture {
  padding-bottom: 0;
}

.stats-content.is-share-capture :deep(.stats-enter) {
  opacity: 1 !important;
  animation: none !important;
}

.stats-content.is-share-capture :deep(.hero-play) {
  display: none;
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
