<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useResizeObserver } from '@vueuse/core';
import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { formatDuration } from '@/utils/format';
import SongCard from './SongCard.vue';
import { iconPlay, iconPause } from '@/icons';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore, sortPlaylists } from '@/stores/playlist';
import type { PlaylistSortOrder } from '@/stores/playlist';
import { buildSongListGridTemplate } from './songListLayout';
import { isPlayableSong } from '@/utils/song';
import { playSongInContext, queueAndPlaySong, addSongToPlayNext } from '@/utils/playback';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
} from 'reka-ui';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import { useScrollContainer } from '@/composables/usePageScroll';

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
  showLyricColumn?: boolean;
  stickySelector?: string;
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
});

// const emit = defineEmits<{
//   (e: 'more', song: Song): void;
// }>();

const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const settingStore = useSettingStore();
const router = useRouter();
const route = useRoute();

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

const updateFilteredSongs = () => {
  if (!props.searchQuery.trim()) {
    filteredSongsRef.value = props.songs;
    return;
  }
  const q = props.searchQuery.toLowerCase();
  filteredSongsRef.value = props.songs.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      s.album?.toLowerCase().includes(q),
  );
};

watch(() => [props.songs, props.searchQuery], updateFilteredSongs, { immediate: true });

const itemHeight = 60;
const overscan = 10;
const containerRef = ref<HTMLElement | null>(null);
const visibleStart = ref(0);
const visibleEnd = ref(0);
let measureFrame = 0;

const totalHeight = computed(() => filteredSongsRef.value.length * itemHeight);

const list = computed(() => {
  if (!props.active) return [] as Array<{ data: Song; index: number }>;
  const start = visibleStart.value;
  const end = visibleEnd.value;
  const source = filteredSongsRef.value;
  if (start === end || source.length === 0) return [] as Array<{ data: Song; index: number }>;
  return source.slice(start, end).map((data, index) => ({
    data,
    index: start + index,
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
    lyricColumn: props.showLyricColumn,
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

const scrollContainerRef = useScrollContainer();

const getScrollContainer = (): HTMLElement | null => scrollContainerRef.value;

// 性能优化：缓存容器尺寸与偏移，避免滚动时频繁触发 Layout Sync
const cachedOffsets = {
  listContentTop: -1,
  viewportHeight: -1,
  isDirty: true,
};

const updateVisibleRange = () => {
  const totalCount = filteredSongsRef.value.length;
  if (!props.active || props.loading || totalCount === 0) {
    if (visibleStart.value !== 0) visibleStart.value = 0;
    if (visibleEnd.value !== 0) visibleEnd.value = 0;
    return;
  }

  const scrollContainer = getScrollContainer();
  const containerEl = containerRef.value;

  if (!scrollContainer || !containerEl) {
    const fallbackEnd = Math.min(totalCount, overscan * 4);
    if (visibleStart.value !== 0) visibleStart.value = 0;
    if (visibleEnd.value !== fallbackEnd) visibleEnd.value = fallbackEnd;
    return;
  }

  // 仅在必要时测量尺寸（Layout Sync）
  if (cachedOffsets.isDirty || cachedOffsets.listContentTop < 0) {
    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    // 列表相对于滚动容器内容的绝对偏移
    cachedOffsets.listContentTop =
      containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
    cachedOffsets.viewportHeight = scrollContainer.clientHeight;
    cachedOffsets.isDirty = false;
  }

  const listTop = cachedOffsets.listContentTop;
  const listBottom = listTop + totalHeight.value;
  const viewportTop = scrollContainer.scrollTop;
  const viewportBottom = viewportTop + cachedOffsets.viewportHeight;

  if (viewportBottom <= listTop || viewportTop >= listBottom) {
    if (visibleStart.value !== 0) visibleStart.value = 0;
    if (visibleEnd.value !== 0) visibleEnd.value = 0;
    return;
  }

  const relativeTop = Math.max(0, viewportTop - listTop);
  const relativeBottom = Math.max(0, Math.min(totalHeight.value, viewportBottom - listTop));
  const nextStart = Math.max(0, Math.floor(relativeTop / itemHeight) - overscan);
  const nextEnd = Math.min(totalCount, Math.ceil(relativeBottom / itemHeight) + overscan);

  if (visibleStart.value !== nextStart) visibleStart.value = nextStart;
  if (visibleEnd.value !== Math.max(nextStart, nextEnd))
    visibleEnd.value = Math.max(nextStart, nextEnd);
};

const scheduleMeasure = (forceDirty = false) => {
  if (forceDirty) cachedOffsets.isDirty = true;
  if (measureFrame) cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    updateVisibleRange();
  });
};

const handleScroll = () => {
  scheduleMeasure();
};

let boundContainer: HTMLElement | null = null;

const bindScrollContainer = () => {
  const nextContainer = getScrollContainer();
  if (boundContainer === nextContainer) return;
  if (boundContainer) {
    boundContainer.removeEventListener('scroll', handleScroll);
  }
  boundContainer = nextContainer;
  boundContainer?.addEventListener('scroll', handleScroll, { passive: true });
  cachedOffsets.isDirty = true;
};

const scrollToIndex = (index: number, behavior: ScrollBehavior = 'auto') => {
  const scrollContainer = getScrollContainer();
  const containerEl = containerRef.value;
  if (!scrollContainer || !containerEl) return;

  // 使用缓存避免强制 Layout
  if (cachedOffsets.isDirty || cachedOffsets.listContentTop < 0) {
    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    cachedOffsets.listContentTop =
      containerRect.top - scrollContainerRect.top + scrollContainer.scrollTop;
    cachedOffsets.viewportHeight = scrollContainer.clientHeight;
    cachedOffsets.isDirty = false;
  }

  const targetTop = cachedOffsets.listContentTop + index * itemHeight;
  scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior });
  scheduleMeasure();
};

const getStickyOffset = (scrollContainer: HTMLElement): number => {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  const baseSelector = '.sliver-header-root, .song-list-sticky';
  const selector = props.stickySelector ? `${baseSelector}, ${props.stickySelector}` : baseSelector;
  const stickyNodes = Array.from(scrollContainer.querySelectorAll<HTMLElement>(selector));
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
  const index = filteredSongsRef.value.findIndex((s) => readString(s.id) === activeIdText.value);
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
  () => playerStore.isPlaying,
  () => {
    updatePlayingState();
  },
);

watch(
  filteredSongsRef,
  () => {
    scheduleMeasure(true);
  },
  { flush: 'post' },
);

watch(
  () => props.loading,
  () => {
    scheduleMeasure(true);
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
    scheduleMeasure(true);
  },
  { flush: 'post' },
);

// 响应注入的滚动容器变化
watch(scrollContainerRef, () => {
  bindScrollContainer();
  scheduleMeasure(true);
});

// 修复：保存函数引用以确保 add/remove 使用同一引用
const handleResize = () => scheduleMeasure(true);

onMounted(async () => {
  await nextTick();
  bindScrollContainer();
  window.addEventListener('resize', handleResize, { passive: true });
  scheduleMeasure(true);
  isPlaying.value = playerStore.isPlaying;
});

onBeforeUnmount(() => {
  if (measureFrame) cancelAnimationFrame(measureFrame);
  if (playingStateTimer) clearTimeout(playingStateTimer);
  window.removeEventListener('resize', handleResize);
  boundContainer?.removeEventListener('scroll', handleScroll);
});

useResizeObserver(containerRef, () => {
  scheduleMeasure(true);
});

// ── 单例右键菜单 ──

const userStore = useUserStore();
const contextMenuOpen = ref(false);
const contextMenuTarget = ref<Song | null>(null);
const contextMenuTargetId = ref<string | null>(null);
const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);

const selectablePlaylists = computed(() =>
  sortPlaylists(
    playlistStore.getCreatedPlaylists(userStore.info?.userid),
    settingStore.playlistSortOrder as PlaylistSortOrder,
  ),
);

const contextMenuCanRemove = computed(() => {
  if (!props.enableRemoveFromPlaylist || !contextMenuTarget.value) return false;
  return playlistStore.isOwnedPlaylist(props.parentPlaylistId, userStore.info?.userid);
});

const handleContextMenu = (event: MouseEvent) => {
  const target = (event.target as HTMLElement)?.closest<HTMLElement>('[data-song-row]');
  if (!target) {
    contextMenuOpen.value = false;
    return;
  }
  const songId = target.dataset.songId;
  if (!songId) {
    contextMenuOpen.value = false;
    return;
  }
  const song = props.songs.find((s) => String(s.id) === songId);
  if (!song) {
    contextMenuOpen.value = false;
    return;
  }
  contextMenuTarget.value = song;
  contextMenuTargetId.value = songId;
};

const ctxPlayNow = async () => {
  const song = contextMenuTarget.value;
  if (!song || !isPlayableSong(song)) return;
  if ((props.songs?.length ?? 0) > 0 && props.queueOptions?.queueId) {
    await playSongInContext(
      playlistStore,
      playerStore,
      song,
      props.songs,
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

const ctxAddToPlaylist = async () => {
  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    await playlistStore.fetchUserPlaylists();
    isPlaylistLoading.value = false;
  }
};

const ctxSelectPlaylist = async (listId: string | number) => {
  const song = contextMenuTarget.value;
  if (!song) return;
  await playlistStore.addToPlaylist(String(listId), song);
  showPlaylistDialog.value = false;
};

const ctxRemoveFromPlaylist = async () => {
  const song = contextMenuTarget.value;
  if (!song || !props.parentPlaylistId) return;
  const success = await playlistStore.removeFromPlaylist(String(props.parentPlaylistId), song);
  if (success) {
    props.onRemovedFromPlaylist?.(song);
  }
};

// 右键菜单打开时锁定滚动，关闭时恢复
watch(contextMenuOpen, (isOpen) => {
  const scrollContainer = getScrollContainer();
  if (!scrollContainer) return;
  if (isOpen) {
    scrollContainer.style.overflow = 'hidden';
  } else {
    scrollContainer.style.overflow = '';
    contextMenuTargetId.value = null;
  }
});

defineExpose({ scrollToActive, filteredCount: computed(() => filteredSongsRef.value.length) });
</script>

<template>
  <ContextMenuRoot v-model:open="contextMenuOpen">
    <ContextMenuTrigger as-child>
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
              :style="{ height: `${itemHeight}px`, opacity: rowOpacity(entry.data) }"
              :class="{
                'is-active': isActiveSong(entry.data),
                'is-context-target':
                  contextMenuOpen && contextMenuTargetId === readString(entry.data.id),
              }"
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
          {{ props.searchQuery ? '未找到相关歌曲' : '暂无歌曲' }}
        </div>

        <!-- 单例右键菜单（整个列表共享一个实例） -->
        <ContextMenuPortal>
          <ContextMenuContent
            class="song-context-menu"
            :side-offset="4"
            :collision-padding="{ top: 8, right: 8, bottom: 96, left: 8 }"
            align="start"
          >
            <ContextMenuItem class="song-context-item" @select="ctxPlayNow">
              立即播放
            </ContextMenuItem>
            <ContextMenuItem class="song-context-item" @select="ctxPlayNext">
              下一首播放
            </ContextMenuItem>
            <ContextMenuItem class="song-context-item" @select="ctxAddToPlaylist">
              添加到歌单
            </ContextMenuItem>
            <div v-if="contextMenuCanRemove" class="song-context-separator"></div>
            <ContextMenuItem
              v-if="contextMenuCanRemove"
              class="song-context-item text-red-500"
              @select="ctxRemoveFromPlaylist"
            >
              从歌单删除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>

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
              <span class="text-[13px] font-semibold text-text-main truncate">{{
                entry.name
              }}</span>
              <span class="text-[11px] text-text-secondary/60">{{ entry.count ?? 0 }} 首</span>
            </Button>
          </div>
        </Dialog>
      </div>
    </ContextMenuTrigger>
  </ContextMenuRoot>
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

.song-list-row.is-context-target {
  background: var(--color-bg-card);
}

.dark .song-list-row.is-context-target {
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

.will-change-transform {
  will-change: transform;
}

.content-visibility-auto {
  content-visibility: auto;
}

:deep(.song-context-menu) {
  min-width: 172px;
  padding: 6px;
  border-radius: 12px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-light);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 1200;
}

:deep(.song-context-item) {
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-main);
  transition: all 0.2s ease;
}

:deep(.song-context-item:hover) {
  background-color: rgba(0, 0, 0, 0.05);
  color: var(--color-primary);
}

.dark :deep(.song-context-item:hover) {
  background-color: rgba(255, 255, 255, 0.08);
}

:deep(.song-context-separator) {
  height: 1px;
  margin: 4px 6px;
  background-color: var(--color-border-light);
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
</style>
