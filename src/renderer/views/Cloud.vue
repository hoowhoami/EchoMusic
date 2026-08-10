<script setup lang="ts">
defineOptions({ name: 'cloud' });
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { deleteCloudSongs, getUserCloud } from '@/api/user';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useUserStore } from '@/stores/user';
import { useThemeStore } from '@/stores/theme';
import { useToastStore } from '@/stores/toast';
import { useCloudUploadStore } from '@/stores/cloudUpload';
import { createThemedIconCoverUrl } from '@/utils/cover';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import CloudUploadDialog from '@/components/music/CloudUploadDialog.vue';
import { mapCloudSong } from '@/utils/mappers';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconCloud,
  iconCloudUpload,
  iconCurrentLocation,
  iconList,
  iconPlay,
  iconSearch,
} from '@/icons';
import { replaceQueueAndPlay } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import { clearCloudAudioIndex, refreshCloudAudioIndex } from '@/services/cloudAudioIndex';

const PAGE_SIZE = 100;

const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const cloudUploadStore = useCloudUploadStore();
const themeStore = useThemeStore();
const toastStore = useToastStore();

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
const deleteTarget = ref<Song | null>(null);
const deletingCloudSong = ref(false);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);
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

const cloudCoverUrl = computed(() => createThemedIconCoverUrl(themeStore.sourceColor, iconCloud));

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

const getCloudDefaultOrderValue = (song: Song, index: number) => ({
  addedAt: Number(song.cloudAddedAt ?? 0) || 0,
  sortOrder: Number(song.cloudSortOrder ?? 0) || 0,
  index,
});

const defaultOrderedSongs = computed(() => {
  return songs.value
    .map((song, index) => ({ song, order: getCloudDefaultOrderValue(song, index) }))
    .sort(
      (left, right) =>
        right.order.addedAt - left.order.addedAt ||
        left.order.sortOrder - right.order.sortOrder ||
        left.order.index - right.order.index,
    )
    .map((item) => item.song);
});

const sortedSongs = computed(() => {
  return sortSongs(defaultOrderedSongs.value, sortField.value, sortOrder.value, {
    indexSource: defaultOrderedSongs.value,
  });
});
const displayedSongs = computed(() => filterSongsByQuery(sortedSongs.value, searchQuery.value));

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
    void refreshCloudAudioIndex(true);
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
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    queueId: 'queue:cloud',
    title: '云盘音乐',
    subtitle: '你的云盘收藏',
    type: 'cloud',
    dynamic: false,
  });
};

const handlePlayAll = async () => {
  const queueSongs = displayedSongs.value.slice() as Song[];
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
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

const showUploadDialog = ref(false);

const canDeleteCloudSong = (song: Song) => {
  return Boolean(String(song.cloudFileId ?? '').trim() || String(song.hash ?? '').trim());
};

const openDeleteCloudSongDialog = (song: Song) => {
  if (!canDeleteCloudSong(song)) {
    toastStore.warning('缺少云盘文件标识，无法删除');
    return;
  }
  deleteTarget.value = song;
};

const closeDeleteCloudSongDialog = () => {
  if (deletingCloudSong.value) return;
  deleteTarget.value = null;
};

const confirmDeleteCloudSong = async () => {
  const song = deleteTarget.value;
  if (!song || deletingCloudSong.value) return;
  deletingCloudSong.value = true;
  try {
    await deleteCloudSongs([
      {
        cloudFileId: song.cloudFileId,
        hash: song.hash,
        albumAudioId: song.albumAudioId ?? song.mixSongId,
      },
    ]);
    songs.value = songs.value.filter((item) => item.id !== song.id);
    totalSongCount.value = Math.max(0, totalSongCount.value - 1);
    deleteTarget.value = null;
    toastStore.actionCompleted('已从云盘删除');
    void loadCloud();
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : '删除云盘歌曲失败';
    toastStore.warning(message);
  } finally {
    deletingCloudSong.value = false;
  }
};

const handleBatchDeleteCloudSongs = async (
  selectedSongs: Song[],
  onProgress?: (done: number, total: number) => void,
) => {
  const removableSongs = selectedSongs.filter(canDeleteCloudSong);
  const skippedCount = selectedSongs.length - removableSongs.length;
  if (removableSongs.length === 0) {
    throw new Error('缺少云盘文件标识，无法删除');
  }

  onProgress?.(0, selectedSongs.length);
  await deleteCloudSongs(
    removableSongs.map((song) => ({
      cloudFileId: song.cloudFileId,
      hash: song.hash,
      albumAudioId: song.albumAudioId ?? song.mixSongId,
    })),
  );
  onProgress?.(selectedSongs.length, selectedSongs.length);

  const removedIds = new Set(removableSongs.map((song) => song.id));
  songs.value = songs.value.filter((item) => !removedIds.has(item.id));
  totalSongCount.value = Math.max(0, totalSongCount.value - removableSongs.length);

  if (skippedCount > 0) {
    toastStore.warning(`已从云盘删除 ${removableSongs.length} 首，${skippedCount} 首缺少文件标识`);
  } else {
    toastStore.actionCompleted(`已从云盘删除 ${removableSongs.length} 首`);
  }
  void loadCloud();
};

const cloudContextMenuItems = computed(() => [
  {
    id: 'delete-cloud-song',
    label: '从云盘删除',
    danger: true,
    enabled: canDeleteCloudSong,
    onSelect: openDeleteCloudSongDialog,
  },
]);

const secondaryActions = computed(() => [
  {
    icon: iconCloudUpload,
    label: '上传',
    onTap: () => {
      cloudUploadStore.requestOpen('start');
    },
  },
]);

const handleLocate = () => songListRef.value?.scrollToActive?.();

const handleUploadOpenRequest = () => {
  if (!cloudUploadStore.consumeOpenRequest()) return;
  showUploadDialog.value = true;
};

watch(
  () => isLoggedIn.value,
  (loggedIn) => {
    if (loggedIn) {
      void loadCloud();
      return;
    }
    resetCloudState();
    clearCloudAudioIndex();
    // 登出时中止并清理上传任务（requestAbort 触发 onAbort 停止上传，dismiss 立即清理）
    cloudUploadStore.requestAbort();
    cloudUploadStore.dismiss();
  },
);

let lastUploadOpenRequested = cloudUploadStore.openRequested;
watch(
  () => cloudUploadStore.openRequested,
  (val) => {
    if (val !== lastUploadOpenRequested && val > 0) {
      lastUploadOpenRequested = val;
      handleUploadOpenRequest();
    }
  },
);

watch(
  () => cloudUploadStore.changedRevision,
  () => {
    if (isLoggedIn.value) void loadCloud();
  },
);

onMounted(() => {
  if (isLoggedIn.value) {
    void loadCloud();
  }
  handleUploadOpenRequest();
});
</script>

<template>
  <PageScrollContainer class="cloud-view-container">
    <div class="cloud-view bg-bg-main min-h-full">
      <div
        v-if="!isLoggedIn"
        class="cloud-login-empty flex flex-col items-center justify-center min-h-105 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5"
        >
          <Icon :icon="iconCloud" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">登录后查看云盘</div>
      </div>

      <template v-else>
        <SliverHeader
          ref="sliverHeaderRef"
          typeLabel="CLOUD"
          title="音乐云盘"
          :coverUrl="cloudCoverUrl"
          :hasDetails="true"
          :expandedHeight="176"
          :collapsedHeight="56"
        >
          <template #details>
            <div class="flex flex-col gap-2">
              <div class="text-[13px] font-semibold text-text-secondary">
                支持云端音乐浏览、播放与容量查看，随时畅听个人珍藏。
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
            <ActionRow
              @play="handlePlayAll"
              @batch="openBatchDrawer"
              :secondaryActions="secondaryActions"
            />
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
          source-id="cloud"
          remove-context="cloud"
          :on-batch-remove="handleBatchDeleteCloudSongs"
        />

        <CloudUploadDialog v-model:open="showUploadDialog" />

        <div class="px-6 pt-2.5 pb-1">
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

        <Tabs model-value="songs" class="w-full" :style="{ minHeight: tabsMinHeight }">
          <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
            <div class="px-6">
              <div class="border-b border-[var(--border-subtle)]">
                <div class="flex items-center justify-between h-14">
                  <TabsList class="bg-transparent border-none gap-8">
                    <TabsTrigger value="songs">
                      <span class="relative">歌曲 <Badge :count="displaySongCount" /></span>
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
            <div
              v-if="!loading && songs.length === 0"
              class="cloud-empty flex flex-col items-center justify-center py-24 text-center"
            >
              <div
                class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
              >
                <Icon :icon="iconCloud" width="28" height="28" />
              </div>
              <div class="text-[18px] font-semibold text-text-main">云盘暂无歌曲</div>
              <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
                上传后会展示在这里
              </div>
              <Button
                variant="primary"
                size="md"
                class="mt-5 gap-2"
                @click="cloudUploadStore.requestOpen('start')"
              >
                <Icon :icon="iconCloudUpload" width="16" height="16" />
                上传音乐
              </Button>
            </div>
            <SongList
              v-else
              ref="songListRef"
              :loading="loading"
              :songs="displayedSongs"
              :contextSongs="sortedSongs"
              :searchQuery="searchQuery"
              :disableInternalFilter="true"
              :activeId="activeSongId"
              :showCover="true"
              :queueOptions="{
                queueId: 'queue:cloud',
                title: '云盘音乐',
                subtitle: '你的云盘收藏',
                type: 'cloud',
                dynamic: false,
              }"
              :contextMenuItems="cloudContextMenuItems"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
              "
            />
            <div v-if="!loading && isBackgroundResolving" class="flex justify-center pt-4">
              <div class="text-[12px] font-semibold text-text-secondary/70">
                正在后台补全剩余云盘歌曲...
              </div>
            </div>
          </div>
        </Tabs>

        <Dialog
          :open="Boolean(deleteTarget)"
          title="删除云盘歌曲"
          :description="
            deleteTarget
              ? `确认从云盘删除『${deleteTarget.title || deleteTarget.name || '这首歌'}』？此操作无法撤销。`
              : ''
          "
          :close-on-interact-outside="!deletingCloudSong"
          @update:open="(value) => !value && closeDeleteCloudSongDialog()"
        >
          <template #footer>
            <Button
              variant="outline"
              size="sm"
              :disabled="deletingCloudSong"
              @click="closeDeleteCloudSongDialog"
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              :loading="deletingCloudSong"
              @click="confirmDeleteCloudSong"
            >
              确认删除
            </Button>
          </template>
        </Dialog>
      </template>
    </div>
  </PageScrollContainer>
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
  background: var(--control-muted-bg);
  border: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow-control);
}

.cloud-progress-track {
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--control-track-bg);
}

.cloud-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
}
</style>
