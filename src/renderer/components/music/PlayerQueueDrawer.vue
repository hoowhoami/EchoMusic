<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, onMounted } from 'vue';
import { useVModel, useVirtualList } from '@vueuse/core';
import Drawer from '@/components/ui/Drawer.vue';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import SongCard from '@/components/music/SongCard.vue';
import Button from '@/components/ui/Button.vue';
import Sortable from 'sortablejs';
import { isPlayableSong } from '@/utils/song';
import {
  iconArrowUp,
  iconCurrentLocation,
  iconTrash,
  iconX,
  iconPlay,
  iconPause,
  iconList,
} from '@/icons';

interface Props {
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();

const queueTracks = computed(() => playlistStore.defaultList);
const queueEntries = computed(() =>
  queueTracks.value.map((track, index) => ({
    track,
    queueIndex: index,
    queueRenderKey: `${track.historyKey ?? track.id}:${track.hash ?? ''}:${index}`,
  })),
);
const currentTrackId = computed(() => playerStore.currentTrackId);

const itemHeight = 56;
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(queueEntries, {
  itemHeight,
});

const sortableContainerRef = ref<HTMLElement | null>(null);
let sortableInstance: Sortable | null = null;

const initSortable = () => {
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  const el = sortableContainerRef.value;
  if (!el) return;

  sortableInstance = new Sortable(el, {
    animation: 150,
    handle: '.queue-card',
    ghostClass: 'queue-sortable-ghost',
    dragClass: 'queue-sortable-drag',
    onEnd: (evt) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex !== undefined && newIndex !== undefined && oldIndex !== newIndex) {
        // Need to account for virtual list offset
        const actualOldIndex = list.value[oldIndex].index;
        const actualNewIndex = list.value[newIndex].index;
        playlistStore.reorderPlaybackQueue(actualOldIndex, actualNewIndex);
      }
    },
  });
};

const scrollToTop = () => {
  containerProps.ref.value?.scrollTo({ top: 0, behavior: 'smooth' });
};

const isCurrentVisible = (): boolean => {
  const targetId = currentTrackId.value ? String(currentTrackId.value) : '';
  const scrollerEl = containerProps.ref.value;
  if (!targetId || !scrollerEl) return false;
  const row = scrollerEl.querySelector<HTMLElement>(`[data-queue-row][data-song-id="${targetId}"]`);
  if (!row) return false;
  const scrollerRect = scrollerEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const topLimit = scrollerRect.top + 8;
  const bottomLimit = scrollerRect.bottom - 8;
  return rowRect.top >= topLimit && rowRect.bottom <= bottomLimit;
};

const scrollRetryTimer = ref<number | null>(null);

const clearScrollRetryTimer = () => {
  if (scrollRetryTimer.value === null) return;
  window.clearTimeout(scrollRetryTimer.value);
  scrollRetryTimer.value = null;
};

const scrollToCurrent = (force = true) => {
  const targetId = currentTrackId.value ? String(currentTrackId.value) : '';
  if (!targetId) return;
  if (!force && isCurrentVisible()) return;
  const index = queueTracks.value.findIndex((song) => String(song.id) === targetId);
  if (index < 0) return;
  
  const targetScrollTop = index * itemHeight;
  containerProps.ref.value?.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
};

const scheduleAutoScrollToCurrent = async () => {
  await nextTick();
  requestAnimationFrame(() => {
    scrollToCurrent(false);
    clearScrollRetryTimer();
    scrollRetryTimer.value = window.setTimeout(() => {
      scrollToCurrent(false);
      scrollRetryTimer.value = null;
    }, 240);
  });
};

watch(
  () => open.value,
  async (isOpen) => {
    if (isOpen) {
      await nextTick();
      initSortable();
      void scheduleAutoScrollToCurrent();
    } else {
      clearScrollRetryTimer();
      if (sortableInstance) {
        sortableInstance.destroy();
        sortableInstance = null;
      }
    }
  },
);

onMounted(() => {
  if (open.value) {
    void nextTick(() => {
      initSortable();
    });
  }
});

watch(
  () => list.value,
  () => {
    // Re-init sortable when virtual list data changes to ensure correct indices
    if (open.value) {
      initSortable();
    }
  },
  { deep: false },
);

onBeforeUnmount(() => {
  clearScrollRetryTimer();
  if (sortableInstance) {
    sortableInstance.destroy();
  }
});

const isSongPlayable = (song: Song) => isPlayableSong(song);

const handlePlay = (song: Song) => {
  if (String(song.id) === String(playerStore.currentTrackId)) {
    playerStore.togglePlay();
    return;
  }
  playerStore.playTrack(String(song.id));
};

const handleRemove = (song: Song) => {
  const targetId = String(song.id);
  const list = playlistStore.defaultList;
  const index = list.findIndex((item) => String(item.id) === targetId);
  if (index === -1) return;
  const nextList = list.filter((item) => String(item.id) !== targetId);
  playlistStore.removeFromQueue(targetId);

  if (String(playerStore.currentTrackId) !== targetId) return;

  if (nextList.length === 0) {
    playerStore.stop();
    return;
  }

  const nextIndex = Math.min(index, nextList.length - 1);
  void playerStore.playTrack(String(nextList[nextIndex].id), nextList);
};

const handleClear = () => {
  if (playlistStore.defaultList.length === 0) return;
  playlistStore.clearPlaybackQueue();
  playerStore.stop();
};
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    overlayClass="queue-drawer-overlay"
    panelClass="queue-drawer"
  >
    <div class="queue-header">
      <div>
        <div class="queue-title">播放列表</div>
        <div class="queue-subtitle">共 {{ queueTracks.length }} 首歌曲</div>
      </div>
      <div class="queue-actions">
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          title="滚动到顶部"
          @click="scrollToTop"
        >
          <Icon :icon="iconArrowUp" width="22" height="22" />
        </Button>
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          title="滚动到当前播放"
          @click="scrollToCurrent(false)"
        >
          <Icon :icon="iconCurrentLocation" width="22" height="22" />
        </Button>
        <Button type="button" class="queue-icon-btn" variant="ghost" size="xs" title="清空列表" @click="handleClear">
          <Icon :icon="iconTrash" width="22" height="22" />
        </Button>
        <Button type="button" class="queue-icon-btn" variant="ghost" size="xs" title="关闭" @click="open = false">
          <Icon :icon="iconX" width="22" height="22" />
        </Button>
      </div>
    </div>

    <div class="queue-divider"></div>

    <div v-bind="containerProps" class="queue-list">
      <div
        v-bind="wrapperProps"
        ref="sortableContainerRef"
        class="queue-list-inner"
      >
        <div
          v-for="entry in list"
          :key="entry.data.queueRenderKey"
          class="queue-row"
          :data-queue-row="true"
          :data-song-id="String(entry.data.track.id)"
          :data-queue-index="entry.data.queueIndex"
          :class="{
            'is-current': String(entry.data.track.id) === String(currentTrackId),
          }"
          :style="{ height: `${itemHeight}px` }"
        >
          <div class="queue-leading">
            <span class="queue-index">{{ entry.data.queueIndex + 1 }}</span>
            <Button
              type="button"
              class="queue-play"
              variant="ghost"
              size="xs"
              @click="handlePlay(entry.data.track)"
            >
              <Icon
                v-if="String(entry.data.track.id) !== String(currentTrackId) || !playerStore.isPlaying"
                :icon="iconPlay"
                width="14"
                height="14"
              />
              <Icon v-else :icon="iconPause" width="14" height="14" />
            </Button>
          </div>

          <div
            class="queue-card"
            :style="{ opacity: isSongPlayable(entry.data.track) ? 1 : 0.45 }"
            title="拖动排序"
          >
            <SongCard
              :id="entry.data.track.id"
              :hash="entry.data.track.hash"
              :title="entry.data.track.title"
              :artist="entry.data.track.artist"
              :artists="entry.data.track.artists"
              :album="entry.data.track.album"
              :albumId="entry.data.track.albumId"
              :coverUrl="entry.data.track.coverUrl"
              :duration="entry.data.track.duration"
              :audioUrl="entry.data.track.audioUrl"
              :source="entry.data.track.source"
              :mixSongId="entry.data.track.mixSongId"
              :fileId="entry.data.track.fileId"
              :privilege="entry.data.track.privilege"
              :payType="entry.data.track.payType"
              :oldCpy="entry.data.track.oldCpy"
              :relateGoods="entry.data.track.relateGoods"
              :queueContext="queueTracks"
              :showCover="true"
              :showAlbum="false"
              :showDuration="false"
              :showQuality="false"
              :active="String(entry.data.track.id) === String(currentTrackId)"
              :showMore="false"
              variant="list"
            />
          </div>

          <Button
            type="button"
            class="queue-remove"
            variant="ghost"
            size="xs"
            :class="{ 'is-hidden': String(entry.data.track.id) === String(currentTrackId) }"
            :disabled="String(entry.data.track.id) === String(currentTrackId)"
            @click="handleRemove(entry.data.track)"
          >
            <Icon :icon="iconX" width="14" height="14" />
          </Button>
        </div>
      </div>

      <div v-if="queueTracks?.length === 0" class="queue-empty-container">
        <div class="queue-empty">
          <div class="queue-empty-icon">
            <Icon :icon="iconList" width="40" height="40" />
          </div>
          <div>列表为空，快去发现好音乐吧</div>
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style scoped>
@reference "@/style.css";

:global(.queue-drawer-overlay) {
  background: rgba(0, 0, 0, 0.16);
}

:global(.queue-drawer) {
  padding: 0;
  box-shadow: none;
}

.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 16px 12px 20px;
}

.queue-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-main);
}

.queue-subtitle {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.queue-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.queue-icon-btn {
  width: 44px;
  height: 44px;
  border-radius: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  transition: all 0.2s ease;
}

.queue-icon-btn:hover {
  color: var(--color-primary);
  transform: scale(1.06);
}

.queue-divider {
  height: 1px;
  margin: 0 18px;
  background: var(--color-border-light);
}

.queue-empty-container {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.queue-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.queue-empty-icon {
  opacity: 0.35;
}

.queue-list {
  flex: 1;
  padding: 10px 12px 14px 14px;
  overflow: auto;
  position: relative;
}

.queue-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border-radius: 10px;
  transition:
    background-color 0.22s ease,
    color 0.22s ease,
    opacity 0.22s ease,
    box-shadow 0.22s ease,
    filter 0.22s ease;
  cursor: default;
}

.queue-row.is-current {
  background: var(--color-bg-card);
}

.dark .queue-row.is-current {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.queue-row:hover {
  background: var(--color-bg-card);
}

.dark .queue-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.queue-leading {
  position: relative;
  width: 40px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.queue-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  transition: opacity 0.2s ease;
}

.queue-play {
  position: absolute;
  inset: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--color-text-main);
  opacity: 0;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.queue-row:hover .queue-play,
.queue-row.is-current .queue-play {
  opacity: 1;
}

.queue-row:hover .queue-index,
.queue-row.is-current .queue-index {
  opacity: 0;
}

.queue-play:hover {
  transform: scale(1.1);
  color: var(--color-primary);
}

.queue-card {
  flex: 1;
  min-width: 0;
  cursor: grab;
  border-radius: 10px;
  transition:
    transform 0.2s ease,
    opacity 0.2s ease,
    filter 0.2s ease;
}

.queue-card:hover {
  transform: translateX(1px);
}

.queue-card:active {
  cursor: grabbing;
}

.queue-card :deep(.song-actions) {
  display: none;
}

.queue-card :deep(.song-title) {
  flex: 0 1 auto;
  min-width: 0;
}

.queue-card :deep(.song-title-row) {
  min-width: 0;
  gap: 4px;
  flex-wrap: nowrap;
}

.queue-card :deep(.song-tag) {
  margin-left: 0;
  flex-shrink: 0;
}

.queue-remove {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  opacity: 0;
  transition: all 0.2s ease;
  position: relative;
  left: -8px;
}

.queue-row:hover .queue-remove {
  opacity: 1;
}

.queue-remove.is-hidden {
  opacity: 0 !important;
  pointer-events: none;
}

.queue-remove:hover {
  color: #ef4444;
  transform: scale(1.05);
}

.queue-sortable-ghost {
  opacity: 0.4;
  background: var(--color-primary-light) !important;
}

.queue-sortable-drag {
  opacity: 0.9;
  background: var(--color-bg-card) !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

@media (max-width: 720px) {
  .queue-row {
    gap: 10px;
  }
}
</style>
