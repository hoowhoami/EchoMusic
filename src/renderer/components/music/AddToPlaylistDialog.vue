<script setup lang="ts">
import { computed } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { iconList } from '@/icons';
import type { Playlist } from '@/models/playlist';
import { sortPlaylists, usePlaylistStore } from '@/stores/playlist';
import type { PlaybackQueueState, PlaylistSortOrder } from '@/stores/playlist/types';
import { includesPlaylistIdentity } from '@/stores/playlist/helpers';
import { useSettingStore } from '@/stores/setting';

interface Props {
  open?: boolean;
  title?: string;
  playbackQueues?: PlaybackQueueState[];
  playlists?: Playlist[];
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
  loading: false,
  disabled: false,
  showPlaybackQueues: true,
  overlayClass: 'add-to-overlay',
  contentClass: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'selectQueue', queueId: string): void;
  (e: 'selectPlaylist', listId: string | number): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const playlistStore = usePlaylistStore();
const settingStore = useSettingStore();

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
  return [...pinned, ...sortPlaylists(normal, settingStore.playlistSortOrder as PlaylistSortOrder)];
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
    <div class="add-to-body">
      <template v-if="showPlaybackQueues">
        <div class="add-to-divider"><span>播放队列</span></div>
        <div v-if="playbackQueues.length === 0" class="add-to-status">暂无播放队列</div>
        <Button
          v-for="queue in playbackQueues"
          :key="queue.id"
          type="button"
          class="add-to-item add-to-queue"
          variant="ghost"
          size="sm"
          :disabled="disabled"
          @click="emit('selectQueue', queue.id)"
        >
          <span class="add-to-name">
            <Icon :icon="iconList" width="16" height="16" />
            {{ queue.title || '播放队列' }}
          </span>
          <span class="add-to-count">{{ queue.songCount ?? queue.songs.length }} 首</span>
        </Button>
      </template>

      <div class="add-to-divider">
        <span>歌单</span>
      </div>
      <div v-if="loading" class="add-to-status">加载歌单中...</div>
      <div v-else-if="orderedPlaylists.length === 0" class="add-to-status">暂无可用歌单</div>
      <Button
        v-for="entry in orderedPlaylists"
        :key="entry.listid ?? entry.id"
        type="button"
        class="add-to-item"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        @click="emit('selectPlaylist', entry.listid ?? entry.id)"
      >
        <span class="add-to-name">{{ entry.name }}</span>
        <span class="add-to-count">{{ entry.count ?? 0 }} 首</span>
      </Button>
    </div>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.add-to-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-to-status {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-to-name {
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
  font-size: 11px;
  color: var(--color-text-secondary);
}

:global(.add-to-overlay) {
  z-index: 1600 !important;
}

:global(.add-to-dialog) {
  z-index: 1610 !important;
}

.add-to-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-main);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.add-to-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.add-to-queue {
  border-style: dashed;
}

.add-to-queue .add-to-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.add-to-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
</style>
