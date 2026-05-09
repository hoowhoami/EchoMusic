<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Drawer from '@/components/ui/Drawer.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { formatDuration } from '@/utils/format';
import SongCard from '@/components/music/SongCard.vue';
import { useVirtualList } from '@vueuse/core';
import { isPlayableSong } from '@/utils/song';
import { replaceQueueAndPlay } from '@/utils/playback';
import { useToastStore } from '@/stores/toast';
import { iconList, iconPlay, iconPlus, iconTrash, iconX } from '@/icons';
import { MANUAL_PLAYBACK_QUEUE_ID, PERSONAL_FM_QUEUE_ID } from '@/stores/playlist';

interface Props {
  open?: boolean;
  songs: Song[];
  sourceId?: string | number;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  sourceId: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const selectedKeys = ref<Set<string>>(new Set());
const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);

// 删除二次确认
const showRemoveConfirm = ref(false);

// 批量操作进度状态（删除 / 添加到歌单）
type BatchOpType = 'remove' | 'addPlaylist' | null;
const batchOp = ref<BatchOpType>(null);
const batchProgress = ref({ done: 0, total: 0 });
const isBatchBusy = computed(() => batchOp.value !== null);

const selectedSongs = computed(() =>
  props.songs.filter((song) => selectedKeys.value.has(String(song.id))),
);

const isAllSelected = computed(
  () => props.songs.length > 0 && selectedKeys.value.size === props.songs.length,
);

const isIndeterminate = computed(() => selectedKeys.value.size > 0 && !isAllSelected.value);

type CheckboxState = boolean | 'indeterminate';

const selectAllState = computed<CheckboxState>(() => {
  if (isAllSelected.value) return true;
  if (isIndeterminate.value) return 'indeterminate';
  return false;
});

const toggleSelectAll = () => {
  if (isAllSelected.value) {
    selectedKeys.value = new Set();
    return;
  }
  selectedKeys.value = new Set(props.songs.map((song) => String(song.id)));
};

const toggleSong = (song: Song) => {
  const key = String(song.id);
  const next = new Set(selectedKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  selectedKeys.value = next;
};

const setSongChecked = (song: Song, value: CheckboxState) => {
  const key = String(song.id);
  const next = new Set(selectedKeys.value);
  if (value === true) {
    next.add(key);
  } else {
    next.delete(key);
  }
  selectedKeys.value = next;
};

const clearSelection = () => {
  selectedKeys.value = new Set();
};

watch(
  () => open.value,
  (value) => {
    if (!value) {
      clearSelection();
    }
  },
);

watch(
  () => props.songs,
  () => {
    clearSelection();
  },
);

const itemHeight = 56;
const { list, containerProps, wrapperProps } = useVirtualList(
  computed(() => props.songs),
  {
    itemHeight,
  },
);

const createdPlaylists = computed(() => playlistStore.getCreatedPlaylists(userStore.info?.userid));

const addToPlaybackQueues = computed(() =>
  playlistStore.playbackQueueList.filter(
    (queue) => queue.id !== PERSONAL_FM_QUEUE_ID && queue.songs.length > 0,
  ),
);

const canPlaySelected = computed(() => selectedSongs.value.some((song) => isPlayableSong(song)));
const canAddSelected = computed(() => userStore.isLoggedIn && selectedSongs.value.length > 0);
const canRemoveSelected = computed(
  () =>
    Boolean(props.sourceId) &&
    userStore.isLoggedIn &&
    selectedSongs.value.length > 0 &&
    playlistStore.isOwnedPlaylist(props.sourceId, userStore.info?.userid),
);

const handlePlaySelected = async () => {
  if (!canPlaySelected.value) return;
  try {
    const played = await replaceQueueAndPlay(playlistStore, playerStore, selectedSongs.value);
    if (played) {
      open.value = false;
    } else {
      toastStore.unavailable('当前歌曲');
    }
  } catch {
    toastStore.actionFailed('播放');
  }
};

const handleAddToPlaylist = async () => {
  if (!canAddSelected.value) return;
  if (isBatchBusy.value) return;
  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    try {
      await playlistStore.fetchUserPlaylists();
    } catch {
      toastStore.loadFailed('歌单');
    }
    isPlaylistLoading.value = false;
  }
};

const handleAddToQueue = (queueId?: string) => {
  if (selectedSongs.value.length === 0) return;
  const options = queueId ? { queueId } : {};
  const addedCount = playlistStore.appendToPlaybackQueue?.(selectedSongs.value, options) ?? 0;
  if (addedCount > 0) {
    toastStore.actionCompleted(
      queueId === MANUAL_PLAYBACK_QUEUE_ID
        ? `已添加 ${addedCount} 首到我的队列`
        : `已添加 ${addedCount} 首到队列`,
    );
  } else {
    toastStore.actionCompleted(
      queueId === MANUAL_PLAYBACK_QUEUE_ID ? '所选歌曲已在我的队列中' : '所选歌曲已在队列中',
    );
  }
  showPlaylistDialog.value = false;
  open.value = false;
};

const handleSelectPlaylist = async (listId: string | number) => {
  if (isBatchBusy.value) return;
  const total = selectedSongs.value.length;
  if (total === 0) return;

  // 反转顺序：歌单默认按加入时间倒序展示，反向提交可让界面顺序与用户所见一致
  const songsToAdd = [...selectedSongs.value].reverse();
  const targetName =
    createdPlaylists.value.find((p) => String(p.listid ?? p.id) === String(listId))?.name ?? '歌单';

  showPlaylistDialog.value = false;
  batchOp.value = 'addPlaylist';
  batchProgress.value = { done: 0, total };

  try {
    const { successCount, failedCount } = await playlistStore.addSongsToPlaylist(
      listId,
      songsToAdd,
      (done, tot) => {
        batchProgress.value = { done, total: tot };
      },
    );
    if (successCount > 0 && failedCount === 0) {
      toastStore.actionCompleted(`已添加 ${successCount} 首到『${targetName}』`);
      open.value = false;
    } else if (successCount > 0 && failedCount > 0) {
      toastStore.warning(`已添加 ${successCount} 首到『${targetName}』，${failedCount} 首失败`);
    } else {
      toastStore.actionFailed('添加到歌单');
    }
  } catch {
    toastStore.actionFailed('添加到歌单');
  } finally {
    batchOp.value = null;
    batchProgress.value = { done: 0, total: 0 };
  }
};

const handleRemoveFromPlaylist = () => {
  if (!canRemoveSelected.value) return;
  if (isBatchBusy.value) return;
  showRemoveConfirm.value = true;
};

const confirmRemoveFromPlaylist = async () => {
  if (!canRemoveSelected.value) return;
  const total = selectedSongs.value.length;
  if (total === 0) return;

  showRemoveConfirm.value = false;
  batchOp.value = 'remove';
  batchProgress.value = { done: 0, total };

  const songsToRemove = [...selectedSongs.value];

  try {
    const { successCount, failedCount } = await playlistStore.removeSongsFromPlaylist(
      String(props.sourceId),
      songsToRemove,
      (done, tot) => {
        batchProgress.value = { done, total: tot };
      },
    );
    if (successCount > 0 && failedCount === 0) {
      toastStore.actionCompleted(`已从歌单移除 ${successCount} 首`);
      open.value = false;
    } else if (successCount > 0 && failedCount > 0) {
      toastStore.warning(`已移除 ${successCount} 首，${failedCount} 首失败`);
    } else {
      toastStore.actionFailed('从歌单移除');
    }
  } catch {
    toastStore.actionFailed('从歌单移除');
  } finally {
    batchOp.value = null;
    batchProgress.value = { done: 0, total: 0 };
  }
};
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    overlayClass="batch-drawer-overlay"
    panelClass="batch-drawer"
  >
    <div class="batch-header">
      <div class="batch-title">批量操作</div>
      <div class="batch-actions">
        <Button
          type="button"
          class="batch-action"
          variant="secondary"
          size="xs"
          :disabled="!canPlaySelected || isBatchBusy"
          @click="handlePlaySelected"
        >
          <Icon :icon="iconPlay" width="16" height="16" />
          播放
        </Button>
        <Button
          type="button"
          class="batch-action"
          variant="secondary"
          size="xs"
          :disabled="!canAddSelected || isBatchBusy"
          :loading="batchOp === 'addPlaylist'"
          @click="handleAddToPlaylist"
        >
          <Icon v-if="batchOp !== 'addPlaylist'" :icon="iconPlus" width="16" height="16" />
          <template v-if="batchOp === 'addPlaylist'">
            添加中 {{ batchProgress.done }}/{{ batchProgress.total }}
          </template>
          <template v-else>添加到</template>
        </Button>
        <Button
          type="button"
          class="batch-action danger"
          variant="ghost"
          size="xs"
          :disabled="!canRemoveSelected || isBatchBusy"
          :loading="batchOp === 'remove'"
          @click="handleRemoveFromPlaylist"
        >
          <Icon v-if="batchOp !== 'remove'" :icon="iconTrash" width="16" height="16" />
          <template v-if="batchOp === 'remove'">
            删除中 {{ batchProgress.done }}/{{ batchProgress.total }}
          </template>
          <template v-else>删除</template>
        </Button>
      </div>
      <Button
        type="button"
        class="batch-close"
        variant="ghost"
        size="xs"
        aria-label="关闭"
        :disabled="isBatchBusy"
        @click="open = false"
      >
        <Icon :icon="iconX" width="14" height="14" />
      </Button>
    </div>

    <div class="batch-selection">
      <Button type="button" class="batch-select" variant="ghost" size="xs" @click="toggleSelectAll">
        <CheckboxRoot
          class="batch-checkbox"
          :model-value="selectAllState"
          @update:model-value="toggleSelectAll"
          @click.stop
        >
          <CheckboxIndicator as-child>
            <span class="batch-checkbox-indicator"></span>
          </CheckboxIndicator>
        </CheckboxRoot>
        全选
      </Button>
      <div class="batch-count">已选 {{ selectedKeys.size }} / {{ songs.length }}</div>
    </div>

    <div class="batch-list">
      <Scrollbar class="flex-1 min-h-0" :scrollbar-inset="4" :content-props="containerProps">
        <div v-bind="wrapperProps" class="batch-list-inner">
          <div
            v-for="entry in list"
            :key="entry.data.id"
            class="batch-row"
            :class="{ 'text-primary': selectedKeys.has(String(entry.data.id)) }"
            :style="{ height: `${itemHeight}px` }"
            @click="toggleSong(entry.data)"
          >
            <div class="batch-leading" @click.stop>
              <CheckboxRoot
                class="batch-checkbox"
                :model-value="selectedKeys.has(String(entry.data.id))"
                @update:model-value="setSongChecked(entry.data, $event)"
              >
                <CheckboxIndicator as-child>
                  <span class="batch-checkbox-indicator"></span>
                </CheckboxIndicator>
              </CheckboxRoot>
            </div>
            <div class="batch-card" :style="{ opacity: isPlayableSong(entry.data) ? 1 : 0.45 }">
              <SongCard
                :id="entry.data.id"
                :hash="entry.data.hash"
                :title="entry.data.title"
                :artist="entry.data.artist"
                :artists="entry.data.artists"
                :album="entry.data.album"
                :albumId="entry.data.albumId"
                :coverUrl="entry.data.coverUrl"
                :duration="entry.data.duration"
                :audioUrl="entry.data.audioUrl"
                :source="entry.data.source"
                :mvHash="entry.data.mvHash"
                :mixSongId="entry.data.mixSongId"
                :fileId="entry.data.fileId"
                :privilege="entry.data.privilege"
                :payType="entry.data.payType"
                :oldCpy="entry.data.oldCpy"
                :relateGoods="entry.data.relateGoods"
                :queueContext="props.songs"
                :showCover="true"
                :showAlbum="false"
                :showDuration="false"
                :active="false"
                :showMore="false"
                :disableLinks="true"
                variant="list"
              />
            </div>
            <div class="batch-album">{{ entry.data.album || '未知专辑' }}</div>
            <div class="batch-duration">{{ formatDuration(entry.data.duration) }}</div>
          </div>
        </div>

        <div v-if="props.songs?.length === 0" class="batch-empty">暂无歌曲</div>
      </Scrollbar>
    </div>
  </Drawer>

  <Dialog
    v-model:open="showPlaylistDialog"
    title="添加到"
    overlayClass="batch-playlist-overlay"
    contentClass="batch-playlist-dialog max-w-[420px]"
    showClose
  >
    <div class="batch-playlist-body">
      <div class="batch-playlist-divider"><span>播放队列</span></div>
      <div v-if="addToPlaybackQueues.length === 0" class="batch-playlist-status">暂无播放队列</div>
      <Button
        v-for="queue in addToPlaybackQueues"
        :key="queue.id"
        type="button"
        class="playlist-picker-item playlist-picker-queue"
        variant="ghost"
        size="sm"
        @click="handleAddToQueue(queue.id)"
      >
        <span class="batch-playlist-name">
          <Icon :icon="iconList" width="16" height="16" />
          {{ queue.title || '播放队列' }}
        </span>
        <span class="batch-playlist-count">{{ queue.songs.length }} 首</span>
      </Button>
      <div class="batch-playlist-divider">
        <span>歌单</span>
      </div>
      <div v-if="isPlaylistLoading" class="batch-playlist-status">加载歌单中...</div>
      <div v-else-if="createdPlaylists.length === 0" class="batch-playlist-status">
        暂无可用歌单
      </div>
      <Button
        v-for="entry in createdPlaylists"
        :key="entry.listid ?? entry.id"
        type="button"
        class="playlist-picker-item"
        variant="ghost"
        size="sm"
        @click="handleSelectPlaylist(entry.listid ?? entry.id)"
      >
        <span class="batch-playlist-name">{{ entry.name }}</span>
        <span class="batch-playlist-count">{{ entry.count ?? 0 }} 首</span>
      </Button>
    </div>
  </Dialog>

  <Dialog
    v-model:open="showRemoveConfirm"
    title="从歌单移除"
    :description="`确认从当前歌单移除选中的 ${selectedKeys.size} 首歌曲？此操作无法撤销。`"
    overlayClass="batch-playlist-overlay"
    contentClass="batch-playlist-dialog max-w-[420px]"
  >
    <template #footer>
      <Button variant="outline" size="sm" @click="showRemoveConfirm = false">取消</Button>
      <Button variant="danger" size="sm" @click="confirmRemoveFromPlaylist">确认移除</Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.batch-drawer-overlay) {
  background: rgba(0, 0, 0, 0.22);
}

:global(.batch-drawer) {
  padding: 0;
  box-shadow: none;
  width: min(600px, 96vw);
  top: 0;
  bottom: 0;
}

.batch-header {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 12px;
  padding: 16px 18px 12px 20px;
  user-select: none;
  -webkit-user-select: none;
}

.batch-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  background: rgba(0, 0, 0, 0.04);
  transition:
    transform 0.2s ease,
    background-color 0.2s ease,
    color 0.2s ease;
}

.batch-action:hover {
  transform: scale(1.02);
  color: var(--color-primary);
  background: rgba(0, 0, 0, 0.08);
}

.dark .batch-action {
  background: rgba(255, 255, 255, 0.08);
}

.dark .batch-action:hover {
  background: rgba(255, 255, 255, 0.12);
}

.batch-action.danger {
  color: #ef4444;
}

.batch-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.batch-close {
  @apply h-8 w-8 min-w-0 p-0 text-text-main/50 hover:text-text-main;
}

.batch-selection {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px 12px 18px;
  font-size: 12px;
  color: var(--color-text-secondary);
  user-select: none;
  -webkit-user-select: none;
}

.batch-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
  padding-right: 12px;
  font-weight: 600;
  color: var(--color-text-main);
}

.batch-count {
  font-weight: 600;
}

.batch-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0 0 16px 18px;
  user-select: none;
  -webkit-user-select: none;
}

.batch-list-inner {
  padding-right: 14px;
}

.batch-empty {
  padding: 20px 0 28px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.batch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0;
  border-radius: 8px;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}

.batch-row.text-primary {
  background: var(--color-bg-card);
}

.dark .batch-row.text-primary {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.batch-row:hover {
  background: var(--color-bg-card);
}

.dark .batch-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.batch-leading {
  width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.batch-checkbox {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--color-border-light);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.batch-checkbox[data-state='checked'],
.batch-checkbox[data-state='indeterminate'] {
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.batch-checkbox-indicator {
  width: 8px;
  height: 8px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.batch-checkbox[data-state='checked'] .batch-checkbox-indicator::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 7px;
  border: 2px solid #fff;
  border-top: none;
  border-left: none;
  transform: translate(-50%, -55%) rotate(45deg);
}

.batch-checkbox[data-state='indeterminate'] .batch-checkbox-indicator::after {
  content: '';
  width: 8px;
  height: 2px;
  border: none;
  background: #fff;
  border-radius: 999px;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.batch-card {
  min-width: 0;
  flex: 1;
  user-select: none;
  -webkit-user-select: none;
}

.batch-card :deep(.song-card),
.batch-card :deep(.song-content),
.batch-card :deep(.song-title),
.batch-card :deep(.song-subline),
.batch-card :deep(img) {
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

.batch-card :deep(.song-actions) {
  display: none;
}

.batch-album {
  width: 180px;
  flex: 0 1 180px;
  min-width: 0;
  display: block;
  font-size: 12px;
  opacity: 0.7;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  -webkit-user-select: none;
}

.batch-duration {
  width: 64px;
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.5;
  color: var(--color-text-secondary);
  user-select: none;
  -webkit-user-select: none;
}

@media (max-width: 720px) {
  :global(.batch-drawer) {
    bottom: 0;
    width: 94vw;
  }
}

.batch-playlist-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.batch-playlist-status {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.batch-playlist-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
}

.batch-playlist-count {
  font-size: 11px;
  color: var(--color-text-secondary);
}

:global(.batch-playlist-overlay) {
  z-index: 1600 !important;
}

:global(.batch-playlist-dialog) {
  z-index: 1610 !important;
}

.playlist-picker-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-main);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.playlist-picker-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.playlist-picker-queue {
  border-style: dashed;
}

.playlist-picker-queue .batch-playlist-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.batch-playlist-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
</style>
