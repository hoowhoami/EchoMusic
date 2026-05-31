<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { useVModel } from '@vueuse/core';
import Sortable from 'sortablejs';
import Drawer from '@/components/ui/Drawer.vue';
import PlayerQueueVirtualList from '@/components/music/PlayerQueueVirtualList.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { Song } from '@/models/song';
import { isPlayableSong } from '@/utils/song';
import {
  iconTrash,
  iconX,
  iconPlay,
  iconPause,
  iconArrowUp,
  iconCurrentLocation,
  iconChevronLeft,
  iconChevronRight,
  iconPlus,
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
const userStore = useUserStore();
const toastStore = useToastStore();

type QueueLike = NonNullable<ReturnType<typeof usePlaylistStore>['activeQueue']>;
type QueueVirtualListExposed = {
  refresh: (forceDirty?: boolean) => void;
  scrollToTop: () => void;
  scrollToCurrent: (force?: boolean) => void;
  isCurrentVisible: () => boolean;
  getScroller: () => HTMLElement | null;
  getVisibleStart: () => number;
};

const itemHeight = 56;
const slidesRef = ref<HTMLElement | null>(null);
const queueListRefs = ref<Record<string, QueueVirtualListExposed | null>>({});
const previewQueueId = ref<string | null>(null);
const canSwipeQueues = ref(false);
const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);
const isAddingToPlaylist = ref(false);

const dragPointerId = ref<number | null>(null);
const dragStartX = ref(0);
const dragStartY = ref(0);
const dragOffsetX = ref(0);
const pendingDragOffsetX = ref(0);
const dragAxis = ref<'idle' | 'x' | 'y'>('idle');
const dragPointerType = ref<string | null>(null);
const isDraggingSlides = ref(false);
const animatePageTransition = ref(false);

let sortableInstance: Sortable | null = null;
let sortableInitToken = 0;
let pageTransitionTimer: number | null = null;
let dragAnimationFrame = 0;

const currentPlaybackQueue = computed(() => {
  const sourceQueueId = playerStore.currentSourceQueueId;
  return (
    playlistStore.getQueueById(sourceQueueId) ??
    playlistStore.activeQueue ??
    playlistStore.recentPlaybackQueues[0] ??
    null
  );
});

const queueOptions = computed(() => {
  const list: QueueLike[] = [];
  if (currentPlaybackQueue.value?.songs.length) list.push(currentPlaybackQueue.value);
  if (
    playlistStore.customPlaybackQueue &&
    playlistStore.customPlaybackQueue.id !== currentPlaybackQueue.value?.id &&
    playlistStore.customPlaybackQueue.songs.length > 0
  ) {
    list.push(playlistStore.customPlaybackQueue);
  }
  playlistStore.recentPlaybackQueues.forEach((queue) => {
    if (list.some((item) => item.id === queue.id)) return;
    if (queue.id === currentPlaybackQueue.value?.id) return;
    if (queue.type === 'fm') return;
    list.push(queue);
  });
  return list;
});

const previewQueue = computed(() => {
  const queueId = previewQueueId.value;
  if (!queueId) return queueOptions.value[0] ?? null;
  return queueOptions.value.find((queue) => queue.id === queueId) ?? queueOptions.value[0] ?? null;
});

const previewIndex = computed(() => {
  const targetId = previewQueue.value?.id ?? '';
  const index = queueOptions.value.findIndex((queue) => queue.id === targetId);
  return index >= 0 ? index : 0;
});

const canSwitchToPrevQueue = computed(() => previewIndex.value > 0);
const canSwitchToNextQueue = computed(() => previewIndex.value < queueOptions.value.length - 1);
const queueSwitcherLabel = computed(() => {
  const total = queueOptions.value.length;
  if (total === 0) return '0 / 0';
  return `${previewIndex.value + 1} / ${total}`;
});
const queueSwitcherTitle = computed(() => {
  const queue = previewQueue.value;
  if (!queue) return '播放列表';
  return previewIndex.value === 0
    ? `当前队列 · ${resolveQueueTypeLabel(queue)}`
    : queue.title || resolveQueueTypeLabel(queue);
});

const queueTrackStyle = computed(() => {
  const translateX = isDraggingSlides.value
    ? `calc(-${previewIndex.value * 100}% + ${dragOffsetX.value}px)`
    : `-${previewIndex.value * 100}%`;
  return {
    transform: `translate3d(${translateX}, 0, 0)`,
  };
});

const isPreviewReadonly = computed(
  () => !!previewQueue.value && previewQueue.value.id !== currentPlaybackQueue.value?.id,
);
const isMyQueue = computed(() => previewQueue.value?.id === playlistStore.customPlaybackQueue?.id);

const currentTrackId = computed(() => {
  if (!previewQueue.value) return null;
  if (previewQueue.value.id === currentPlaybackQueue.value?.id) return playerStore.currentTrackId;
  return previewQueue.value.currentTrackId ?? null;
});

// 缓存播放状态，避免频繁访问 store
const isPlayerPlaying = ref(playerStore.isPlaying);
let playingStateTimer = 0;
const updatePlayerPlayingState = () => {
  if (playingStateTimer) return;
  playingStateTimer = window.setTimeout(() => {
    playingStateTimer = 0;
    isPlayerPlaying.value = playerStore.isPlaying;
  }, 100);
};

const headerTitle = computed(() => (previewIndex.value === 0 ? '播放队列' : '历史队列'));
const headerSubtitle = computed(() => {
  const queue = previewQueue.value;
  if (!queue) return '暂无队列';
  if (
    queue.id === playlistStore.customPlaybackQueue?.id &&
    queue.id !== currentPlaybackQueue.value?.id
  )
    return '我的队列';
  if (queue.id === currentPlaybackQueue.value?.id) return resolveQueueTypeLabel(queue);
  return queue.title || resolveQueueTypeLabel(queue);
});
const headerMeta = computed(() => {
  if (!previewQueue.value) return '0 首';
  const count = previewQueue.value.songs.length;
  return `${count} 首`;
});
const canAddPreviewQueue = computed(
  () => userStore.isLoggedIn && !!previewQueue.value && previewQueue.value.songs.length > 0,
);
const createdPlaylists = computed(() => playlistStore.getCreatedPlaylists(userStore.info?.userid));

const resolveResumeTrack = (queue: QueueLike | null | undefined) => {
  if (!queue) return null;
  return (
    queue.songs.find((song) => String(song.id) === String(queue.currentTrackId ?? '')) ??
    queue.songs[0] ??
    null
  );
};

const setQueueListRef = (queueId: string) => (target: Element | ComponentPublicInstance | null) => {
  queueListRefs.value[queueId] = target as QueueVirtualListExposed | null;
};

const resolveQueueTypeLabel = (
  queue: { type?: string; title?: string; subtitle?: string } | null | undefined,
) => {
  if (!queue) return '播放列表';
  if (queue.type === 'fm') return queue.title || '私人 FM';
  if (queue.type === 'manual') return queue.title || '我的队列';
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
  if (!open.value) return;
  const queue = previewQueue.value;
  if (!queue || queue.songs.length < 2) return;
  await nextTick();
  if (initToken !== sortableInitToken) return;
  const listEl = queueListRefs.value[queue.id]?.getScroller() ?? null;
  if (!listEl || !listEl.isConnected) return;
  // sortable 挂载到虚拟滚动的内层偏移 div（包含实际行元素的容器）
  const el = listEl.querySelector<HTMLElement>('.queue-virtual-offset') ?? listEl;
  if (!el.isConnected) return;

  sortableInstance = new Sortable(el, {
    animation: 160,
    handle: '.queue-card',
    delay: 180,
    delayOnTouchOnly: true,
    touchStartThreshold: 8,
    fallbackTolerance: 6,
    ghostClass: 'queue-sortable-ghost',
    dragClass: 'queue-sortable-drag',
    onEnd: (evt) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
      const visibleStart = queueListRefs.value[queue.id]?.getVisibleStart() ?? 0;
      // 局部索引转全局索引
      const globalOld = oldIndex + visibleStart;
      const globalNew = newIndex + visibleStart;
      playlistStore.reorderPlaybackQueue(globalOld, globalNew, queue.id);
    },
  });
};

const scrollPreviewToTop = () => {
  const queue = previewQueue.value;
  if (!queue) return;
  queueListRefs.value[queue.id]?.scrollToTop();
};

const isCurrentVisible = (): boolean => {
  const queue = previewQueue.value;
  if (!queue) return false;
  return queueListRefs.value[queue.id]?.isCurrentVisible() ?? false;
};

const scrollToCurrent = (force = true) => {
  const queue = previewQueue.value;
  if (!queue) return;
  if (!force && isCurrentVisible()) return;
  queueListRefs.value[queue.id]?.scrollToCurrent(force);
};

const clearPageTransitionTimer = () => {
  if (pageTransitionTimer !== null) {
    window.clearTimeout(pageTransitionTimer);
    pageTransitionTimer = null;
  }
};

const schedulePageTransitionEnd = () => {
  clearPageTransitionTimer();
  pageTransitionTimer = window.setTimeout(() => {
    animatePageTransition.value = false;
    pageTransitionTimer = null;
  }, 220);
};

const flushDragOffset = () => {
  dragAnimationFrame = 0;
  dragOffsetX.value = pendingDragOffsetX.value;
};

const scheduleDragOffsetUpdate = (value: number) => {
  pendingDragOffsetX.value = value;
  if (dragAnimationFrame) return;
  dragAnimationFrame = requestAnimationFrame(flushDragOffset);
};

const clearDragAnimationFrame = () => {
  if (dragAnimationFrame) {
    cancelAnimationFrame(dragAnimationFrame);
    dragAnimationFrame = 0;
  }
};

const setPreviewQueueByIndex = (index: number, animate = true) => {
  const nextIndex = Math.max(0, Math.min(index, queueOptions.value.length - 1));
  const targetQueue = queueOptions.value[nextIndex];
  if (!targetQueue) return;
  if (targetQueue.id === previewQueueId.value) {
    if (!animate) {
      animatePageTransition.value = false;
      clearPageTransitionTimer();
    }
    return;
  }
  previewQueueId.value = targetQueue.id;
  animatePageTransition.value = animate;
  if (animate) schedulePageTransitionEnd();
  else clearPageTransitionTimer();
};

const resetSlideDrag = (animate = false) => {
  clearDragAnimationFrame();
  pendingDragOffsetX.value = 0;
  dragOffsetX.value = 0;
  dragAxis.value = 'idle';
  isDraggingSlides.value = false;
  dragPointerId.value = null;
  dragPointerType.value = null;
  if (animate) {
    animatePageTransition.value = true;
    schedulePageTransitionEnd();
  }
};

const handleSwitchQueueByDirection = (direction: -1 | 1, animate = false) => {
  if (queueOptions.value.length <= 1) return;
  setPreviewQueueByIndex(previewIndex.value + direction, animate);
};

const handleQueueNavKeydown = (event: KeyboardEvent) => {
  if (queueOptions.value.length <= 1) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  handleSwitchQueueByDirection(event.key === 'ArrowRight' ? 1 : -1, false);
};

const handlePointerDown = (event: PointerEvent) => {
  if (!canSwipeQueues.value) return;
  if (event.pointerType === 'mouse') return;
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target.closest('button, input, [role="button"]')) return;
  const el = slidesRef.value;
  if (!el) return;
  dragPointerId.value = event.pointerId;
  dragPointerType.value = event.pointerType;
  dragStartX.value = event.clientX;
  dragStartY.value = event.clientY;
  pendingDragOffsetX.value = 0;
  dragOffsetX.value = 0;
  dragAxis.value = 'idle';
  isDraggingSlides.value = false;
  animatePageTransition.value = false;
  clearPageTransitionTimer();
  el.setPointerCapture(event.pointerId);
};

const handlePointerMove = (event: PointerEvent) => {
  if (!canSwipeQueues.value) return;
  const el = slidesRef.value;
  if (!el || dragPointerId.value !== event.pointerId) return;
  if (dragPointerType.value === 'mouse') return;
  const deltaX = event.clientX - dragStartX.value;
  const deltaY = event.clientY - dragStartY.value;

  if (dragAxis.value === 'idle') {
    if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
    dragAxis.value = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
  }

  if (dragAxis.value !== 'x') {
    return;
  }

  event.preventDefault();
  isDraggingSlides.value = true;
  scheduleDragOffsetUpdate(deltaX);
};

const finishPointerInteraction = (pointerId?: number | null) => {
  if (!canSwipeQueues.value) {
    resetSlideDrag(false);
    return;
  }
  const el = slidesRef.value;
  if (pointerId !== undefined && pointerId !== null && dragPointerId.value !== pointerId) return;
  if (!el) {
    resetSlideDrag(true);
    return;
  }
  if (dragPointerId.value !== null) {
    try {
      el.releasePointerCapture(dragPointerId.value);
    } catch {
      // ignore stale pointer capture state
    }
  }
  const effectiveDragOffset = dragAnimationFrame ? pendingDragOffsetX.value : dragOffsetX.value;
  clearDragAnimationFrame();
  dragOffsetX.value = effectiveDragOffset;
  const width = el.clientWidth;
  const threshold = Math.max(56, width * 0.18);
  const direction =
    dragAxis.value === 'x' && Math.abs(effectiveDragOffset) >= threshold
      ? effectiveDragOffset < 0
        ? 1
        : -1
      : 0;

  if (direction !== 0) {
    setPreviewQueueByIndex(previewIndex.value + direction, true);
    resetSlideDrag(false);
  } else {
    resetSlideDrag(true);
  }
};

const handlePointerEnd = (event: PointerEvent) => {
  if (dragPointerId.value !== event.pointerId) return;
  finishPointerInteraction(event.pointerId);
};

const handlePointerCaptureLost = (event: PointerEvent) => {
  if (dragPointerId.value !== event.pointerId) return;
  finishPointerInteraction(event.pointerId);
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

  if (
    queue.id !== currentPlaybackQueue.value?.id ||
    String(playerStore.currentTrackId) !== targetId
  )
    return;

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

  if (queue.id === playlistStore.customPlaybackQueue?.id) {
    playlistStore.clearPlaybackQueue(queue.id);
    if (queue.id === currentPlaybackQueue.value?.id) {
      playerStore.stop();
    }
    return;
  }

  if (queue.id !== currentPlaybackQueue.value?.id) {
    playlistStore.removePlaybackQueue(queue.id);
    setPreviewQueueByIndex(0, false);
    return;
  }

  playlistStore.clearPlaybackQueue(queue.id);
  playerStore.stop();
};

const handleAddToPlaylist = async () => {
  if (!previewQueue.value?.songs.length) return;
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired('添加到歌单');
    return;
  }
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

const handleSelectPlaylist = async (listId: string | number) => {
  const queue = previewQueue.value;
  if (!queue || queue.songs.length === 0 || isAddingToPlaylist.value) return;
  const targetName =
    createdPlaylists.value.find((p) => String(p.listid ?? p.id) === String(listId))?.name ?? '歌单';
  isAddingToPlaylist.value = true;
  try {
    // 反转顺序以保持目标歌单中看到的顺序与当前队列一致
    const songsToAdd = [...queue.songs].reverse();
    const { successCount, failedCount } = await playlistStore.addSongsToPlaylist(
      listId,
      songsToAdd,
    );
    if (successCount > 0 && failedCount === 0) {
      toastStore.actionCompleted(`已添加 ${successCount} 首到『${targetName}』`);
      showPlaylistDialog.value = false;
      return;
    }
    if (successCount > 0 && failedCount > 0) {
      toastStore.warning(`已添加 ${successCount} 首到『${targetName}』，${failedCount} 首失败`);
      showPlaylistDialog.value = false;
      return;
    }
    toastStore.warning('所选歌曲已在目标歌单中');
  } catch {
    toastStore.actionFailed('添加到歌单');
  } finally {
    isAddingToPlaylist.value = false;
  }
};

const handleResumePreviewQueue = async (song?: Song | null) => {
  const queue = previewQueue.value;
  if (!queue || queue.id === currentPlaybackQueue.value?.id) return;
  const resumeTrackId = song?.id ?? queue.currentTrackId ?? queue.songs[0]?.id ?? null;
  if (!resumeTrackId) return;
  playlistStore.setActiveQueue(queue.id);
  await playerStore.playTrack(String(resumeTrackId), queue.songs, {
    autoPlay: true,
    sourceQueueId: queue.id,
  });
};

watch(
  () => open.value,
  async (isOpen) => {
    if (!isOpen) {
      sortableInitToken += 1;
      destroySortable();
      return;
    }

    previewQueueId.value = currentPlaybackQueue.value?.id ?? queueOptions.value[0]?.id ?? null;
    animatePageTransition.value = false;
    await nextTick();
    await initSortable();
    // 只在打开抽屉且是当前播放队列时滚动到当前位置
    if (previewQueue.value?.id === currentPlaybackQueue.value?.id) {
      scrollToCurrent(false);
    }
    isPlayerPlaying.value = playerStore.isPlaying;
  },
);

watch(
  () => playerStore.isPlaying,
  () => {
    updatePlayerPlayingState();
  },
);

watch(
  () => previewQueueId.value,
  async () => {
    if (!open.value) return;
    await initSortable();
    await nextTick();
    // 移除这里的 scrollToCurrent 调用，避免切换队列时自动滚动
  },
);

watch(
  () => queueOptions.value.map((queue) => queue.id).join('|'),
  async () => {
    if (queueOptions.value.length === 0) {
      previewQueueId.value = null;
      sortableInitToken += 1;
      destroySortable();
      return;
    }
    if (!previewQueue.value) {
      previewQueueId.value = queueOptions.value[0]?.id ?? null;
    }
    if (open.value) {
      await nextTick();
      await initSortable();
    }
  },
);

watch(
  () => queueOptions.value.map((queue) => `${queue.id}:${queue.songs.length}`).join('|'),
  async () => {
    if (open.value) {
      await initSortable();
    }
  },
);

onMounted(() => {
  canSwipeQueues.value =
    window.matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (open.value) {
    previewQueueId.value = currentPlaybackQueue.value?.id ?? queueOptions.value[0]?.id ?? null;
    void nextTick(async () => {
      await initSortable();
    });
  }
});

onBeforeUnmount(() => {
  sortableInitToken += 1;
  destroySortable();
  if (playingStateTimer) clearTimeout(playingStateTimer);
  clearPageTransitionTimer();
  clearDragAnimationFrame();
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
      <div class="queue-title-block">
        <div class="queue-title-row">
          <div class="queue-title">{{ headerTitle }}</div>
          <div v-if="headerSubtitle" class="queue-title-subtitle">
            {{ headerSubtitle }}
          </div>
        </div>
        <div class="queue-title-meta">{{ headerMeta }}</div>
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
          :title="
            isMyQueue
              ? '清空我的队列'
              : previewQueue?.id === currentPlaybackQueue?.id
                ? '清空当前队列'
                : '删除历史队列'
          "
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

      <div class="queue-toolbar">
        <div
          class="queue-switcher"
          role="group"
          aria-label="队列切换"
          tabindex="0"
          @keydown="handleQueueNavKeydown"
        >
          <button
            type="button"
            class="queue-switcher-btn"
            :disabled="!canSwitchToPrevQueue"
            title="上一队列"
            @click="handleSwitchQueueByDirection(-1)"
          >
            <Icon :icon="iconChevronLeft" width="14" height="14" />
          </button>
          <div class="queue-switcher-label" :title="queueSwitcherTitle" aria-live="polite">
            {{ queueSwitcherLabel }}
          </div>
          <button
            type="button"
            class="queue-switcher-btn"
            :disabled="!canSwitchToNextQueue"
            title="下一队列"
            @click="handleSwitchQueueByDirection(1)"
          >
            <Icon :icon="iconChevronRight" width="14" height="14" />
          </button>
        </div>

        <div class="queue-actions-primary">
          <Button
            type="button"
            class="queue-add-btn"
            variant="secondary"
            size="xs"
            :disabled="!canAddPreviewQueue || isAddingToPlaylist"
            @click="handleAddToPlaylist"
          >
            <Icon :icon="iconPlus" width="14" height="14" />
            <span>添加到</span>
          </Button>
        </div>
      </div>
    </div>

    <div v-if="queueOptions.length === 0" class="queue-drawer-empty-state">
      <div class="queue-empty">
        <div class="queue-empty-icon">
          <Icon :icon="iconPause" width="36" height="36" />
        </div>
        <div>当前暂无队列</div>
      </div>
    </div>
    <div
      v-else
      ref="slidesRef"
      class="queue-slides"
      :class="{ 'is-dragging': isDraggingSlides }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerEnd"
      @pointercancel="handlePointerEnd"
      @lostpointercapture="handlePointerCaptureLost"
    >
      <div
        class="queue-track"
        :class="{ 'is-animated': animatePageTransition && !isDraggingSlides }"
        :style="queueTrackStyle"
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
          </div>
          <PlayerQueueVirtualList
            :ref="setQueueListRef(queue.id)"
            :queue="queue"
            :itemHeight="itemHeight"
            :currentTrackId="currentTrackId"
            :isPreviewQueue="queue.id === previewQueue?.id"
            :isCurrentPlaybackQueue="queue.id === currentPlaybackQueue?.id"
            :isPlayerPlaying="isPlayerPlaying"
            :readonly="queue.id !== currentPlaybackQueue?.id"
            @play="handlePlay"
            @remove="handleRemove"
          />
        </section>
      </div>
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
        :disabled="isAddingToPlaylist"
        @click="handleSelectPlaylist(entry.listid ?? entry.id)"
      >
        <span class="batch-playlist-name">{{ entry.name }}</span>
        <span class="batch-playlist-count">{{ entry.count ?? 0 }} 首</span>
      </Button>
    </div>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.queue-drawer-overlay) {
  background: rgba(0, 0, 0, 0.16);
}

:global(.queue-drawer) {
  padding: 0;
  box-shadow: none;
  bottom: 0;
}

.queue-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'title actions'
    'toolbar toolbar';
  align-items: center;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--color-border-light);
}

.queue-title-block {
  grid-area: title;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.queue-toolbar {
  grid-area: toolbar;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding-top: 2px;
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
  max-width: 100%;
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
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.86;
  white-space: nowrap;
  line-height: 1;
}

.queue-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  white-space: nowrap;
  min-height: 28px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.queue-actions-primary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.queue-switcher {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}

.queue-switcher-btn {
  height: 24px;
  border-radius: 999px;
  font-size: 11px;
  transition:
    color 0.18s ease,
    background-color 0.18s ease;
}

.queue-switcher-btn {
  width: 24px;
  min-width: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.queue-switcher-btn:hover:not(:disabled),
.queue-switcher-btn:focus-visible {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.queue-switcher-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.queue-switcher-label {
  min-width: 54px;
  max-width: 140px;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.02em;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  justify-self: end;
}

.queue-icon-btn {
  width: 38px;
  height: 38px;
  min-width: 38px;
  border-radius: 12px;
  color: var(--color-text-secondary);
}

@media (max-width: 760px) {
  .queue-header {
    gap: 10px;
  }

  .queue-title-row {
    gap: 6px;
  }

  .queue-toolbar {
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .queue-switcher {
    order: 1;
    flex: 1 1 160px;
  }

  .queue-actions-primary {
    order: 2;
    flex: 0 0 auto;
  }

  .queue-actions {
    gap: 2px;
  }

  .queue-icon-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
  }

  .queue-title-subtitle {
    max-width: 140px;
  }
}

.batch-playlist-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.batch-playlist-status {
  padding: 18px 0;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
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

.batch-playlist-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.queue-slides {
  flex: 1;
  position: relative;
  overflow: hidden;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  will-change: transform;
}

.queue-slides.is-dragging {
  touch-action: none;
}

.queue-track {
  display: flex;
  width: 100%;
  height: 100%;
  will-change: transform;
}

.queue-track.is-animated {
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.queue-slide {
  flex: 0 0 100%;
  min-width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.queue-drawer-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
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

.queue-list {
  flex: 1;
  min-height: 0;
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
  contain: layout style paint;
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

.queue-play:hover {
  background: transparent !important;
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
  cursor: grab;
}

.queue-card:active {
  cursor: grabbing;
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
