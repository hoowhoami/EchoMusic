<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useResizeObserver } from '@vueuse/core';
import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { formatDuration } from '@/utils/format';
import SongCard from './SongCard.vue';
import { iconPlay, iconPause } from '@/icons';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { buildSongListGridTemplate } from './songListLayout';
import { isPlayableSong } from '@/utils/song';
import { playSongInContext, queueAndPlaySong } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';

interface Props {
  songs: Song[];
  loading?: boolean;
  showIndex?: boolean;
  showCover?: boolean;
  showAlbum?: boolean;
  showDuration?: boolean;
  rowPaddingClass?: string;
  activeId?: string | number;
  searchQuery?: string;
  parentPlaylistId?: string | number;
  enableRemoveFromPlaylist?: boolean;
  onSongDoubleTapPlay?: (song: Song) => void | Promise<void>;
  onRemovedFromPlaylist?: (song: Song) => void;
  enableDefaultDoubleTapPlay?: boolean;
  itemKeyField?: 'id' | 'historyKey';
  active?: boolean;
  queueOptions?: SetPlaybackQueueOptions;
  queueFilteredInvalidCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  showIndex: true,
  showCover: true,
  showAlbum: true,
  showDuration: true,
  rowPaddingClass: '',
  searchQuery: '',
  parentPlaylistId: '',
  enableRemoveFromPlaylist: false,
  enableDefaultDoubleTapPlay: false,
  itemKeyField: 'id',
  active: true,
  queueFilteredInvalidCount: 0,
});

// const emit = defineEmits<{
//   (e: 'more', song: Song): void;
// }>();

const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const router = useRouter();
const route = useRoute();

// 搜索过滤
const filteredSongs = computed(() => {
  if (!props.searchQuery.trim()) return props.songs;
  const q = props.searchQuery.toLowerCase();
  return props.songs.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.album?.toLowerCase().includes(q),
  );
});

const itemHeight = 60;
const overscan = 10;
const containerRef = ref<HTMLElement | null>(null);
const scrollContainerRef = ref<HTMLElement | null>(null);
const visibleStart = ref(0);
const visibleEnd = ref(0);
let measureFrame = 0;

const totalHeight = computed(() => filteredSongs.value.length * itemHeight);

const list = computed(() => {
  if (!props.active) return [] as Array<{ data: Song; index: number }>;
  return filteredSongs.value.slice(visibleStart.value, visibleEnd.value).map((data, index) => ({
    data,
    index: visibleStart.value + index,
  }));
});

const wrapperStyle = computed(() => ({
  height: `${totalHeight.value}px`,
  position: 'relative' as const,
}));

const visibleBlockStyle = computed(() => ({
  transform: `translateY(${visibleStart.value * itemHeight}px)`,
}));

const rowGridTemplate = computed(() =>
  buildSongListGridTemplate({
    showIndex: props.showIndex,
    showAlbum: props.showAlbum,
    showDuration: props.showDuration,
  }),
);

const isSongPlayable = (song: Song) => isPlayableSong(song);

const rowOpacity = (song: Song) => (isSongPlayable(song) ? 1 : 0.45);

const readString = (value: unknown, fallback = ''): string => {
  if (value === undefined || value === null) return fallback;
  return String(value);
};

const activeIdText = computed(() => readString(props.activeId));
const isActiveSong = (song: Song) => readString(song.id) === activeIdText.value;

const resolveNumericId = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
};

const isSameRoute = (name: string, targetId: string | number) => {
  const routeId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id;
  return route.name === name && String(routeId) === String(targetId);
};

const isAlbumClickable = (song: Song) => {
  const albumId = resolveNumericId(song.albumId);
  if (!albumId || !(song.album ?? '').trim()) return false;
  return !isSameRoute('album-detail', albumId);
};

const openAlbumDetail = (song: Song) => {
  const albumId = resolveNumericId(song.albumId);
  if (!albumId || !isAlbumClickable(song)) return;
  router.push({
    name: 'album-detail',
    params: { id: String(albumId) },
  });
};

const handleTogglePlay = async (song: Song) => {
  if (isActiveSong(song)) {
    playerStore.togglePlay();
    return;
  }

  const target = props.songs.find((item) => String(item.id) === String(song.id)) ?? song;
  if ((props.songs?.length ?? 0) > 0 && props.queueOptions?.queueId) {
    await playSongInContext(
      playlistStore,
      playerStore,
      target,
      props.songs,
      props.queueFilteredInvalidCount ?? 0,
      props.queueOptions,
    );
    return;
  }
  await queueAndPlaySong(playlistStore, playerStore, target, props.queueOptions);
};

const getScrollContainer = (): HTMLElement | null =>
  document.querySelector('.view-port') as HTMLElement | null;

const updateVisibleRange = () => {
  const totalCount = filteredSongs.value.length;
  if (!props.active || props.loading || totalCount === 0) {
    visibleStart.value = 0;
    visibleEnd.value = 0;
    return;
  }

  const scrollContainer = scrollContainerRef.value ?? getScrollContainer();
  const containerEl = containerRef.value;

  if (!scrollContainer || !containerEl) {
    visibleStart.value = 0;
    visibleEnd.value = Math.min(totalCount, overscan * 4);
    return;
  }

  const scrollContainerRect = scrollContainer.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  const listTop = containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
  const listBottom = listTop + totalHeight.value;
  const viewportTop = scrollContainer.scrollTop;
  const viewportBottom = viewportTop + scrollContainer.clientHeight;

  if (viewportBottom <= listTop || viewportTop >= listBottom) {
    visibleStart.value = 0;
    visibleEnd.value = 0;
    return;
  }

  const relativeTop = Math.max(0, viewportTop - listTop);
  const relativeBottom = Math.max(0, Math.min(totalHeight.value, viewportBottom - listTop));
  const nextStart = Math.max(0, Math.floor(relativeTop / itemHeight) - overscan);
  const nextEnd = Math.min(totalCount, Math.ceil(relativeBottom / itemHeight) + overscan);

  visibleStart.value = nextStart;
  visibleEnd.value = Math.max(nextStart, nextEnd);
};

const scheduleMeasure = () => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    updateVisibleRange();
  });
};

const handleScroll = () => {
  scheduleMeasure();
};

const bindScrollContainer = () => {
  const nextContainer = getScrollContainer();
  if (scrollContainerRef.value === nextContainer) return;
  if (scrollContainerRef.value) {
    scrollContainerRef.value.removeEventListener('scroll', handleScroll);
  }
  scrollContainerRef.value = nextContainer;
  scrollContainerRef.value?.addEventListener('scroll', handleScroll, { passive: true });
};

const scrollToIndex = (index: number, behavior: ScrollBehavior = 'auto') => {
  const scrollContainer = scrollContainerRef.value ?? getScrollContainer();
  const containerEl = containerRef.value;
  if (!scrollContainer || !containerEl) return;

  const scrollContainerRect = scrollContainer.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  const listTop = containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
  const targetTop = listTop + index * itemHeight;
  scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior });
  scheduleMeasure();
};

const getStickyOffset = (scrollContainer: HTMLElement): number => {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  const stickyNodes = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>('.sliver-header-root, .song-list-sticky'),
  );
  if (stickyNodes.length === 0) return 0;
  const bottoms = stickyNodes
    .map((node) => node.getBoundingClientRect().bottom - containerTop)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (bottoms.length === 0) return 0;
  return Math.max(...bottoms);
};

const adjustActiveIntoView = (smooth = false) => {
  const scrollContainer = getScrollContainer();
  if (!scrollContainer || !activeIdText.value) return;
  const row = scrollContainer.querySelector<HTMLElement>(
    `[data-song-row][data-song-id="${activeIdText.value}"]`,
  );
  if (!row) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const stickyOffset = getStickyOffset(scrollContainer);
  const topLimit = containerRect.top + stickyOffset + 8;
  const bottomLimit = containerRect.bottom - 12;
  if (rowRect.top < topLimit) {
    const target = scrollContainer.scrollTop - (topLimit - rowRect.top);
    scrollContainer.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  if (rowRect.bottom > bottomLimit) {
    const target = scrollContainer.scrollTop + (rowRect.bottom - bottomLimit);
    scrollContainer.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  }
};

const isActiveVisible = (): boolean => {
  const scrollContainer = getScrollContainer();
  if (!scrollContainer || !activeIdText.value) return false;
  const row = scrollContainer.querySelector<HTMLElement>(
    `[data-song-row][data-song-id="${activeIdText.value}"]`,
  );
  if (!row) return false;
  const containerRect = scrollContainer.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const stickyOffset = getStickyOffset(scrollContainer);
  const topLimit = containerRect.top + stickyOffset + 8;
  const bottomLimit = containerRect.bottom - 12;
  return rowRect.top >= topLimit && rowRect.bottom <= bottomLimit;
};

const scrollToActive = async () => {
  if (!activeIdText.value) return;
  if (isActiveVisible()) return;
  const index = filteredSongs.value.findIndex((s) => readString(s.id) === activeIdText.value);
  if (index === -1) return;
  scrollToIndex(index);
  await nextTick();
  const scrollContainer = getScrollContainer();
  const scrollerEl = containerRef.value;
  if (scrollContainer && scrollerEl) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const scrollerRect = scrollerEl.getBoundingClientRect();
    const scrollerOffset = scrollerRect.top - containerRect.top;
    const stickyOffset = getStickyOffset(scrollContainer);
    const targetTop =
      index * itemHeight + scrollContainer.scrollTop + scrollerOffset - stickyOffset - 8;
    scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    requestAnimationFrame(() => adjustActiveIntoView(true));
    return;
  }
  requestAnimationFrame(() => adjustActiveIntoView(true));
};

watch(
  filteredSongs,
  () => {
    scheduleMeasure();
  },
  { flush: 'post' },
);

watch(
  () => props.loading,
  () => {
    scheduleMeasure();
  },
  { flush: 'post' },
);

watch(
  () => props.active,
  async (active) => {
    if (!active) {
      visibleStart.value = 0;
      visibleEnd.value = 0;
      return;
    }
    await nextTick();
    bindScrollContainer();
    scheduleMeasure();
  },
  { flush: 'post' },
);

onMounted(async () => {
  await nextTick();
  bindScrollContainer();
  window.addEventListener('resize', scheduleMeasure, { passive: true });
  scheduleMeasure();
});

onBeforeUnmount(() => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  window.removeEventListener('resize', scheduleMeasure);
  scrollContainerRef.value?.removeEventListener('scroll', handleScroll);
});

useResizeObserver(containerRef, () => {
  scheduleMeasure();
});

defineExpose({ scrollToActive, filteredCount: computed(() => filteredSongs.value.length) });
</script>

<template>
  <div ref="containerRef" class="song-list-container scroll-smooth">
    <div
      v-if="!props.loading && filteredSongs.length > 0"
      :style="wrapperStyle"
      class="song-list-inner"
    >
      <div :style="visibleBlockStyle">
        <div
          v-for="entry in list"
          :key="
            props.itemKeyField === 'historyKey'
              ? (entry.data.historyKey ?? entry.data.id)
              : entry.data.id
          "
          class="song-list-row group rounded-lg transition-all duration-200 cursor-default"
          :style="{ height: `${itemHeight}px`, opacity: rowOpacity(entry.data) }"
          :class="{ 'is-active': isActiveSong(entry.data) }"
          :data-song-row="true"
          :data-song-id="readString(entry.data.id)"
        >
          <div
            class="song-list-row-inner grid items-center w-full h-full"
            :class="props.rowPaddingClass"
            :style="{ gridTemplateColumns: rowGridTemplate }"
          >
            <div v-if="showIndex" class="flex items-center justify-start pl-2">
              <div class="relative w-4 h-4">
                <template v-if="isActiveSong(entry.data)">
                  <div
                    v-if="playerStore.isPlaying"
                    class="absolute inset-0 flex items-center justify-center text-primary cursor-pointer"
                    @click.stop="handleTogglePlay(entry.data)"
                  >
                    <Icon :icon="iconPause" width="14" height="14" />
                  </div>
                  <div
                    v-else
                    class="absolute inset-0 flex items-center justify-center text-primary cursor-pointer"
                    @click.stop="handleTogglePlay(entry.data)"
                  >
                    <Icon :icon="iconPlay" width="14" height="14" />
                  </div>
                </template>
                <template v-else>
                  <span
                    class="absolute inset-0 flex items-center justify-center text-[12px] opacity-60 transition-opacity group-hover:opacity-0"
                  >
                    {{ entry.index + 1 }}
                  </span>
                  <Icon
                    class="absolute inset-0 m-auto opacity-0 transition-opacity group-hover:opacity-100 text-text-main cursor-pointer"
                    :icon="iconPlay"
                    width="14"
                    height="14"
                    @click.stop="handleTogglePlay(entry.data)"
                  />
                </template>
              </div>
            </div>

            <div class="min-w-0">
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
                :isOriginal="entry.data.isOriginal"
                :mixSongId="entry.data.mixSongId"
                :fileId="entry.data.fileId"
                :privilege="entry.data.privilege"
                :payType="entry.data.payType"
                :oldCpy="entry.data.oldCpy"
                :relateGoods="entry.data.relateGoods"
                :parentPlaylistId="props.parentPlaylistId"
                :enableRemoveFromPlaylist="props.enableRemoveFromPlaylist"
                :onRemovedFromPlaylist="props.onRemovedFromPlaylist"
                :showCover="showCover"
                :showAlbum="false"
                :showDuration="false"
                :showMore="true"
                :active="isActiveSong(entry.data)"
                :queueContext="props.songs"
                :queueOptions="props.queueOptions"
                :queueFilteredInvalidCount="props.queueFilteredInvalidCount"
                :onDoubleTapPlay="props.onSongDoubleTapPlay"
                :enableDefaultDoubleTapPlay="props.enableDefaultDoubleTapPlay"
                variant="list"
              />
            </div>

            <Button
              v-if="showAlbum"
              variant="unstyled"
              size="none"
              type="button"
              class="min-w-0 hidden md:block pr-3 text-[13px] text-left text-text-main/70 truncate"
              :class="isAlbumClickable(entry.data) ? 'song-list-meta-link' : ''"
              :disabled="!isAlbumClickable(entry.data)"
              @click.stop="openAlbumDetail(entry.data)"
            >
              {{ entry.data.album || '未知专辑' }}
            </Button>

            <div
              v-if="showDuration"
              class="pl-2 text-[12px] opacity-60 text-left whitespace-nowrap"
            >
              {{ formatDuration(entry.data.duration) }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 加载动画 -->
    <div v-if="props.loading" class="flex items-center justify-center py-20">
      <div
        class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
      ></div>
    </div>

    <!-- 暂无数据 -->
    <div
      v-else-if="filteredSongs.length === 0"
      class="py-20 text-center opacity-50 text-[14px] italic"
    >
      {{ props.searchQuery ? '未找到相关歌曲' : '暂无歌曲' }}
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.song-list-container {
  user-select: none;
  -webkit-user-select: none;
  width: 100%;
  /* 确保即使在 display: none 状态下也有基本高度参考（可选，取决于 useVirtualList 实现） */
  min-height: 200px;
}

.song-list-row {
  width: 100%;
  user-select: none;
  -webkit-user-select: none;
}

.song-list-row-inner {
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}

.song-list-row:hover {
  background: var(--color-bg-card);
}

.dark .song-list-row:hover {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.song-list-row.is-active {
  background: var(--color-bg-card);
}

.dark .song-list-row.is-active {
  background: color-mix(in srgb, #ffffff 4%, transparent);
}

.song-list-row :deep(.song-card),
.song-list-row :deep(.song-content),
.song-list-row :deep(.song-title),
.song-list-row :deep(.song-subline),
.song-list-row :deep(img) {
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

.song-list-meta-link {
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}

.song-list-meta-link:hover {
  color: var(--color-primary);
}
</style>
