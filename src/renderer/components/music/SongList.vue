<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { formatDuration } from '@/utils/format';
import SongCard from './SongCard.vue';
import { iconPlay, iconPause } from '@/icons';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useToastStore } from '@/stores/toast';
import { buildSongListGridTemplate } from './songListLayout';
import { isPlayableSong } from '@/utils/song';
import {
  playSongInContext,
  queueAndPlaySong,
  addSongToPlayNext,
  addSongToPlayLast,
} from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { useUserStore } from '@/stores/user';
import { useScrollContainer } from '@/composables/usePageScroll';
import { useVirtualList } from '@/composables/useVirtualList';
import { songContextMenuExtensions } from './songContextMenuExtensions';

interface Props {
  songs: Song[];
  contextSongs?: Song[];
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
  showLyricColumn?: boolean;
  stickySelector?: string;
  disableInternalFilter?: boolean;
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
  showLyricColumn: false,
  stickySelector: '',
  contextSongs: undefined,
  disableInternalFilter: false,
});

// const emit = defineEmits<{
//   (e: 'more', song: Song): void;
// }>();

const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const toastStore = useToastStore();
const router = useRouter();
const route = useRoute();

const readString = (value: unknown, fallback = ''): string => {
  if (value === undefined || value === null) return fallback;
  return String(value);
};

const getSongIdText = (song: Song) => readString(song.id);

// 缓存播放状态，避免每次渲染都访问 store
const isPlaying = ref(playerStore.isPlaying);
let playingStateTimer = 0;
const updatePlayingState = () => {
  if (playingStateTimer) return;
  playingStateTimer = window.setTimeout(() => {
    playingStateTimer = 0;
    isPlaying.value = playerStore.isPlaying;
  }, 100);
};

const filteredSongsRef = shallowRef<Song[]>([]);
const queueContextSongs = computed(() => props.contextSongs ?? props.songs);
const normalizedSearchQuery = computed(() => props.searchQuery.trim().toLowerCase());
const hasSearchQuery = computed(() => normalizedSearchQuery.value.length > 0);

const updateFilteredSongs = () => {
  if (props.disableInternalFilter || !hasSearchQuery.value) {
    filteredSongsRef.value = props.songs;
    return;
  }
  const q = normalizedSearchQuery.value;
  filteredSongsRef.value = props.songs.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.album?.toLowerCase().includes(q),
  );
};

watch(
  [() => props.songs, () => props.searchQuery, () => props.disableInternalFilter],
  updateFilteredSongs,
  { immediate: true },
);

const sourceSongsById = computed(() => {
  const map = new Map<string, Song>();
  props.songs.forEach((song) => {
    map.set(getSongIdText(song), song);
  });
  return map;
});

const contextSongsById = computed(() => {
  if (queueContextSongs.value === props.songs) return sourceSongsById.value;
  const map = new Map<string, Song>();
  queueContextSongs.value.forEach((song) => {
    map.set(getSongIdText(song), song);
  });
  return map;
});

const filteredSongsById = computed(() => {
  const map = new Map<string, Song>();
  filteredSongsRef.value.forEach((song) => {
    map.set(getSongIdText(song), song);
  });
  return map;
});

const filteredSongIndexMap = computed(() => {
  const map = new Map<string, number>();
  filteredSongsRef.value.forEach((song, index) => {
    map.set(getSongIdText(song), index);
  });
  return map;
});

const itemHeight = 60;
const overscan = 10;
const scrollContainerRef = useScrollContainer();
const {
  containerRef,
  visibleStart,
  visibleEnd,
  totalSize: totalHeight,
  offset: visibleOffset,
  scrollToIndex,
} = useVirtualList({
  itemCount: computed(() => filteredSongsRef.value.length),
  itemSize: itemHeight,
  overscan,
  active: computed(() => props.active),
  loading: computed(() => props.loading),
  scrollContainer: scrollContainerRef,
  cacheOffsets: true,
});

const list = computed(() => {
  if (!props.active)
    return [] as Array<{
      data: Song;
      index: number;
      idText: string;
      isActive: boolean;
      opacity: number;
    }>;
  const start = visibleStart.value;
  const end = visibleEnd.value;
  const source = filteredSongsRef.value;
  if (start === end || source.length === 0)
    return [] as Array<{
      data: Song;
      index: number;
      idText: string;
      isActive: boolean;
      opacity: number;
    }>;
  return source.slice(start, end).map((data, index) => ({
    data,
    index: start + index,
    idText: getSongIdText(data),
    isActive: getSongIdText(data) === activeIdText.value,
    opacity: rowOpacity(data),
  }));
});

const wrapperStyle = computed(() => ({
  height: `${totalHeight.value}px`,
  position: 'relative' as const,
}));

const visibleBlockStyle = computed(() => ({
  transform: `translateY(${visibleOffset.value}px)`,
}));

const rowGridTemplate = computed(() =>
  buildSongListGridTemplate({
    showIndex: props.showIndex,
    showAlbum: props.showAlbum,
    showDuration: props.showDuration,
    lyricColumn: props.showLyricColumn,
  }),
);

const isSongPlayable = (song: Song) => isPlayableSong(song);

const rowOpacity = (song: Song) => (isSongPlayable(song) ? 1 : 0.45);

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

  const target = sourceSongsById.value.get(getSongIdText(song)) ?? song;
  if ((queueContextSongs.value.length ?? 0) > 0 && props.queueOptions?.queueId) {
    await playSongInContext(
      playlistStore,
      playerStore,
      target,
      queueContextSongs.value,
      props.queueFilteredInvalidCount ?? 0,
      props.queueOptions,
    );
    return;
  }
  await queueAndPlaySong(playlistStore, playerStore, target, props.queueOptions);
};

const getScrollContainer = (): HTMLElement | null => scrollContainerRef.value;

let cachedStickyContainer: HTMLElement | null = null;
let cachedStickySelector = '';
let cachedStickyNodes: HTMLElement[] = [];
let cachedStickyOffset = 0;
let stickyOffsetFrame = 0;
let stickyOffsetDirty = true;

const clearStickyOffsetCache = () => {
  cachedStickyContainer = null;
  cachedStickySelector = '';
  cachedStickyNodes = [];
  cachedStickyOffset = 0;
  stickyOffsetDirty = true;
};

const getStickyOffset = (scrollContainer: HTMLElement): number => {
  const baseSelector = '.sliver-header-root, .song-list-sticky';
  const selector = props.stickySelector ? `${baseSelector}, ${props.stickySelector}` : baseSelector;
  if (cachedStickyContainer !== scrollContainer || cachedStickySelector !== selector) {
    cachedStickyContainer = scrollContainer;
    cachedStickySelector = selector;
    cachedStickyNodes = Array.from(scrollContainer.querySelectorAll<HTMLElement>(selector));
    stickyOffsetDirty = true;
  }
  if (!stickyOffsetDirty) return cachedStickyOffset;
  if (cachedStickyNodes.length === 0) {
    cachedStickyOffset = 0;
    stickyOffsetDirty = false;
    return cachedStickyOffset;
  }
  const containerTop = scrollContainer.getBoundingClientRect().top;
  let maxBottom = 0;
  cachedStickyNodes = cachedStickyNodes.filter((node) => node.isConnected);
  cachedStickyNodes.forEach((node) => {
    const bottom = node.getBoundingClientRect().bottom - containerTop;
    if (Number.isFinite(bottom) && bottom > maxBottom) {
      maxBottom = bottom;
    }
  });
  cachedStickyOffset = maxBottom;
  stickyOffsetDirty = false;
  return cachedStickyOffset;
};

const scheduleStickyOffsetRefresh = () => {
  stickyOffsetDirty = true;
  if (stickyOffsetFrame) return;
  stickyOffsetFrame = requestAnimationFrame(() => {
    stickyOffsetFrame = 0;
    stickyOffsetDirty = true;
  });
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
  const index = filteredSongIndexMap.value.get(activeIdText.value);
  if (index === undefined) return;
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
  () => playerStore.isPlaying,
  () => {
    updatePlayingState();
  },
);
isPlaying.value = playerStore.isPlaying;

onBeforeUnmount(() => {
  if (playingStateTimer) clearTimeout(playingStateTimer);
  if (stickyOffsetFrame) cancelAnimationFrame(stickyOffsetFrame);
  clearStickyOffsetCache();
});

// ── 单例右键菜单 ──

const userStore = useUserStore();
const contextMenuOpen = ref(false);
const contextMenuTarget = ref<Song | null>(null);
const contextMenuTargetId = ref<string | null>(null);
const contextMenuRef = ref<HTMLElement | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });
const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);
let contextMenuPoint: { x: number; y: number } | null = null;

const contextMenuStyle = computed(() => ({
  left: `${contextMenuPosition.value.x}px`,
  top: `${contextMenuPosition.value.y}px`,
}));

const selectablePlaylists = computed(() =>
  playlistStore.getCreatedPlaylists(userStore.info?.userid),
);

const contextMenuCanRemove = computed(() => {
  if (!props.enableRemoveFromPlaylist || !contextMenuTarget.value) return false;
  return playlistStore.isOwnedPlaylist(props.parentPlaylistId, userStore.info?.userid);
});

const extensionContextMenuItems = computed(() => {
  const song = contextMenuTarget.value;
  if (!song) return [];
  return songContextMenuExtensions.value.filter((item) => {
    try {
      return item.visible ? item.visible(song) : true;
    } catch {
      return false;
    }
  });
});

const isExtensionContextItemEnabled = (item: (typeof extensionContextMenuItems.value)[number]) => {
  const song = contextMenuTarget.value;
  if (!song) return false;
  try {
    return item.enabled ? item.enabled(song) : true;
  } catch {
    return false;
  }
};

const closeContextMenu = () => {
  contextMenuOpen.value = false;
};

const clearContextMenuTarget = () => {
  contextMenuTarget.value = null;
  contextMenuTargetId.value = null;
  contextMenuPoint = null;
};

const estimateContextMenuHeight = () => {
  const itemCount =
    3 + extensionContextMenuItems.value.length + (contextMenuCanRemove.value ? 1 : 0);
  const separatorCount =
    (extensionContextMenuItems.value.length > 0 ? 1 : 0) + (contextMenuCanRemove.value ? 1 : 0);
  return 12 + itemCount * 30 + separatorCount * 9 + Math.max(0, itemCount + separatorCount - 1) * 4;
};

const updateContextMenuPosition = () => {
  if (!contextMenuPoint) return;
  const menu = contextMenuRef.value;
  const width = menu?.offsetWidth || 172;
  const height = menu?.offsetHeight || estimateContextMenuHeight();
  const padding = 8;
  const bottomPadding = 96;
  const maxX = Math.max(padding, window.innerWidth - width - padding);
  const maxY = Math.max(padding, window.innerHeight - height - bottomPadding);
  contextMenuPosition.value = {
    x: Math.round(Math.min(Math.max(contextMenuPoint.x, padding), maxX)),
    y: Math.round(Math.min(Math.max(contextMenuPoint.y, padding), maxY)),
  };
};

const handleContextMenu = (event: MouseEvent) => {
  const target = (event.target as HTMLElement)?.closest<HTMLElement>('[data-song-row]');
  if (!target) {
    event.preventDefault();
    closeContextMenu();
    clearContextMenuTarget();
    return;
  }
  const songId = target.dataset.songId;
  if (!songId) {
    event.preventDefault();
    closeContextMenu();
    clearContextMenuTarget();
    return;
  }
  const song =
    filteredSongsById.value.get(songId) ??
    sourceSongsById.value.get(songId) ??
    contextSongsById.value.get(songId);
  if (!song) {
    event.preventDefault();
    closeContextMenu();
    clearContextMenuTarget();
    return;
  }
  event.preventDefault();
  contextMenuPoint = { x: event.clientX, y: event.clientY };
  contextMenuPosition.value = contextMenuPoint;
  contextMenuTarget.value = song;
  contextMenuTargetId.value = songId;
  contextMenuOpen.value = true;
  void nextTick(updateContextMenuPosition);
};

const handleContextMenuAction = (action: () => void | Promise<void>) => {
  closeContextMenu();
  void action();
};

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!contextMenuOpen.value) return;
  const target = event.target as Node | null;
  if (target && contextMenuRef.value?.contains(target)) return;
  closeContextMenu();
};

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && contextMenuOpen.value) {
    event.preventDefault();
    closeContextMenu();
  }
};

const handleWindowViewportChange = () => {
  if (contextMenuOpen.value) closeContextMenu();
};

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeydown, true);
  window.addEventListener('resize', handleWindowViewportChange);
  window.addEventListener('scroll', handleWindowViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  document.removeEventListener('keydown', handleDocumentKeydown, true);
  window.removeEventListener('resize', handleWindowViewportChange);
  window.removeEventListener('scroll', handleWindowViewportChange, true);
});

const ctxPlayNow = async () => {
  const song = contextMenuTarget.value;
  if (!song || !isPlayableSong(song)) return;
  if ((queueContextSongs.value.length ?? 0) > 0 && props.queueOptions?.queueId) {
    await playSongInContext(
      playlistStore,
      playerStore,
      song,
      queueContextSongs.value,
      props.queueFilteredInvalidCount ?? 0,
      props.queueOptions,
    );
    return;
  }
  await queueAndPlaySong(playlistStore, playerStore, song, props.queueOptions);
};

const ctxPlayNext = () => {
  const song = contextMenuTarget.value;
  if (!song || !isPlayableSong(song)) return;
  addSongToPlayNext(playlistStore, playerStore, song);
};

const ctxPlayLast = () => {
  const song = contextMenuTarget.value;
  if (!song || !isPlayableSong(song)) return;
  addSongToPlayLast(playlistStore, playerStore, song);
};

const ctxAddToPlaylist = async () => {
  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    try {
      await playlistStore.fetchUserPlaylists();
    } catch {
      toastStore.loadFailed('歌单');
    } finally {
      isPlaylistLoading.value = false;
    }
  }
};

const ctxSelectPlaylist = async (listId: string | number) => {
  const song = contextMenuTarget.value;
  if (!song) return;
  try {
    const result = await playlistStore.addToPlaylist(String(listId), song);
    if (result === 'added') {
      toastStore.actionCompleted('添加成功');
      showPlaylistDialog.value = false;
      return;
    }
    if (result === 'exists') {
      toastStore.warning('歌单中已有此内容');
      showPlaylistDialog.value = false;
      return;
    }
    toastStore.actionFailed('添加到歌单');
  } catch {
    toastStore.actionFailed('添加到歌单');
  }
};

const ctxRemoveFromPlaylist = async () => {
  const song = contextMenuTarget.value;
  if (!song || !props.parentPlaylistId) return;
  const success = await playlistStore.removeFromPlaylist(String(props.parentPlaylistId), song);
  if (success) {
    props.onRemovedFromPlaylist?.(song);
  }
};

const ctxExtensionAction = async (item: (typeof extensionContextMenuItems.value)[number]) => {
  const song = contextMenuTarget.value;
  if (!song || !isExtensionContextItemEnabled(item)) return;
  try {
    await item.onSelect(song);
  } catch {
    toastStore.actionFailed(item.label || '歌曲操作');
  }
};

// 右键菜单关闭后移除行高亮；保留 target，添加到歌单弹窗还需要它。
watch(contextMenuOpen, (isOpen) => {
  if (!isOpen) {
    contextMenuTargetId.value = null;
  }
  // 菜单打开时禁止滚动容器滚动
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    if (isOpen) {
      scrollContainer.style.overflow = 'hidden';
    } else {
      scrollContainer.style.overflow = '';
    }
  }
});

watch([() => props.stickySelector, scrollContainerRef], () => {
  clearStickyOffsetCache();
  scheduleStickyOffsetRefresh();
});

watch(
  () => [props.active, props.loading, filteredSongsRef.value.length],
  () => {
    scheduleStickyOffsetRefresh();
  },
  { flush: 'post' },
);

defineExpose({ scrollToActive, filteredCount: computed(() => filteredSongsRef.value.length) });
</script>

<template>
  <div
    ref="containerRef"
    class="song-list-container scroll-smooth"
    @contextmenu="handleContextMenu"
  >
    <div
      v-if="!props.loading && filteredSongsRef.length > 0"
      :style="wrapperStyle"
      class="song-list-inner"
    >
      <div :style="visibleBlockStyle" class="will-change-transform">
        <div
          v-for="entry in list"
          :key="
            props.itemKeyField === 'historyKey'
              ? (entry.data.historyKey ?? entry.data.id)
              : entry.data.id
          "
          class="song-list-row group rounded-lg cursor-default content-visibility-auto"
          :style="{ height: `${itemHeight}px`, opacity: entry.opacity }"
          :class="{
            'is-active': entry.isActive,
            'is-context-target': contextMenuOpen && contextMenuTargetId === entry.idText,
          }"
          :data-song-row="true"
          :data-song-id="entry.idText"
        >
          <div
            class="song-list-row-inner grid items-center w-full h-full"
            :class="props.rowPaddingClass"
            :style="{ gridTemplateColumns: rowGridTemplate }"
          >
            <div v-if="showIndex" class="flex items-center justify-start pl-2">
              <div class="relative w-4 h-4">
                <template v-if="entry.isActive">
                  <div
                    v-show="isPlaying"
                    class="absolute inset-0 flex items-center justify-center text-primary cursor-pointer"
                    @click.stop="handleTogglePlay(entry.data)"
                  >
                    <Icon :icon="iconPause" width="14" height="14" />
                  </div>
                  <div
                    v-show="!isPlaying"
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
                :song="entry.data"
                :showCover="showCover"
                :showAlbum="false"
                :showDuration="false"
                :showMore="true"
                :active="entry.isActive"
                :queueContext="queueContextSongs"
                :queueOptions="props.queueOptions"
                :queueFilteredInvalidCount="props.queueFilteredInvalidCount"
                :onDoubleTapPlay="props.onSongDoubleTapPlay"
                :enableDefaultDoubleTapPlay="props.enableDefaultDoubleTapPlay"
                variant="list"
              />
            </div>

            <Button
              v-if="showAlbum && !showLyricColumn"
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
              v-if="showLyricColumn && showAlbum"
              class="min-w-0 hidden md:block pr-3 text-[12px] text-left text-text-main/45 truncate"
            >
              {{ entry.data.lyricSnippet || '' }}
            </div>

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
      v-else-if="filteredSongsRef.length === 0"
      class="py-20 text-center opacity-50 text-[14px] italic"
    >
      {{ hasSearchQuery ? '未找到相关歌曲' : '暂无歌曲' }}
    </div>

    <!-- 单例添加到歌单对话框 -->
    <Dialog
      v-model:open="showPlaylistDialog"
      title="添加到歌单"
      contentClass="max-w-[420px]"
      showClose
    >
      <div class="flex flex-col gap-3">
        <div v-if="isPlaylistLoading" class="py-6 text-center text-text-secondary text-[12px]">
          加载歌单中...
        </div>
        <div
          v-else-if="selectablePlaylists.length === 0"
          class="py-6 text-center text-text-secondary text-[12px]"
        >
          暂无可用歌单
        </div>
        <Button
          v-for="entry in selectablePlaylists"
          :key="entry.listid ?? entry.id"
          type="button"
          class="playlist-picker-item"
          variant="ghost"
          size="sm"
          @click="ctxSelectPlaylist(entry.listid ?? entry.id)"
        >
          <span class="text-[13px] font-semibold text-text-main truncate">{{ entry.name }}</span>
          <span class="text-[11px] text-text-secondary/60">{{ entry.count ?? 0 }} 首</span>
        </Button>
      </div>
    </Dialog>
  </div>

  <!-- 单例右键菜单（整个列表共享一个实例） -->
  <Teleport to="body">
    <div
      v-if="contextMenuOpen && contextMenuTarget"
      ref="contextMenuRef"
      class="song-context-menu"
      :style="contextMenuStyle"
      role="menu"
      @contextmenu.prevent
    >
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxPlayNow)"
      >
        立即播放
      </button>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxPlayNext)"
      >
        下一首播放
      </button>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxPlayLast)"
      >
        排队候播
      </button>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxAddToPlaylist)"
      >
        添加到歌单
      </button>
      <div v-if="extensionContextMenuItems.length > 0" class="song-context-separator"></div>
      <button
        v-for="item in extensionContextMenuItems"
        :key="item.id"
        type="button"
        class="song-context-item"
        :class="{ 'text-red-500': item.danger }"
        :disabled="!isExtensionContextItemEnabled(item)"
        role="menuitem"
        @click="handleContextMenuAction(() => ctxExtensionAction(item))"
      >
        {{ item.label }}
      </button>
      <div v-if="contextMenuCanRemove" class="song-context-separator"></div>
      <button
        v-if="contextMenuCanRemove"
        type="button"
        class="song-context-item text-red-500"
        role="menuitem"
        @click="handleContextMenuAction(ctxRemoveFromPlaylist)"
      >
        从歌单删除
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
@reference "@/style.css";

.song-list-container {
  user-select: none;
  -webkit-user-select: none;
  width: 100%;
  min-height: 200px;
  contain: style;
}

.song-list-row {
  width: 100%;
  user-select: none;
  -webkit-user-select: none;
  contain: layout style paint;
  transition: background-color 0.15s ease;
}

.song-list-row-inner {
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}

.song-list-row:hover {
  background: var(--row-hover-bg);
}

.song-list-row.is-active {
  background: var(--row-selected-bg);
}

.song-list-row.is-context-target {
  background: var(--row-active-bg);
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

.will-change-transform {
  will-change: transform;
}

.content-visibility-auto {
  content-visibility: auto;
}

:global(.song-context-menu) {
  position: fixed;
  min-width: 172px;
  padding: 6px;
  border-radius: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-elevated);
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 1200;
  outline: none;
  contain: paint;
  isolation: isolate;
  transform: translateZ(0);
  backface-visibility: hidden;
}

:global(body.echo-surface-translucent .song-context-menu.song-context-menu) {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background: var(--surface-elevated-base);
}

:global(.song-context-item) {
  appearance: none;
  border: 0;
  background: transparent;
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-main);
  outline: none;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

:global(.song-context-item:not(:disabled):hover),
:global(.song-context-item:not(:disabled):focus-visible) {
  background-color: var(--row-hover-bg);
  color: var(--color-primary);
}

:global(.song-context-item:disabled) {
  cursor: default;
  opacity: 0.45;
}

:global(.song-context-separator) {
  height: 1px;
  margin: 4px 6px;
  background-color: var(--border-subtle);
}

.playlist-picker-item {
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

.playlist-picker-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
</style>
