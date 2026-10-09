<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import Switch from '@/components/ui/Switch.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import { iconCheckMark, iconList } from '@/icons';
import type { Playlist } from '@/models/playlist';
import type { Song } from '@/models/song';
import { usePlaylistStore } from '@/stores/playlist';
import { orderByPlaylistPosition } from '@/utils/playlistOrder';
import type { PlaybackQueueState } from '@/stores/playlist/types';
import { includesPlaylistIdentity } from '@/stores/playlist/helpers';
import { getPlaybackQueuePresentation } from '@/utils/playbackQueuePresentation';
import { addTargetKey, useMultiTargetAdd } from '@/composables/useMultiTargetAdd';
import { useCachedOverlayOpen } from '@/composables/useCachedOverlayOpen';

interface Props {
  open?: boolean;
  title?: string;
  playbackQueues?: PlaybackQueueState[];
  playlists?: Playlist[];
  songs: readonly Song[];
  reversePlaylistSongs?: boolean;
  addPlaylist: (listId: string | number) => void | Promise<void>;
  loading?: boolean;
  disabled?: boolean;
  showPlaybackQueues?: boolean;
  overlayClass?: string;
  contentClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '添加到',
  playbackQueues: () => [],
  playlists: () => [],
  reversePlaylistSongs: false,
  loading: false,
  disabled: false,
  showPlaybackQueues: true,
  overlayClass: '',
  contentClass: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'selectQueue', queueId: string): void;
  (e: 'added'): void;
  (e: 'update:busy', value: boolean): void;
}>();

const open = useCachedOverlayOpen(useVModel(props, 'open', emit, { defaultValue: false }));
const playlistStore = usePlaylistStore();
const singleBusy = ref(false);
let singleOperation = 0;
watch(
  open,
  () => {
    singleOperation++;
    singleBusy.value = false;
  },
  { flush: 'sync' },
);
const {
  multiple,
  selectedIds,
  busy,
  results,
  progress,
  songs,
  failedIds,
  hasResults,
  toggleMode,
  toggleTarget,
  submit,
} = useMultiTargetAdd({
  open,
  songs: () => props.songs,
  playlists: () => props.playlists,
  playbackQueues: () => (props.showPlaybackQueues ? props.playbackQueues : []),
  reversePlaylistSongs: () => props.reversePlaylistSongs,
  disabled: () => props.disabled || props.loading || singleBusy.value,
  onComplete: () => {
    emit('added');
    open.value = false;
  },
});
watch(busy, (value) => emit('update:busy', value), { flush: 'sync' });
const isBusy = computed(() => busy.value || singleBusy.value);

const setMultipleMode = (enabled: boolean) => {
  if (enabled !== multiple.value) toggleMode();
};

const selectableTargetKeys = computed(() => {
  const queues = props.showPlaybackQueues
    ? props.playbackQueues.map((queue) => addTargetKey('queue', queue.id))
    : [];
  const playlists = props.playlists.map((entry) =>
    addTargetKey('playlist', entry.listid ?? entry.id),
  );
  return [...new Set([...queues, ...playlists])];
});
const selectedTargetCount = computed(
  () => selectableTargetKeys.value.filter((key) => selectedIds.value.has(key)).length,
);
const selectAllState = computed<boolean | 'indeterminate'>(() => {
  if (selectedTargetCount.value === 0) return false;
  return selectedTargetCount.value === selectableTargetKeys.value.length ? true : 'indeterminate';
});
const canSelectAll = computed(
  () =>
    multiple.value &&
    !props.loading &&
    !props.disabled &&
    !isBusy.value &&
    !hasResults.value &&
    selectableTargetKeys.value.length > 0,
);
const setSelectAll = (checked: boolean | 'indeterminate') => {
  if (!canSelectAll.value) return;
  selectedIds.value = new Set(checked === false ? [] : selectableTargetKeys.value);
};

const selectPlaylist = async (entry: Playlist) => {
  if (props.loading || props.disabled || isBusy.value) return;
  const id = entry.listid ?? entry.id;
  if (multiple.value) {
    toggleTarget('playlist', id);
  } else {
    const operation = ++singleOperation;
    singleBusy.value = true;
    try {
      await props.addPlaylist(id);
    } finally {
      if (operation === singleOperation) singleBusy.value = false;
    }
  }
};

const selectQueue = (id: string) => {
  if (props.disabled || isBusy.value) return;
  if (multiple.value) toggleTarget('queue', id);
  else emit('selectQueue', id);
};

const targetNoun = computed(() =>
  props.showPlaybackQueues && props.playbackQueues.length > 0 ? '目标' : '歌单',
);

const resultLabel = (id: string) => {
  const result = results.value[id];
  if (!result) return '';
  if (result.state === 'pending') return '等待添加';
  if (result.state === 'adding') return '添加中…';
  if (result.state === 'exists') return '已存在';
  if (result.state === 'added') return '添加成功';
  return result.addedCount > 0
    ? `已添加 ${result.addedCount} 首，${result.failedSongs.length} 首失败`
    : '添加失败';
};

const contentClass = computed(() =>
  ['add-to-dialog max-w-[420px]', props.contentClass].filter(Boolean).join(' '),
);

const isPinnedPlaylist = (playlist: Playlist) => {
  if (playlist.source !== 2 && playlist.type === 0 && playlist.isDefault === true) return true;
  const likedId = String(playlistStore.likedPlaylistQueryId ?? '');
  return Boolean(likedId) && includesPlaylistIdentity(playlist, likedId);
};

const orderedPlaylists = computed(() => {
  const pinned: Playlist[] = [];
  const normal: Playlist[] = [];
  for (const playlist of props.playlists) {
    if (isPinnedPlaylist(playlist)) pinned.push(playlist);
    else normal.push(playlist);
  }
  return [...pinned, ...orderByPlaylistPosition(normal, (playlist) => playlist.sortOrder)];
});
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="title"
    :overlayClass="overlayClass"
    :contentClass="contentClass"
    showClose
  >
    <template #headerActions>
      <label v-if="songs.length > 0" class="add-to-mode">
        <span>多选</span>
        <Switch
          size="sm"
          :model-value="multiple"
          :disabled="loading || disabled || isBusy || hasResults"
          aria-label="多选模式"
          @update:model-value="setMultipleMode"
        />
      </label>
    </template>
    <div class="add-to-body">
      <template v-if="showPlaybackQueues">
        <div class="add-to-divider"><span>播放队列</span></div>
        <div v-if="playbackQueues.length === 0" class="add-to-status">暂无播放队列</div>
        <Button
          v-for="queue in playbackQueues"
          :key="queue.id"
          type="button"
          class="add-to-item add-to-queue"
          :class="{
            'add-to-selected': multiple && selectedIds.has(addTargetKey('queue', queue.id)),
          }"
          variant="ghost"
          size="sm"
          :disabled="disabled || isBusy || (multiple && hasResults)"
          :role="multiple ? 'checkbox' : undefined"
          :aria-checked="multiple ? selectedIds.has(addTargetKey('queue', queue.id)) : undefined"
          @click="selectQueue(queue.id)"
        >
          <span class="add-to-playlist-name">
            <span
              v-if="multiple"
              class="add-to-checkbox"
              :class="{ 'is-checked': selectedIds.has(addTargetKey('queue', queue.id)) }"
              aria-hidden="true"
            >
              <Icon
                v-if="selectedIds.has(addTargetKey('queue', queue.id))"
                :icon="iconCheckMark"
                width="14"
                height="14"
              />
            </span>
            <span class="add-to-name">
              <Icon class="add-to-queue-icon" :icon="iconList" width="16" height="16" />
              <span class="add-to-title" :title="getPlaybackQueuePresentation(queue).title">
                {{ getPlaybackQueuePresentation(queue).title }}
              </span>
            </span>
          </span>
          <span
            v-if="multiple && resultLabel(addTargetKey('queue', queue.id))"
            class="add-to-count"
            :class="{
              'add-to-failed': results[addTargetKey('queue', queue.id)]?.state === 'failed',
            }"
            >{{ resultLabel(addTargetKey('queue', queue.id)) }}</span
          >
          <span v-else class="add-to-count">{{ queue.songCount ?? queue.songs.length }} 首</span>
        </Button>
      </template>

      <div class="add-to-divider">
        <span>歌单</span>
      </div>
      <div v-if="loading" class="add-to-skeleton" aria-busy="true">
        <div v-for="item in 4" :key="item" class="add-to-item">
          <Skeleton variant="text" width="56%" height="13px" />
          <Skeleton variant="text" width="42px" height="11px" />
        </div>
      </div>
      <div v-else-if="orderedPlaylists.length === 0" class="add-to-status">暂无可用歌单</div>
      <Button
        v-for="entry in orderedPlaylists"
        :key="entry.listid ?? entry.id"
        type="button"
        class="add-to-item"
        :class="{
          'add-to-selected':
            multiple && selectedIds.has(addTargetKey('playlist', entry.listid ?? entry.id)),
        }"
        variant="ghost"
        size="sm"
        :disabled="loading || disabled || isBusy || (multiple && hasResults)"
        :role="multiple ? 'checkbox' : undefined"
        :aria-checked="
          multiple ? selectedIds.has(addTargetKey('playlist', entry.listid ?? entry.id)) : undefined
        "
        @click="selectPlaylist(entry)"
      >
        <span class="add-to-playlist-name">
          <span
            v-if="multiple"
            class="add-to-checkbox"
            :class="{
              'is-checked': selectedIds.has(addTargetKey('playlist', entry.listid ?? entry.id)),
            }"
            aria-hidden="true"
          >
            <Icon
              v-if="selectedIds.has(addTargetKey('playlist', entry.listid ?? entry.id))"
              :icon="iconCheckMark"
              width="14"
              height="14"
            />
          </span>
          <span class="add-to-name" :title="entry.name">{{ entry.name }}</span>
        </span>
        <span
          v-if="multiple && resultLabel(addTargetKey('playlist', entry.listid ?? entry.id))"
          class="add-to-count"
          :class="{
            'add-to-failed':
              results[addTargetKey('playlist', entry.listid ?? entry.id)]?.state === 'failed',
          }"
        >
          {{ resultLabel(addTargetKey('playlist', entry.listid ?? entry.id)) }}
        </span>
        <span v-else class="add-to-count">{{ entry.count ?? 0 }} 首</span>
      </Button>
      <p v-if="multiple && failedIds.length > 0 && !busy" class="add-to-error" role="status">
        {{ failedIds.length }} 个{{ targetNoun }}有歌曲添加失败，重试只处理失败的歌曲。
      </p>
    </div>
    <template v-if="multiple" #footer>
      <div class="add-to-footer" aria-live="polite">
        <div class="add-to-selection">
          <label class="add-to-select-all">
            <Checkbox
              :model-value="selectAllState"
              :disabled="!canSelectAll"
              :ariaLabel="selectAllState === true ? '取消全选' : '全选'"
              @update:model-value="setSelectAll"
            />
            <span
              class="add-to-count"
              :title="`已选择 ${selectedTargetCount} 个，可选 ${selectableTargetKeys.length} 个`"
              >{{ selectedTargetCount }}/{{ selectableTargetKeys.length }}</span
            >
          </label>
          <span v-if="busy" class="add-to-count">
            添加中 {{ progress.done }}/{{ progress.total }}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" :disabled="busy" @click="open = false">
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          :loading="busy"
          :disabled="loading || disabled || selectedIds.size === 0 || songs.length === 0"
          @click="submit(failedIds.length > 0)"
        >
          {{ failedIds.length > 0 ? '重试失败项' : `添加到 ${selectedIds.size} 个${targetNoun}` }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-content.add-to-dialog .dialog-header) {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-right: 64px;
}

:global(.dialog-content.add-to-dialog .dialog-title) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.dialog-content.add-to-dialog .dialog-header-actions) {
  position: static;
  flex-shrink: 0;
  margin-left: auto;
}

:global(.dialog-content.add-to-dialog .dialog-close) {
  top: 22px;
}

.add-to-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-to-mode {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-to-status {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-to-name,
.add-to-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-to-count {
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.add-to-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-item);
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-main);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.add-to-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary-text);
}

.add-to-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-to-queue {
  border-style: dashed;
}

.add-to-queue .add-to-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.add-to-queue-icon {
  flex-shrink: 0;
}

.add-to-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-to-playlist-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.add-to-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid var(--control-checkbox-border);
  border-radius: var(--radius-detail);
  background: var(--control-checkbox-bg);
}

.add-to-checkbox.is-checked {
  border-color: var(--control-checkbox-active-border);
  background: var(--control-active-bg);
  color: var(--control-checkbox-indicator);
}

.add-to-selected {
  border-color: var(--control-checkbox-active-border);
}

.add-to-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.add-to-selection {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-right: auto;
}

.add-to-select-all {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.add-to-failed,
.add-to-error {
  color: var(--state-danger);
}

.add-to-error {
  font-size: 12px;
  line-height: 1.6;
}
</style>
