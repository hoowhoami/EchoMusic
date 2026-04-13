<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { useVModel } from '@vueuse/core';
import Sortable from 'sortablejs';
import Drawer from '@/components/ui/Drawer.vue';
import SongCard from '@/components/music/SongCard.vue';
import Button from '@/components/ui/Button.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import type { Song } from '@/models/song';
import { isPlayableSong } from '@/utils/song';
import {
  iconTrash,
  iconX,
  iconPlay,
  iconPause,
  iconList,
  iconArrowUp,
  iconCurrentLocation,
  iconChevronUpDown,
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

type QueueLike = NonNullable<ReturnType<typeof usePlaylistStore>['activeQueue']>;

const itemHeight = 56;
const slidesRef = ref<HTMLElement | null>(null);
const queueListRefs = ref<Record<string, HTMLElement | null>>({});
const previewQueueId = ref<string | null>(null);
const isSyncingPreviewByScroll = ref(false);

const dragPointerId = ref<number | null>(null);
const dragStartX = ref(0);
const dragStartScrollLeft = ref(0);
const dragMoved = ref(false);
const dragPointerType = ref<string | null>(null);
const sortQueueId = ref<string | null>(null);

let sortableInstance: Sortable | null = null;
let sortableInitToken = 0;

const activeQueue = computed(() => playlistStore.activeQueue);

const queueOptions = computed(() => {
  const list: QueueLike[] = [];
  if (activeQueue.value) list.push(activeQueue.value);
  playlistStore.historyPlaybackQueues.forEach((queue) => {
    if (list.some((item) => item.id === queue.id)) return;
    list.push(queue);
  });
  return list;
});

const previewQueue = computed(() => {
  const queueId = previewQueueId.value;
  if (!queueId) return activeQueue.value;
  return queueOptions.value.find((queue) => queue.id === queueId) ?? activeQueue.value;
});

const previewIndex = computed(() => {
  const targetId = previewQueue.value?.id ?? '';
  const index = queueOptions.value.findIndex((queue) => queue.id === targetId);
  return index >= 0 ? index : 0;
});

const isPreviewReadonly = computed(
  () => !!previewQueue.value && previewQueue.value.id !== activeQueue.value?.id,
);

const previewTracks = computed(() => previewQueue.value?.songs ?? []);

const currentTrackId = computed(() => {
  if (!previewQueue.value) return null;
  if (previewQueue.value.id === activeQueue.value?.id) return playerStore.currentTrackId;
  return previewQueue.value.currentTrackId ?? null;
});

const headerTitle = computed(() => (previewIndex.value === 0 ? '播放队列' : '历史队列'));
const headerSubtitle = computed(() => {
  const queue = previewQueue.value;
  if (!queue) return '播放列表';
  if (queue.id === activeQueue.value?.id) return resolveQueueTypeLabel(queue);
  return queue.title || resolveQueueTypeLabel(queue);
});
const headerMeta = computed(() => {
  const count = previewQueue.value?.songs.length ?? 0;
  return `${count} 首`;
});
const isSortMode = computed(() => !!sortQueueId.value);
const canSortQueue = (queue: QueueLike | null | undefined) => (queue?.songs.length ?? 0) > 1;
const isQueueSorting = (queueId: string) => sortQueueId.value === queueId;

const resolveResumeTrack = (queue: QueueLike | null | undefined) => {
  if (!queue) return null;
  return (
    queue.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
    queue.songs[0] ??
    null
  );
};

const setQueueListRef = (queueId: string) => (target: Element | ComponentPublicInstance | null) => {
  queueListRefs.value[queueId] = target instanceof HTMLElement ? target : null;
};

const resolveQueueTypeLabel = (
  queue: { type?: string; title?: string; subtitle?: string } | null | undefined,
) => {
  if (!queue) return '播放列表';
  if (queue.type === 'fm') return queue.title || '私人 FM';
  if (queue.type === 'daily-recommend') return '每日推荐';
  if (queue.type === 'ranking') return '排行榜';
  if (queue.type === 'search') return '搜索结果';
  if (queue.type === 'history') return '播放历史';
  if (queue.type === 'cloud') return '云盘音乐';
  if (queue.type === 'album') return '专辑';
  if (queue.type === 'artist') return '歌手';
  if (queue.type === 'playlist') return '歌单';
  return queue.subtitle || queue.title || '播放列表';
};

const destroySortable = () => {
  if (!sortableInstance) return;
  try {
    sortableInstance.option('disabled', true);
  } catch {
    // ignore stale sortable instance state
  }
  try {
    sortableInstance.destroy();
  } catch {
    // sortable may already be detached while queue switches quickly
  }
  sortableInstance = null;
};

const initSortable = async () => {
  const initToken = ++sortableInitToken;
  destroySortable();
  if (!open.value || !sortQueueId.value) return;
  const queue = queueOptions.value.find((item) => item.id === sortQueueId.value) ?? null;
  if (!canSortQueue(queue)) {
    sortQueueId.value = null;
    return;
  }
  if (!queue) return;
  await nextTick();
  if (initToken !== sortableInitToken) return;
  const el = queueListRefs.value[queue.id];
  if (!el) return;
  if (!el.isConnected) return;

  sortableInstance = new Sortable(el, {
    animation: 160,
    handle: '.queue-card.is-sorting',
    delay: 180,
    delayOnTouchOnly: true,
    touchStartThreshold: 8,
    fallbackTolerance: 6,
    ghostClass: 'queue-sortable-ghost',
    dragClass: 'queue-sortable-drag',
    onEnd: (evt) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
      playlistStore.reorderPlaybackQueue(oldIndex, newIndex, queue.id);
    },
  });
};

const scrollPreviewToTop = () => {
  const queue = previewQueue.value;
  if (!queue) return;
  queueListRefs.value[queue.id]?.scrollTo({ top: 0, behavior: 'smooth' });
};

const isCurrentVisible = (): boolean => {
  const queue = previewQueue.value;
  const targetId = String(currentTrackId.value ?? '');
  if (!queue || !targetId) return false;
  const scroller = queueListRefs.value[queue.id];
  if (!scroller) return false;
  const row = scroller.querySelector<HTMLElement>(`[data-queue-row][data-song-id="${targetId}"]`);
  if (!row) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.top >= scrollerRect.top + 8 && rowRect.bottom <= scrollerRect.bottom - 8;
};

const scrollToCurrent = (force = true) => {
  const queue = previewQueue.value;
  const targetId = String(currentTrackId.value ?? '');
  if (!queue || !targetId) return;
  if (!force && isCurrentVisible()) return;

  const scroller = queueListRefs.value[queue.id];
  if (!scroller) return;
  const row = scroller.querySelector<HTMLElement>(`[data-queue-row][data-song-id="${targetId}"]`);
  if (row) {
    scroller.scrollTo({ top: Math.max(0, row.offsetTop - 8), behavior: 'smooth' });
    return;
  }

  const index = queue.songs.findIndex((song) => String(song.id) === targetId);
  if (index < 0) return;
  scroller.scrollTo({ top: Math.max(0, index * itemHeight - 8), behavior: 'smooth' });
};

const scrollToPreviewQueue = async (index: number, behavior: ScrollBehavior = 'smooth') => {
  await nextTick();
  const el = slidesRef.value;
  if (!el) return;
  const width = el.clientWidth;
  if (width <= 0) return;
  isSyncingPreviewByScroll.value = true;
  el.scrollTo({ left: width * index, behavior });
  window.setTimeout(
    () => {
      isSyncingPreviewByScroll.value = false;
    },
    behavior === 'smooth' ? 260 : 0,
  );
};

const syncPreviewQueueByScroll = () => {
  const el = slidesRef.value;
  if (!el || queueOptions.value.length === 0) return;
  const width = el.clientWidth;
  if (width <= 0) return;
  const index = Math.round(el.scrollLeft / width);
  const targetQueue = queueOptions.value[index];
  if (!targetQueue) return;
  if (targetQueue.id !== previewQueueId.value) {
    previewQueueId.value = targetQueue.id;
  }
};

const handleSlidesScroll = () => {
  if (isSortMode.value) return;
  syncPreviewQueueByScroll();
};

const handleSwitchQueue = (queueId: string) => {
  if (isSortMode.value) return;
  previewQueueId.value = queueId;
  const index = queueOptions.value.findIndex((queue) => queue.id === queueId);
  if (index >= 0) {
    void scrollToPreviewQueue(index);
  }
};

const handlePointerDown = (event: PointerEvent) => {
  if (isSortMode.value) return;
  if (event.pointerType === 'mouse') return;
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target.closest('button, a, input, [role="button"]')) return;
  const el = slidesRef.value;
  if (!el) return;
  dragPointerId.value = event.pointerId;
  dragPointerType.value = event.pointerType;
  dragStartX.value = event.clientX;
  dragStartScrollLeft.value = el.scrollLeft;
  dragMoved.value = false;
  el.setPointerCapture(event.pointerId);
};

const handlePointerMove = (event: PointerEvent) => {
  const el = slidesRef.value;
  if (!el || dragPointerId.value !== event.pointerId) return;
  if (dragPointerType.value === 'mouse') return;
  const deltaX = event.clientX - dragStartX.value;
  if (Math.abs(deltaX) > 6) {
    dragMoved.value = true;
  }
  el.scrollLeft = dragStartScrollLeft.value - deltaX;
};

const handlePointerEnd = async (event: PointerEvent) => {
  const el = slidesRef.value;
  if (!el || dragPointerId.value !== event.pointerId) return;
  try {
    el.releasePointerCapture(event.pointerId);
  } catch {
    // ignore stale pointer capture state
  }
  dragPointerId.value = null;
  dragPointerType.value = null;
  const width = el.clientWidth;
  const index = width > 0 ? Math.round(el.scrollLeft / width) : previewIndex.value;
  const safeIndex = Math.max(0, Math.min(index, queueOptions.value.length - 1));
  previewQueueId.value = queueOptions.value[safeIndex]?.id ?? previewQueueId.value;
  await scrollToPreviewQueue(safeIndex);
};

const handleSlidesWheel = (event: WheelEvent) => {
  if (!isSortMode.value) return;
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  event.preventDefault();
};

const isSongPlayable = (song: Song) => isPlayableSong(song);

const handlePlay = async (song: Song) => {
  if (isPreviewReadonly.value) {
    await handleResumePreviewQueue(song);
    return;
  }
  if (String(song.id) === String(playerStore.currentTrackId)) {
    playerStore.togglePlay();
    return;
  }
  await playerStore.playTrack(String(song.id), previewQueue.value?.songs ?? []);
};

const handleRemove = async (song: Song) => {
  const queue = previewQueue.value;
  if (!queue) return;
  const targetId = String(song.id);
  const list = queue.songs;
  const index = list.findIndex((item) => String(item.id) === targetId);
  if (index === -1) return;

  const wasPlaying = playerStore.isPlaying;
  const nextList = list.filter((item) => String(item.id) !== targetId);
  playlistStore.removeFromQueue(targetId, queue.id);

  if (queue.id !== activeQueue.value?.id || String(playerStore.currentTrackId) !== targetId) return;

  if (nextList.length === 0) {
    playerStore.stop();
    return;
  }

  const nextIndex = Math.min(index, nextList.length - 1);
  await playerStore.playTrack(String(nextList[nextIndex].id), nextList, {
    autoPlay: wasPlaying,
  });
};

const handleClear = () => {
  const queue = previewQueue.value;
  if (!queue) return;

  if (queue.id !== activeQueue.value?.id) {
    playlistStore.removePlaybackQueue(queue.id);
    previewQueueId.value = activeQueue.value?.id ?? null;
    void scrollToPreviewQueue(0, 'auto');
    return;
  }

  playlistStore.clearPlaybackQueue();
  playerStore.stop();
};

const toggleSortMode = async (queueId: string) => {
  const queue = queueOptions.value.find((item) => item.id === queueId) ?? null;
  if (!canSortQueue(queue)) return;
  sortQueueId.value = sortQueueId.value === queueId ? null : queueId;
  previewQueueId.value = queueId;
  await initSortable();
};

const handleResumePreviewQueue = async (song?: Song | null) => {
  const queue = previewQueue.value;
  if (!queue || queue.id === activeQueue.value?.id) return;
  const resumeTrackId = song?.id ?? queue.currentTrackId ?? queue.songs[0]?.id ?? null;
  if (!resumeTrackId) return;
  playlistStore.setActiveQueue(queue.id);
  await playerStore.playTrack(String(resumeTrackId), queue.songs, { autoPlay: true });
};

watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen) {
      sortQueueId.value = null;
      sortableInitToken += 1;
      destroySortable();
      return;
    }

    previewQueueId.value = activeQueue.value?.id ?? queueOptions.value[0]?.id ?? null;
    await nextTick();
    await scrollToPreviewQueue(previewIndex.value, 'auto');
    await initSortable();
  },
);

watch(
  () => previewQueueId.value,
  async () => {
    if (!open.value || isSyncingPreviewByScroll.value) return;
    await initSortable();
    await nextTick();
    scrollToCurrent(false);
  },
);

watch(
  () => queueOptions.value.map((queue) => queue.id).join('|'),
  async () => {
    if (queueOptions.value.length === 0) {
      previewQueueId.value = null;
      sortQueueId.value = null;
      sortableInitToken += 1;
      destroySortable();
      return;
    }
    if (sortQueueId.value && !queueOptions.value.some((queue) => queue.id === sortQueueId.value)) {
      sortQueueId.value = null;
    }
    if (!previewQueue.value) {
      previewQueueId.value = queueOptions.value[0]?.id ?? null;
    }
    if (open.value) {
      await nextTick();
      await scrollToPreviewQueue(previewIndex.value, 'auto');
      await initSortable();
      scrollToCurrent(false);
    }
  },
);

watch(
  () => previewTracks.value.length,
  async () => {
    if (open.value) {
      if (sortQueueId.value) {
        const sortingQueue =
          queueOptions.value.find((queue) => queue.id === sortQueueId.value) ?? null;
        if (!canSortQueue(sortingQueue)) {
          sortQueueId.value = null;
        }
      }
      await initSortable();
    }
  },
);

onMounted(() => {
  if (open.value) {
    previewQueueId.value = activeQueue.value?.id ?? queueOptions.value[0]?.id ?? null;
    void nextTick(async () => {
      await scrollToPreviewQueue(previewIndex.value, 'auto');
      await initSortable();
    });
  }
});

onBeforeUnmount(() => {
  sortableInitToken += 1;
  destroySortable();
});
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    overlayClass="queue-drawer-overlay"
    panelClass="queue-drawer"
  >
    <div class="queue-header">
      <div class="queue-heading">
        <div class="queue-title-row">
          <div class="queue-title">{{ headerTitle }}</div>
          <div v-if="headerSubtitle" class="queue-title-subtitle">
            {{ headerSubtitle }}
          </div>
        </div>
        <div class="queue-meta-row">
          <div class="queue-title-meta">{{ headerMeta }}</div>
          <div v-if="queueOptions.length > 1" class="queue-dots queue-dots-header">
            <button
              v-for="(queue, index) in queueOptions"
              :key="queue.id"
              type="button"
              class="queue-dot"
              :class="{ 'is-active': index === previewIndex }"
              :title="index === 0 ? `播放队列 · ${resolveQueueTypeLabel(queue)}` : queue.title"
              @click="handleSwitchQueue(queue.id)"
            />
          </div>
        </div>
      </div>

      <div class="queue-actions">
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          title="回到顶部"
          @click="scrollPreviewToTop"
        >
          <Icon :icon="iconArrowUp" width="20" height="20" />
        </Button>
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          title="定位当前歌曲"
          @click="scrollToCurrent(false)"
        >
          <Icon :icon="iconCurrentLocation" width="20" height="20" />
        </Button>
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          :title="previewQueue?.id === activeQueue?.id ? '清空当前队列' : '删除历史队列'"
          @click="handleClear"
        >
          <Icon :icon="iconTrash" width="20" height="20" />
        </Button>
        <Button
          type="button"
          class="queue-icon-btn"
          variant="ghost"
          size="xs"
          title="关闭"
          @click="open = false"
        >
          <Icon :icon="iconX" width="20" height="20" />
        </Button>
      </div>
    </div>

    <div
      ref="slidesRef"
      class="queue-slides"
      :class="{ 'is-sorting': isSortMode }"
      @scroll.passive="handleSlidesScroll"
      @wheel="handleSlidesWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
    >
      <section v-for="queue in queueOptions" :key="queue.id" class="queue-slide">
        <div
          class="queue-panel-toolbar"
          :class="{ 'has-resume': queue.id === previewQueue?.id && isPreviewReadonly }"
        >
          <Button
            v-if="queue.id === previewQueue?.id && isPreviewReadonly"
            type="button"
            class="queue-inline-resume"
            variant="secondary"
            size="xs"
            :title="`继续播放 ${resolveResumeTrack(queue)?.title || '这首歌'}`"
            @click="handleResumePreviewQueue(resolveResumeTrack(queue))"
          >
            <Icon :icon="iconPlay" width="14" height="14" class="queue-inline-resume-icon" />
            <span class="queue-inline-resume-label">继续播放</span>
            <span class="queue-inline-resume-text">
              {{ resolveResumeTrack(queue)?.title || '这首歌' }}
            </span>
          </Button>
          <Button
            type="button"
            class="queue-sort-toggle"
            :class="{ 'is-active': isQueueSorting(queue.id) }"
            variant="ghost"
            size="xs"
            :disabled="!canSortQueue(queue)"
            :title="isQueueSorting(queue.id) ? '完成排序' : '排序'"
            @click="toggleSortMode(queue.id)"
          >
            <Icon :icon="iconChevronUpDown" width="16" height="16" />
            {{ isQueueSorting(queue.id) ? '完成' : '排序' }}
          </Button>
        </div>
        <div :ref="setQueueListRef(queue.id)" class="queue-list">
          <div
            v-for="(track, index) in queue.songs"
            :key="`${track.historyKey ?? track.id}:${track.hash ?? ''}:${index}`"
            class="queue-row"
            :data-queue-row="true"
            :data-song-id="String(track.id)"
            :class="{
              'is-current':
                queue.id === previewQueue?.id && String(track.id) === String(currentTrackId ?? ''),
            }"
            :style="{ height: `${itemHeight}px` }"
          >
            <div class="queue-leading">
              <span class="queue-index">{{ index + 1 }}</span>
              <Button
                type="button"
                class="queue-play"
                variant="ghost"
                size="xs"
                @click="handlePlay(track)"
              >
                <Icon
                  v-if="
                    String(track.id) !== String(currentTrackId ?? '') ||
                    queue.id !== activeQueue?.id ||
                    !playerStore.isPlaying
                  "
                  :icon="iconPlay"
                  width="14"
                  height="14"
                />
                <Icon v-else :icon="iconPause" width="14" height="14" />
              </Button>
            </div>

            <div
              class="queue-card"
              :class="{ 'is-sorting': isQueueSorting(queue.id) }"
              :style="{ opacity: isSongPlayable(track) ? 1 : 0.45 }"
            >
              <SongCard
                :id="track.id"
                :hash="track.hash"
                :title="track.title"
                :artist="track.artist"
                :artists="track.artists"
                :album="track.album"
                :albumId="track.albumId"
                :coverUrl="track.coverUrl"
                :duration="track.duration"
                :audioUrl="track.audioUrl"
                :source="track.source"
                :mvHash="track.mvHash"
                :mixSongId="track.mixSongId"
                :fileId="track.fileId"
                :privilege="track.privilege"
                :payType="track.payType"
                :oldCpy="track.oldCpy"
                :relateGoods="track.relateGoods"
                :queueContext="queue.songs"
                :showCover="true"
                :showAlbum="false"
                :showDuration="false"
                :showQuality="false"
                :active="
                  queue.id === previewQueue?.id && String(track.id) === String(currentTrackId ?? '')
                "
                :showMore="false"
                variant="list"
              />
            </div>

            <Button
              v-if="!isSortMode"
              type="button"
              class="queue-remove"
              variant="unstyled"
              size="none"
              title="从队列移除"
              @click="handleRemove(track)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>

          <div v-if="queue.songs.length === 0" class="queue-empty-container">
            <div class="queue-empty">
              <div class="queue-empty-icon">
                <Icon :icon="iconList" width="36" height="36" />
              </div>
              <div>列表为空</div>
            </div>
          </div>
        </div>
      </section>
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
  gap: 12px;
  padding: 14px 16px 5px;
  border-bottom: 1px solid var(--color-border-light);
}

.queue-heading {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.queue-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: nowrap;
  overflow: hidden;
}

.queue-title {
  flex: 0 0 auto;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  color: var(--color-text-main);
  white-space: nowrap;
}

.queue-title-subtitle {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-title-meta {
  width: 62px;
  flex: 0 0 62px;
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.86;
  white-space: nowrap;
  line-height: 1;
}

.queue-meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 16px;
}

.queue-dots-header {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0;
  min-height: 16px;
}

.queue-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  margin-left: auto;
}

.queue-icon-btn {
  width: 38px;
  height: 38px;
  min-width: 38px;
  border-radius: 12px;
  color: var(--color-text-secondary);
}

.queue-slides {
  flex: 1;
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
}

.queue-slides::-webkit-scrollbar {
  display: none;
}

.queue-slide {
  flex: 0 0 100%;
  min-width: 100%;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.queue-panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 8px 14px 6px;
}

.queue-panel-toolbar.has-resume {
  justify-content: space-between;
}

.queue-inline-resume {
  max-width: min(70%, 220px);
  height: 28px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  border-radius: 999px;
  padding: 0 10px;
  font-size: 12px;
}

.queue-inline-resume-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

.queue-inline-resume-label {
  color: var(--color-primary);
  font-weight: 700;
  flex-shrink: 0;
}

.queue-inline-resume-text {
  min-width: 0;
  color: color-mix(in srgb, var(--color-text-main) 62%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-sort-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.queue-sort-toggle.is-active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.queue-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px 14px;
  user-select: none;
  -webkit-user-select: none;
}

.queue-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 0 0;
  border-radius: 10px;
  transition: background-color 0.2s ease;
  user-select: none;
  -webkit-user-select: none;
}

.queue-row.is-current,
.queue-row:hover {
  background: var(--color-bg-card);
}

.dark .queue-row.is-current,
.dark .queue-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.queue-leading {
  position: relative;
  width: 40px;
  flex-shrink: 0;
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
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 8px;
  padding: 6px;
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

.queue-card {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: 10px;
  user-select: none;
  -webkit-user-select: none;
}

.queue-card.is-sorting {
  cursor: grab;
}

.queue-card :deep(.song-card),
.queue-card :deep(.song-content),
.queue-card :deep(.song-title),
.queue-card :deep(.song-subline),
.queue-card :deep(img) {
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

.queue-card :deep(.song-actions),
.queue-card :deep(.song-tag) {
  display: none;
}

.queue-card :deep(.song-title) {
  min-width: 0;
}

.queue-card :deep(.song-title-row) {
  min-width: 0;
  gap: 4px;
  flex-wrap: nowrap;
}

.queue-card.is-sorting:active {
  cursor: grabbing;
}

.queue-slides.is-sorting {
  overflow-x: hidden;
  scroll-snap-type: none;
}

.queue-remove {
  width: 28px;
  height: 28px;
  min-width: 28px;
  display: inline-flex;
  border-radius: 999px;
  margin-left: auto;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: all 0.2s ease;
}

.queue-row:hover .queue-remove,
.queue-row:focus-within .queue-remove {
  opacity: 1;
  pointer-events: auto;
}

.queue-remove:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
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
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.queue-empty-icon {
  opacity: 0.35;
}

.queue-dots {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
}

.queue-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-main) 18%, transparent);
  transition: all 0.2s ease;
}

.queue-dot.is-active {
  width: 18px;
  background: color-mix(in srgb, var(--color-primary) 80%, white 0%);
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
</style>
