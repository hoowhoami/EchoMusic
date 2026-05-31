<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import SongCard from '@/components/music/SongCard.vue';
import Button from '@/components/ui/Button.vue';
import type { Song } from '@/models/song';
import { useVirtualList } from '@/composables/useVirtualList';
import { iconPause, iconPlay, iconTrash, iconList } from '@/icons';
import { isPlayableSong } from '@/utils/song';

interface QueueLike {
  id: string;
  songs: Song[];
}

interface Props {
  queue: QueueLike;
  itemHeight?: number;
  currentTrackId?: string | number | null;
  isPreviewQueue?: boolean;
  isCurrentPlaybackQueue?: boolean;
  isPlayerPlaying?: boolean;
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  itemHeight: 56,
  currentTrackId: null,
  isPreviewQueue: false,
  isCurrentPlaybackQueue: false,
  isPlayerPlaying: false,
  readonly: false,
});

const emit = defineEmits<{
  (e: 'play', song: Song): void;
  (e: 'remove', song: Song): void;
}>();

const scrollContainerRef = ref<HTMLElement | null>(null);
const { containerRef, visibleStart, visibleEnd, totalSize, offset, refresh } = useVirtualList({
  itemCount: computed(() => props.queue.songs.length),
  itemSize: computed(() => props.itemHeight),
  overscan: 10,
  scrollContainer: scrollContainerRef,
  active: computed(() => true),
});

const items = computed(() => {
  const start = visibleStart.value;
  const end = visibleEnd.value;
  if (start >= end) return [] as Array<{ data: Song; index: number }>;
  return props.queue.songs.slice(start, end).map((data, index) => ({
    data,
    index: start + index,
  }));
});

const wrapperStyle = computed(() => ({
  height: `${totalSize.value}px`,
  position: 'relative' as const,
}));

const offsetStyle = computed(() => ({
  transform: `translateY(${offset.value}px)`,
}));

const isCurrentSong = (song: Song) =>
  props.isPreviewQueue && String(song.id) === String(props.currentTrackId ?? '');

const setScrollerRef = (target: Element | ComponentPublicInstance | null) => {
  scrollContainerRef.value = target instanceof HTMLElement ? target : null;
};

const scrollToTop = () => {
  scrollContainerRef.value?.scrollTo({ top: 0 });
  refresh(true);
};

const isCurrentVisible = (): boolean => {
  const targetId = String(props.currentTrackId ?? '');
  const scroller = scrollContainerRef.value;
  if (!scroller || !targetId) return false;
  const row = scroller.querySelector<HTMLElement>(`[data-queue-row][data-song-id="${targetId}"]`);
  if (!row) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.top >= scrollerRect.top + 8 && rowRect.bottom <= scrollerRect.bottom - 8;
};

const scrollToCurrent = (force = true) => {
  const targetId = String(props.currentTrackId ?? '');
  const scroller = scrollContainerRef.value;
  if (!scroller || !targetId) return;
  if (!force && isCurrentVisible()) return;
  const index = props.queue.songs.findIndex((song) => String(song.id) === targetId);
  if (index < 0) return;
  scroller.scrollTo({ top: Math.max(0, index * props.itemHeight - 8) });
  refresh(false);
};

watch(
  () => [props.queue.id, props.queue.songs.length],
  () => {
    refresh(true);
  },
  { flush: 'post' },
);

defineExpose({
  refresh,
  scrollToTop,
  scrollToCurrent,
  isCurrentVisible,
  getScroller: () => scrollContainerRef.value,
  getVisibleStart: () => visibleStart.value,
});
</script>

<template>
  <Scrollbar
    :hide-scrollbar="false"
    class="flex-1 min-h-0"
    :content-props="{ ref: setScrollerRef }"
  >
    <div class="queue-list">
      <div ref="containerRef" :style="wrapperStyle">
        <div :style="offsetStyle" class="queue-virtual-offset">
          <div
            v-for="entry in items"
            :key="`${entry.data.historyKey ?? entry.data.id}:${entry.data.hash ?? ''}:${entry.index}`"
            class="queue-row"
            :data-queue-row="true"
            :data-song-id="String(entry.data.id)"
            :class="{ 'is-current': isCurrentSong(entry.data) }"
            :style="{ height: `${itemHeight}px` }"
          >
            <div class="queue-leading">
              <span class="queue-index">{{ entry.index + 1 }}</span>
              <Button
                v-if="isPreviewQueue"
                type="button"
                class="queue-play"
                variant="ghost"
                size="xs"
                @click="emit('play', entry.data)"
              >
                <Icon
                  v-show="
                    !(
                      String(entry.data.id) === String(currentTrackId ?? '') &&
                      isCurrentPlaybackQueue &&
                      isPlayerPlaying
                    )
                  "
                  :icon="iconPlay"
                  width="14"
                  height="14"
                />
                <Icon
                  v-show="
                    String(entry.data.id) === String(currentTrackId ?? '') &&
                    isCurrentPlaybackQueue &&
                    isPlayerPlaying
                  "
                  :icon="iconPause"
                  width="14"
                  height="14"
                />
              </Button>
            </div>

            <div class="queue-card" :style="{ opacity: isPlayableSong(entry.data) ? 1 : 0.45 }">
              <SongCard
                :song="entry.data"
                :showCover="true"
                :showAlbum="false"
                :showDuration="false"
                :showQuality="false"
                :active="isCurrentSong(entry.data)"
                :showMore="false"
                variant="list"
              />
            </div>

            <Button
              v-if="isPreviewQueue && !readonly"
              type="button"
              class="queue-remove"
              variant="unstyled"
              size="none"
              title="从队列移除"
              @click="emit('remove', entry.data)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>
        </div>
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
  </Scrollbar>
</template>

<style scoped>
.queue-list {
  min-height: 100%;
}

.queue-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 10px;
  padding: 0 12px 0 8px;
  border-radius: 14px;
  transition: background-color 0.16s ease;
}

.queue-row.is-current,
.queue-row:hover {
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.dark .queue-row.is-current,
.dark .queue-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.queue-leading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  position: relative;
  width: 40px;
  min-width: 40px;
}

.queue-index {
  font-size: 12px;
  color: var(--color-text-secondary);
  opacity: 0.75;
  transition: opacity 0.16s ease;
}

.queue-play {
  position: absolute;
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 28px;
  min-width: 28px;
  color: var(--color-primary);
  opacity: 0;
}

.queue-play:hover {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
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
  min-width: 0;
  transition:
    transform 0.14s ease,
    opacity 0.16s ease;
}

.queue-card:active {
  transform: scale(0.995);
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
  display: none !important;
}

.queue-card :deep(.song-title) {
  font-size: 13px;
}

.queue-card :deep(.song-title-row) {
  gap: 0;
}

.queue-remove {
  width: 24px;
  height: 24px;
  min-width: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--color-text-secondary);
  opacity: 0;
  transition:
    opacity 0.16s ease,
    color 0.16s ease,
    background-color 0.16s ease;
}

.queue-row:hover .queue-remove,
.queue-row:focus-within .queue-remove {
  opacity: 1;
}

.queue-remove:hover {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 12%, transparent);
}

.queue-empty-container {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 20px 56px;
  box-sizing: border-box;
}

.queue-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary);
  opacity: 0.72;
}

.queue-empty-icon {
  width: 72px;
  height: 72px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}
</style>
