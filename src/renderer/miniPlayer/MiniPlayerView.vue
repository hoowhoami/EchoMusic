<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Cover from '@/components/ui/Cover.vue';
import MiniLyricPanel from './MiniLyricPanel.vue';
import { useVirtualList } from '@/composables/useVirtualList';
import {
  iconHeart,
  iconHeartFilled,
  iconMusic,
  iconPause,
  iconPinned,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconList,
  iconSquare,
  iconTypography,
  iconVolume1,
  iconVolume2,
  iconVolume3,
  iconX,
} from '@/icons';
import type {
  MiniPlayerAppearancePayload,
  MiniPlayerCommand,
  MiniPlayerExpandDirection,
  MiniPlayerLyricPayload,
  MiniPlayerPlaybackPayload,
  MiniPlayerQueuePayload,
  MiniPlayerQueueTrack,
  MiniPlayerSnapshot,
} from '../../shared/mini-player';
import { MINI_PLAYER_DIMENSIONS } from '../../shared/mini-player';

// 卡片折叠/展开高度，源自共享尺寸常量，保证与主进程窗口尺寸一致、不漂移
const cardCollapsedHeight = `${MINI_PLAYER_DIMENSIONS.controlsHeight}px`;
const cardExpandedHeight = `${
  MINI_PLAYER_DIMENSIONS.expandedHeight - MINI_PLAYER_DIMENSIONS.shellPadding * 2
}px`;
const COLLAPSE_ANCHOR_HOLD_MS = 320;
const isMac = navigator.platform.toLowerCase().includes('mac');

const playback = ref<MiniPlayerPlaybackPayload | null>(null);
const appearance = ref<MiniPlayerAppearancePayload | null>(null);
const queue = ref<MiniPlayerQueuePayload | null>(null);
const lyric = ref<MiniPlayerLyricPayload | null>(null);
const lyricCoverUrl = ref('');
const expandedMode = ref<'queue' | 'lyric' | null>(null);
const alwaysOnTop = ref(false);
const expandDirection = ref<MiniPlayerExpandDirection>('down');
const shellDirectionHold = ref<MiniPlayerExpandDirection | null>(null);
const isPreparingExpand = ref(false);
const preparingExpandedMode = ref<'queue' | 'lyric' | null>(null);
const isHovered = ref(false);
const isDraggingSeek = ref(false);
const pendingSeekRatio = ref<number | null>(null);
const isVolumeOpen = ref(false);
const isDraggingVolume = ref(false);
let volumeCloseTimer: ReturnType<typeof setTimeout> | null = null;
let shellDirectionHoldTimer: ReturnType<typeof setTimeout> | null = null;
let disposeSnapshot: (() => void) | null = null;
let lastAppliedLyricTrackId: string | null = null;
let lastAppliedLyricIndex = -1;
let lastAppliedLyricTime = 0;

const isQueueOpen = computed(() => expandedMode.value === 'queue');
const isLyricOpen = computed(() => expandedMode.value === 'lyric');
const isExpanded = computed(() => expandedMode.value !== null);
const activeShellDirection = computed(() => {
  if (shellDirectionHold.value) return shellDirectionHold.value;
  if (isExpanded.value) return expandDirection.value;
  return 'down';
});

const volumePercent = computed(() =>
  Math.round(Math.min(1, Math.max(0, playback.value?.volume ?? 0)) * 100),
);

const progressPercent = computed(() => {
  const duration = playback.value?.duration ?? 0;
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, ((playback.value?.currentTime ?? 0) / duration) * 100));
});

// 拖动 seek 时优先显示拖动位置，避免 120ms 回传造成的跳动
const displayPercent = computed(() => {
  if (isDraggingSeek.value && pendingSeekRatio.value !== null) {
    return Math.min(100, Math.max(0, pendingSeekRatio.value * 100));
  }
  return progressPercent.value;
});

const volumeIcon = computed(() => {
  const value = playback.value?.volume ?? 0;
  if (value <= 0) return iconVolume3;
  if (value <= 0.5) return iconVolume1;
  return iconVolume2;
});

const currentQueueTrackId = computed(
  () => queue.value?.currentTrackId ?? playback.value?.trackId ?? null,
);

const lyricTitle = computed(() => playback.value?.title || '未在播放');
const lyricArtist = computed(() => playback.value?.artist || 'EchoMusic');

// 播放列表虚拟滚动：复用主窗口同款 useVirtualList，仅渲染可视区，支撑大队列
const MINI_QUEUE_ITEM_HEIGHT = 42;
const queueTracks = computed(() => queue.value?.tracks ?? []);
const queueScrollerRef = ref<HTMLElement | null>(null);
const { containerRef, visibleStart, visibleEnd, offset, totalSize, refresh, scrollToIndex } =
  useVirtualList({
    itemCount: computed(() => queueTracks.value.length),
    itemSize: MINI_QUEUE_ITEM_HEIGHT,
    overscan: 6,
    scrollContainer: queueScrollerRef,
    active: isQueueOpen,
  });

const visibleQueueTracks = computed(() => {
  const start = visibleStart.value;
  const end = visibleEnd.value;
  if (start >= end) return [] as Array<{ track: MiniPlayerQueueTrack; index: number }>;
  return queueTracks.value.slice(start, end).map((track, i) => ({ track, index: start + i }));
});

const queueWrapperStyle = computed(() => ({
  height: `${totalSize.value}px`,
  position: 'relative' as const,
}));
const queueOffsetStyle = computed(() => ({ transform: `translateY(${offset.value}px)` }));

// 打开队列时定位到正在播放的歌曲（若已在可视范围内则不滚动）
const scrollQueueToCurrent = () => {
  const id = currentQueueTrackId.value;
  if (!id) return;
  const index = queueTracks.value.findIndex((t) => t.trackId === id);
  if (index < 0) return;
  const scroller = queueScrollerRef.value;
  if (scroller) {
    const itemTop = index * MINI_QUEUE_ITEM_HEIGHT;
    const itemBottom = itemTop + MINI_QUEUE_ITEM_HEIGHT;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    // 当前曲整行已在可视区内（留 8px 余量）则不滚动
    if (itemTop >= viewTop + 8 && itemBottom <= viewBottom - 8) return;
  }
  scrollToIndex(index);
};

// 队列内容变化时（展开中）刷新虚拟列表范围
watch(
  () => queueTracks.value.length,
  () => {
    if (isQueueOpen.value) void nextTick(() => refresh(true));
  },
);

const command = (value: MiniPlayerCommand) => {
  window.electron?.miniPlayer?.command(value);
};

// 收藏：本地乐观切换，避免等待 ~120ms 防抖 + IPC 回传造成爱心状态延迟
const toggleFavorite = () => {
  if (!playback.value) return;
  playback.value.isFavorite = !playback.value.isFavorite;
  command('toggleFavorite');
};

const mergeLyricSnapshot = (
  nextLyric: MiniPlayerLyricPayload | null | undefined,
): MiniPlayerLyricPayload | null => {
  if (!nextLyric) return lyric.value;
  const currentLyric = lyric.value;
  const shouldKeepCurrentLines =
    nextLyric.lines.length === 0 &&
    (currentLyric?.lines.length ?? 0) > 0 &&
    Boolean(nextLyric.trackId) &&
    nextLyric.trackId === currentLyric?.trackId;

  if (!shouldKeepCurrentLines || !currentLyric) return nextLyric;

  return {
    ...currentLyric,
    ...nextLyric,
    lines: currentLyric.lines,
    hasTranslation: currentLyric.hasTranslation,
    hasRomanization: currentLyric.hasRomanization,
    tips: currentLyric.tips,
  };
};

const lyricLineContentKey = (line: MiniPlayerLyricPayload['lines'][number] | undefined) =>
  [line?.time ?? '', line?.text ?? '', line?.translated ?? '', line?.romanized ?? ''].join(
    '\u0001',
  );

const shouldApplyLyricSnapshot = (
  nextLyric: MiniPlayerLyricPayload | null | undefined,
  currentLyric: MiniPlayerLyricPayload | null,
) => {
  if (!nextLyric) return false;
  if (!currentLyric) return true;
  const isTransientEmptySameTrack =
    nextLyric.lines.length === 0 &&
    currentLyric.lines.length > 0 &&
    Boolean(nextLyric.trackId) &&
    nextLyric.trackId === currentLyric.trackId;
  if (nextLyric.trackId !== currentLyric.trackId) return true;
  if (nextLyric.currentIndex !== currentLyric.currentIndex) return true;
  if (nextLyric.desktopLyricEnabled !== currentLyric.desktopLyricEnabled) return true;
  if (isTransientEmptySameTrack) return false;
  if (nextLyric.wantTranslation !== currentLyric.wantTranslation) return true;
  if (nextLyric.wantRomanization !== currentLyric.wantRomanization) return true;
  if (nextLyric.hasTranslation !== currentLyric.hasTranslation) return true;
  if (nextLyric.hasRomanization !== currentLyric.hasRomanization) return true;
  if (nextLyric.isLoading !== currentLyric.isLoading) return true;
  if (nextLyric.tips !== currentLyric.tips) return true;
  if (nextLyric.lines.length !== currentLyric.lines.length) return true;

  return nextLyric.lines.some(
    (line, index) => lyricLineContentKey(line) !== lyricLineContentKey(currentLyric.lines[index]),
  );
};

const stabilizeIncomingLyricSnapshot = (
  nextLyric: MiniPlayerLyricPayload | null | undefined,
  nextPlayback: MiniPlayerPlaybackPayload | null,
) => {
  if (!nextLyric) return nextLyric;
  const trackId = nextLyric.trackId;
  const time = Number(nextPlayback?.currentTime ?? playback.value?.currentTime ?? 0);

  if (trackId !== lastAppliedLyricTrackId) {
    lastAppliedLyricTrackId = trackId;
    lastAppliedLyricIndex = nextLyric.currentIndex;
    lastAppliedLyricTime = time;
    return nextLyric;
  }

  const isPlaybackJitterBackwards =
    Boolean(trackId) &&
    Boolean(nextPlayback?.isPlaying ?? playback.value?.isPlaying) &&
    nextLyric.currentIndex < lastAppliedLyricIndex &&
    lastAppliedLyricIndex - nextLyric.currentIndex <= 2 &&
    time >= lastAppliedLyricTime - 0.35;

  const currentIndex = isPlaybackJitterBackwards ? lastAppliedLyricIndex : nextLyric.currentIndex;

  lastAppliedLyricIndex = currentIndex;
  lastAppliedLyricTime = time;

  if (currentIndex === nextLyric.currentIndex) return nextLyric;
  return { ...nextLyric, currentIndex };
};

const applySnapshot = (snapshot: MiniPlayerSnapshot | null | undefined) => {
  const nextPlayback = snapshot?.playback ?? null;
  const nextLyric = stabilizeIncomingLyricSnapshot(snapshot?.lyric, nextPlayback);
  const nextCoverUrl = nextPlayback?.coverUrl ?? '';
  if (nextCoverUrl !== lyricCoverUrl.value) lyricCoverUrl.value = nextCoverUrl;
  if (!nextPlayback) {
    playback.value = null;
  } else if (!playback.value || playback.value.trackId !== nextPlayback.trackId) {
    playback.value = nextPlayback;
  } else {
    Object.assign(playback.value, nextPlayback);
  }
  appearance.value = snapshot?.appearance ?? appearance.value;
  if (snapshot?.window) {
    alwaysOnTop.value = snapshot.window.alwaysOnTop;
    expandDirection.value = snapshot.window.expandDirection;
  }
  queue.value = snapshot?.queue ?? null;
  if (shouldApplyLyricSnapshot(nextLyric, lyric.value)) {
    lyric.value = mergeLyricSnapshot(nextLyric);
  }
  if (appearance.value) {
    document.documentElement.classList.toggle('dark', appearance.value.isDark);
    // mini 模式使用固定主题色，不跟随主窗口的封面取色/自定义色
    document.documentElement.style.setProperty('--color-primary', '#0071e3');
    document.documentElement.style.fontFamily = appearance.value.fontFamily || '';
  }
};

// 用 JS pointer 事件驱动 hover 态：CSS :hover 在 Electron 拖拽区(drag)与 no-drag 边界来回
// 切换时会反复失/得焦造成闪烁，pointerenter/leave 以整窗为单位则稳定无抖动。
const handlePointerEnter = () => {
  isHovered.value = true;
};

const handlePointerLeave = () => {
  isHovered.value = false;
};

// 自定义窗口拖动：用屏幕坐标增量驱动，替代 -webkit-app-region: drag（后者会吞掉拖拽区
// pointer 事件导致 hover 闪烁）。在卡片空白处按下即可拖动；按钮/进度条/音量等交互元素不触发。
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartWinX = 0;
let dragStartWinY = 0;
let isDraggingWindow = false;

const handleDragPointerDown = async (event: PointerEvent) => {
  // 只响应鼠标左键；交互元素（带 .no-drag）不触发拖动
  if (event.button !== 0) return;
  if ((event.target as HTMLElement)?.closest('.no-drag')) return;
  // currentTarget 在 await 之后会被置空，需在同步阶段先取出元素与坐标
  const el = event.currentTarget as HTMLElement;
  const pointerId = event.pointerId;
  const startScreenX = event.screenX;
  const startScreenY = event.screenY;
  const bounds = await window.electron?.miniPlayer?.getBounds?.();
  if (!bounds) return;
  dragStartScreenX = startScreenX;
  dragStartScreenY = startScreenY;
  dragStartWinX = bounds.x;
  dragStartWinY = bounds.y;
  isDraggingWindow = true;
  el.setPointerCapture(pointerId);
};

const handleDragPointerMove = (event: PointerEvent) => {
  if (!isDraggingWindow) return;
  const nextX = dragStartWinX + (event.screenX - dragStartScreenX);
  const nextY = dragStartWinY + (event.screenY - dragStartScreenY);
  window.electron?.miniPlayer?.move(nextX, nextY);
};

const handleDragPointerUp = (event: PointerEvent) => {
  if (!isDraggingWindow) return;
  isDraggingWindow = false;
  const el = event.currentTarget as HTMLElement;
  if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
};

// 音量：点击图标=静音切换；悬停展开竖向滑块，可拖动或滚轮微调。
const clearVolumeCloseTimer = () => {
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer);
    volumeCloseTimer = null;
  }
};

const clearShellDirectionHoldTimer = () => {
  if (shellDirectionHoldTimer) {
    clearTimeout(shellDirectionHoldTimer);
    shellDirectionHoldTimer = null;
  }
};

const holdShellDirection = (direction = expandDirection.value) => {
  clearShellDirectionHoldTimer();
  shellDirectionHold.value = direction;
};

const releaseShellDirectionHoldSoon = () => {
  clearShellDirectionHoldTimer();
  shellDirectionHoldTimer = setTimeout(() => {
    shellDirectionHoldTimer = null;
    shellDirectionHold.value = null;
  }, COLLAPSE_ANCHOR_HOLD_MS);
};

const openVolume = () => {
  clearVolumeCloseTimer();
  isVolumeOpen.value = true;
};

const scheduleVolumeClose = (delay: number | Event = 260) => {
  if (isDraggingVolume.value) return;
  const closeDelay = typeof delay === 'number' ? delay : 260;
  clearVolumeCloseTimer();
  volumeCloseTimer = setTimeout(() => {
    volumeCloseTimer = null;
    closeVolume();
  }, closeDelay);
};

const closeVolume = (immediate = false) => {
  clearVolumeCloseTimer();
  if (!isVolumeOpen.value && !immediate) return;
  isVolumeOpen.value = false;
};

const setVolume = (value: number) => {
  const nextVolume = Math.min(1, Math.max(0, value));
  if (playback.value) playback.value.volume = nextVolume;
  command({ type: 'setVolume', value: nextVolume });
};

const setVolumeFromEvent = (event: PointerEvent, sliderEl: HTMLElement) => {
  // 横向轨道保持在 mini 窗口内部，不触发 BrowserWindow 尺寸变化。
  const track = sliderEl.querySelector('.mini-volume-track') as HTMLElement | null;
  const rect = (track ?? sliderEl).getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  setVolume(ratio);
};

const handleVolumePointerDown = (event: PointerEvent) => {
  if (!playback.value) return;
  clearVolumeCloseTimer();
  openVolume();
  const el = event.currentTarget as HTMLElement;
  isDraggingVolume.value = true;
  el.setPointerCapture(event.pointerId);
  setVolumeFromEvent(event, el);
};

const handleVolumePointerMove = (event: PointerEvent) => {
  if (!isDraggingVolume.value) return;
  setVolumeFromEvent(event, event.currentTarget as HTMLElement);
};

const handleVolumePointerUp = (event: PointerEvent) => {
  if (!isDraggingVolume.value) return;
  const el = event.currentTarget as HTMLElement;
  if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  isDraggingVolume.value = false;
  scheduleVolumeClose(900);
};

const handleVolumeWheel = (event: WheelEvent) => {
  if (!playback.value) return;
  clearVolumeCloseTimer();
  openVolume();
  const normalized = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 120);
  const step = (normalized / 120) * 0.05;
  const direction = isMac ? 1 : -1;
  setVolume((playback.value.volume ?? 0) + step * direction);
  scheduleVolumeClose(1200);
};

const ratioFromEvent = (event: PointerEvent, el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
};

const handleSeekPointerDown = (event: PointerEvent) => {
  if (!playback.value) return;
  const el = event.currentTarget as HTMLElement;
  isDraggingSeek.value = true;
  pendingSeekRatio.value = ratioFromEvent(event, el);
  el.setPointerCapture(event.pointerId);
};

const handleSeekPointerMove = (event: PointerEvent) => {
  if (!isDraggingSeek.value) return;
  pendingSeekRatio.value = ratioFromEvent(event, event.currentTarget as HTMLElement);
};

const handleSeekPointerUp = (event: PointerEvent) => {
  if (!isDraggingSeek.value) return;
  const el = event.currentTarget as HTMLElement;
  const ratio = ratioFromEvent(event, el);
  isDraggingSeek.value = false;
  pendingSeekRatio.value = null;
  if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  const duration = playback.value?.duration ?? 0;
  if (duration > 0) {
    // 乐观更新本地进度，避免等待 ~120ms 回传时进度条回跳
    if (playback.value) playback.value.currentTime = ratio * duration;
    command({ type: 'seek', value: ratio * duration });
  }
};

let expandFrameTimer: ReturnType<typeof setTimeout> | null = null;
let expandRequestSeq = 0;

const cancelExpandFrame = () => {
  if (expandFrameTimer) {
    clearTimeout(expandFrameTimer);
    expandFrameTimer = null;
  }
};

const setQueueOpen = (open: boolean) => {
  if (open) {
    setExpandedMode('queue');
    return;
  }
  if (isQueueOpen.value) setExpandedMode(null);
};

const setExpandedMode = (mode: 'queue' | 'lyric' | null) => {
  if (expandedMode.value === mode && !expandFrameTimer) return;
  expandRequestSeq += 1;
  const requestSeq = expandRequestSeq;
  cancelExpandFrame();
  if (mode && isVolumeOpen.value) closeVolume(true);
  if (mode) {
    clearShellDirectionHoldTimer();
    shellDirectionHold.value = null;
    if (expandedMode.value) {
      expandedMode.value = mode;
      if (mode === 'queue') void nextTick(() => refresh(true));
      return;
    }
    // 展开：先锁定方向并让主进程扩窗，再触发卡片高度过渡。
    // 向上展开时控制条会先贴在扩窗后的底部，列表再从它上方长出，避免锚点跳动。
    const openPanel = async (snapshot?: MiniPlayerSnapshot) => {
      if (requestSeq !== expandRequestSeq) return;
      if (snapshot) applySnapshot(snapshot);
      const direction = expandDirection.value;
      const shouldPrepaintCard = direction === 'up';
      holdShellDirection(direction);
      isPreparingExpand.value = shouldPrepaintCard;
      preparingExpandedMode.value = shouldPrepaintCard ? mode : null;
      if (shouldPrepaintCard) {
        await nextTick();
        if (requestSeq !== expandRequestSeq) return;
        const card = document.querySelector('.mini-card') as HTMLElement | null;
        if (card) void card.offsetHeight;
      }
      const finishOpen = (boundsSnapshot?: MiniPlayerSnapshot) => {
        if (requestSeq !== expandRequestSeq) return;
        if (boundsSnapshot) applySnapshot(boundsSnapshot);
        expandFrameTimer = setTimeout(
          () => {
            expandFrameTimer = null;
            if (requestSeq !== expandRequestSeq) return;
            expandedMode.value = mode;
            isPreparingExpand.value = false;
            preparingExpandedMode.value = null;
            shellDirectionHold.value = null;
            if (mode === 'queue') {
              void nextTick(() => {
                refresh(true);
                window.setTimeout(scrollQueueToCurrent, 260);
              });
            }
          },
          shouldPrepaintCard ? 16 : 32,
        );
      };
      try {
        finishOpen(await window.electron?.miniPlayer?.applyExpandBounds?.());
      } catch {
        finishOpen();
      }
    };
    const expandSnapshot = window.electron?.miniPlayer?.setExpanded(true);
    if (expandSnapshot) {
      void expandSnapshot.then((snapshot) => openPanel(snapshot)).catch(() => openPanel());
      return;
    }
    void openPanel();
    return;
  }
  // 收起
  const collapsingDirection = activeShellDirection.value;
  holdShellDirection(collapsingDirection);
  isPreparingExpand.value = false;
  preparingExpandedMode.value = null;
  if (collapsingDirection === 'up') {
    const finishCollapse = (snapshot?: MiniPlayerSnapshot) => {
      if (requestSeq !== expandRequestSeq) return;
      if (snapshot) applySnapshot(snapshot);
      expandedMode.value = null;
      releaseShellDirectionHoldSoon();
    };
    const collapseSnapshot = window.electron?.miniPlayer?.setExpanded(false);
    if (collapseSnapshot) {
      void collapseSnapshot.then(finishCollapse).catch(() => finishCollapse());
      return;
    }
    finishCollapse();
    return;
  }

  expandedMode.value = null;
  const collapseSnapshot = window.electron?.miniPlayer?.setExpanded(false);
  if (collapseSnapshot) {
    void collapseSnapshot.then(applySnapshot).catch(() => {
      // ignore
    });
  }
  releaseShellDirectionHoldSoon();
};

const toggleAlwaysOnTop = async () => {
  const nextAlwaysOnTop = !alwaysOnTop.value;
  alwaysOnTop.value = nextAlwaysOnTop;
  try {
    const nextSnapshot = await window.electron?.miniPlayer?.setAlwaysOnTop(nextAlwaysOnTop);
    if (nextSnapshot) applySnapshot(nextSnapshot);
  } catch {
    alwaysOnTop.value = !nextAlwaysOnTop;
  }
};

const toggleQueue = () => setQueueOpen(!isQueueOpen.value);
const toggleLyricPanel = () => {
  if (!playback.value) return;
  setExpandedMode(isLyricOpen.value ? null : 'lyric');
};

const playQueueTrack = (trackId: string) => {
  command({ type: 'playQueueTrack', trackId });
};

// 窗口被隐藏（关闭 mini / 回主窗口）时，主进程已折叠窗口，这里同步收起队列状态
// 窗口重新可见时重新获取最新 snapshot 确保主题/状态同步
const handleVisibility = async () => {
  if (document.visibilityState === 'hidden') {
    expandRequestSeq += 1;
    cancelExpandFrame();
    isPreparingExpand.value = false;
    preparingExpandedMode.value = null;
    if (isExpanded.value) expandedMode.value = null;
    shellDirectionHold.value = null;
    clearShellDirectionHoldTimer();
    closeVolume(true);
  } else if (document.visibilityState === 'visible') {
    try {
      applySnapshot(await window.electron?.miniPlayer?.getSnapshot?.());
    } catch {
      // ignore
    }
  }
};

const requestShowMain = () => {
  expandRequestSeq += 1;
  cancelExpandFrame();
  isPreparingExpand.value = false;
  preparingExpandedMode.value = null;
  expandedMode.value = null;
  shellDirectionHold.value = null;
  clearShellDirectionHoldTimer();
  closeVolume(true);
  command('showMainWindow');
};

const requestClose = () => {
  expandRequestSeq += 1;
  cancelExpandFrame();
  isPreparingExpand.value = false;
  preparingExpandedMode.value = null;
  expandedMode.value = null;
  shellDirectionHold.value = null;
  clearShellDirectionHoldTimer();
  closeVolume(true);
  command('closeMiniPlayer');
};

// 通知主渲染进程歌词面板可见状态，用于动态调整同步频率
watch(isLyricOpen, (visible) => {
  window.electron?.miniPlayer?.notifyLyricVisibility?.(visible);
});

onMounted(async () => {
  document.documentElement.classList.add('mini-player-window');
  try {
    applySnapshot(await window.electron?.miniPlayer?.getSnapshot?.());
  } catch {
    applySnapshot(null);
  }
  disposeSnapshot = window.electron?.miniPlayer?.onSnapshot(applySnapshot) ?? null;
  document.addEventListener('visibilitychange', handleVisibility);
});

onUnmounted(() => {
  document.documentElement.classList.remove('mini-player-window');
  document.documentElement.classList.remove('dark');
  document.removeEventListener('visibilitychange', handleVisibility);
  expandRequestSeq += 1;
  cancelExpandFrame();
  isPreparingExpand.value = false;
  preparingExpandedMode.value = null;
  clearVolumeCloseTimer();
  clearShellDirectionHoldTimer();
  closeVolume(true);
  if (isExpanded.value) void window.electron?.miniPlayer?.setExpanded(false);
  disposeSnapshot?.();
  disposeSnapshot = null;
});
</script>

<template>
  <main
    class="mini-shell"
    :class="{
      'is-expanded': isExpanded,
      'is-queue-open': isQueueOpen,
      'is-lyric-open': isLyricOpen,
      'is-hovered': isHovered,
      'is-volume-open': isVolumeOpen,
      'is-preparing-expand': isPreparingExpand,
      'expand-up': activeShellDirection === 'up',
      'expand-down': activeShellDirection === 'down',
      'is-always-on-top': alwaysOnTop,
    }"
    @pointerenter="handlePointerEnter"
    @pointerleave="handlePointerLeave"
  >
    <section
      class="mini-card"
      @pointerdown="handleDragPointerDown"
      @pointermove="handleDragPointerMove"
      @pointerup="handleDragPointerUp"
      @pointercancel="handleDragPointerUp"
    >
      <div class="mini-controls">
        <div class="mini-left-actions">
          <button
            type="button"
            class="mini-window-btn no-drag"
            title="关闭 mini 播放器"
            @click="requestClose"
          >
            <Icon :icon="iconX" width="15" height="15" />
          </button>
          <button
            type="button"
            class="mini-window-btn no-drag"
            title="回到主窗口"
            @click="requestShowMain"
          >
            <Icon :icon="iconSquare" width="12" height="12" />
          </button>
        </div>

        <button
          type="button"
          class="mini-window-btn mini-pin-btn no-drag"
          :class="{ active: alwaysOnTop }"
          :title="alwaysOnTop ? '取消置顶' : '窗口置顶'"
          @click="toggleAlwaysOnTop"
        >
          <Icon :icon="iconPinned" width="13" height="13" />
        </button>

        <button
          type="button"
          class="mini-cover mini-cover-btn no-drag"
          :class="{ active: isLyricOpen }"
          :disabled="!playback"
          title="显示歌词"
          @click.stop="toggleLyricPanel"
        >
          <Cover
            v-if="playback"
            :url="playback.coverUrl"
            :size="160"
            width="44px"
            height="44px"
            :borderRadius="6"
          />
          <div v-else class="mini-cover-placeholder">
            <Icon :icon="iconMusic" width="22" height="22" />
          </div>
        </button>

        <div class="mini-center">
          <div class="mini-info">
            <div class="mini-title">{{ playback?.title || '未在播放' }}</div>
            <div class="mini-artist">{{ playback?.artist || 'EchoMusic' }}</div>
          </div>
          <div class="mini-hover-controls">
            <button
              type="button"
              class="mini-center-btn no-drag"
              :disabled="!playback"
              title="上一首"
              @click="command('previousTrack')"
            >
              <Icon :icon="iconSkipBack" width="17" height="17" />
            </button>
            <button
              type="button"
              class="mini-center-btn mini-center-play no-drag"
              :class="{ playing: playback?.isPlaying }"
              :disabled="!playback"
              :title="playback?.isPlaying ? '暂停' : '播放'"
              @click="command('togglePlayback')"
            >
              <Icon
                :icon="playback?.isPlaying ? iconPause : iconPlay"
                :width="playback?.isPlaying ? 18 : 16"
                :height="playback?.isPlaying ? 18 : 16"
                :class="{ 'play-offset': !playback?.isPlaying }"
              />
            </button>
            <button
              type="button"
              :disabled="!playback"
              class="mini-center-btn no-drag"
              title="下一首"
              @click="command('nextTrack')"
            >
              <Icon :icon="iconSkipForward" width="17" height="17" />
            </button>
          </div>
        </div>

        <div class="mini-right-actions">
          <button
            type="button"
            class="mini-action-btn mini-fav-btn no-drag"
            :disabled="!playback"
            title="收藏当前歌曲"
            @click="toggleFavorite"
          >
            <Icon
              :icon="playback?.isFavorite ? iconHeartFilled : iconHeart"
              width="19"
              height="19"
            />
          </button>
          <button
            type="button"
            class="mini-action-btn no-drag"
            :class="{ active: isQueueOpen }"
            title="播放队列"
            @click="toggleQueue"
          >
            <Icon :icon="iconList" width="18" height="18" />
          </button>
          <button
            type="button"
            class="mini-action-btn no-drag"
            :class="{ active: lyric?.desktopLyricEnabled }"
            :title="lyric?.desktopLyricEnabled ? '关闭桌面歌词' : '开启桌面歌词'"
            @click="command('toggleDesktopLyric')"
          >
            <Icon :icon="iconTypography" width="19" height="19" />
          </button>
          <div
            class="mini-volume no-drag"
            :class="{ open: isVolumeOpen }"
            @pointerenter="openVolume"
            @pointerleave="scheduleVolumeClose"
            @wheel.prevent="handleVolumeWheel"
          >
            <button
              type="button"
              class="mini-action-btn no-drag"
              :class="{ active: (playback?.volume ?? 0) <= 0 }"
              :disabled="!playback"
              :title="(playback?.volume ?? 0) <= 0 ? '取消静音' : '静音'"
              @click="command('toggleMute')"
            >
              <Icon :icon="volumeIcon" width="19" height="19" />
            </button>
            <div
              class="mini-volume-slider no-drag"
              @pointerdown="handleVolumePointerDown"
              @pointermove="handleVolumePointerMove"
              @pointerup="handleVolumePointerUp"
              @pointercancel="handleVolumePointerUp"
            >
              <div class="mini-volume-track">
                <div class="mini-volume-value" :style="{ width: `${volumePercent}%` }"></div>
                <div class="mini-volume-thumb" :style="{ left: `${volumePercent}%` }"></div>
              </div>
              <span class="mini-volume-label">{{ volumePercent }}</span>
            </div>
          </div>
        </div>

        <div
          class="mini-progress no-drag"
          @pointerdown="handleSeekPointerDown"
          @pointermove="handleSeekPointerMove"
          @pointerup="handleSeekPointerUp"
          @pointercancel="handleSeekPointerUp"
        >
          <div class="mini-progress-value" :style="{ width: `${displayPercent}%` }"></div>
        </div>
      </div>

      <MiniLyricPanel
        v-show="isLyricOpen"
        :lyric="lyric"
        :title="lyricTitle"
        :artist="lyricArtist"
        :cover-url="lyricCoverUrl"
        :visible="isLyricOpen"
        :is-dark="appearance?.isDark ?? false"
        :expand-direction="expandDirection"
        :aria-hidden="!isLyricOpen"
      />

      <div
        v-show="isQueueOpen || (isPreparingExpand && preparingExpandedMode === 'queue')"
        class="mini-queue no-drag"
        :aria-hidden="!isQueueOpen"
      >
        <div ref="queueScrollerRef" class="mini-queue-list">
          <div ref="containerRef" :style="queueWrapperStyle">
            <div :style="queueOffsetStyle">
              <button
                v-for="entry in visibleQueueTracks"
                :key="entry.track.trackId"
                type="button"
                class="mini-queue-item no-drag"
                :class="{ active: entry.track.trackId === currentQueueTrackId }"
                :style="{ height: `${MINI_QUEUE_ITEM_HEIGHT}px` }"
                :tabindex="isQueueOpen ? 0 : -1"
                :title="`${entry.track.title} - ${entry.track.artist}`"
                @click="playQueueTrack(entry.track.trackId)"
              >
                <div class="mini-queue-cover">
                  <Cover
                    :url="entry.track.coverUrl"
                    :size="80"
                    width="30px"
                    height="30px"
                    :borderRadius="4"
                  />
                  <span
                    v-if="entry.track.trackId === currentQueueTrackId"
                    class="mini-queue-playing"
                  >
                    <Icon
                      :icon="playback?.isPlaying ? iconPause : iconPlay"
                      width="12"
                      height="12"
                    />
                  </span>
                </div>
                <div class="mini-queue-meta">
                  <div class="mini-queue-song">{{ entry.track.title }}</div>
                  <div class="mini-queue-artist">{{ entry.track.artist }}</div>
                </div>
              </button>
            </div>
          </div>
          <div v-if="!queueTracks.length" class="mini-queue-empty">队列为空</div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.mini-shell {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  background: transparent;
  /* 不使用 -webkit-app-region: drag —— 它会吞掉拖拽区的 pointer 事件导致 hover 闪烁；
     改用 JS 自定义拖动（见 .mini-card 的 pointer 事件） */
  display: flex;
  /* 默认卡片锚定在顶部，向下增高；空间不足时主进程会切到向上展开 */
  align-items: flex-start;
  min-height: 0;
  /* 禁止文本选择/复制 */
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}

.mini-shell.expand-up {
  align-items: flex-end;
}

.mini-card {
  cursor: default;
  width: 100%;
  /* 折叠态仅控制条高度；展开时 CSS 过渡到「控制条 + 队列」高度，窗口已由主进程一次性放大，
     卡片在窗口内平滑下展，避免逐帧 setBounds 造成的闪烁 */
  height: v-bind(cardCollapsedHeight);
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  /* 无投影，仅描边 + 圆角，铺满窗口，风格与主窗口一致（只是小窗） */
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #f5f5f5;
  color: #1d1d1f;
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: height;
}

.mini-shell.expand-up .mini-card {
  flex-direction: column-reverse;
}

.mini-shell.is-expanded .mini-card {
  height: v-bind(cardExpandedHeight);
}

.mini-shell.is-preparing-expand .mini-card {
  height: v-bind(cardExpandedHeight);
  transition: none;
}

.mini-controls {
  position: relative;
  flex: 0 0 64px;
  height: 64px;
  display: grid;
  grid-template-columns: 18px 44px minmax(96px, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0 24px 0 9px;
  box-sizing: border-box;
}

.mini-left-actions {
  width: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: rgba(138, 138, 138, 0.76);
}

.mini-window-btn,
.mini-action-btn,
.mini-center-btn {
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}

.mini-window-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mini-pin-btn {
  position: absolute;
  top: 6px;
  right: 7px;
  z-index: 4;
  color: rgba(84, 84, 88, 0.64);
}

.mini-window-btn:hover,
.mini-action-btn:hover,
.mini-center-btn:hover {
  color: #222;
  opacity: 1;
}

.mini-window-btn.active,
.mini-window-btn.active:hover {
  color: var(--color-primary);
  opacity: 1;
}

.mini-window-btn:active,
.mini-action-btn:active,
.mini-center-btn:active {
  transform: scale(0.96);
}

button:disabled {
  opacity: 0.35;
  cursor: default;
  transform: none;
}

.mini-cover,
.mini-cover-placeholder {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
}

.mini-cover-btn {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease;
}

.mini-cover-btn:hover {
  transform: translateY(-1px);
}

.mini-cover-btn.active {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 55%, transparent);
}

/* Cover 组件默认用 -webkit-mask 径向渐变做圆角，在透明窗口 + 高度过渡的合成下会渲染出黑色条纹；
   这里关闭该 mask，圆角已由外层 border-radius + overflow:hidden 实现 */
.mini-cover :deep(.cover-container) {
  -webkit-mask-image: none;
  mask-image: none;
}

.mini-cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.06);
  color: rgba(29, 29, 31, 0.28);
}

.mini-center {
  min-width: 0;
  position: relative;
  height: 44px;
  display: flex;
  align-items: center;
  /* 仅中间信息/控制区上移，给贴底进度条留白；左侧按钮与封面保持居中不动 */
  margin-bottom: 8px;
}

.mini-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
  font-weight: 700;
  letter-spacing: 0;
}

.mini-artist {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
  font-size: 11px;
  line-height: 15px;
  font-weight: 600;
  color: rgba(29, 29, 31, 0.58);
}

.mini-info,
.mini-hover-controls {
  min-width: 0;
  position: absolute;
  inset: 0;
  transition: opacity 0.18s ease;
}

.mini-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.mini-hover-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  opacity: 0;
  pointer-events: none;
  color: rgba(76, 76, 76, 0.9);
}

.mini-shell.is-hovered .mini-info,
.mini-shell.is-expanded .mini-info {
  opacity: 0;
}

.mini-shell.is-hovered .mini-hover-controls,
.mini-shell.is-expanded .mini-hover-controls {
  opacity: 1;
  pointer-events: auto;
}

.mini-center-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  /* 与主窗口一致：上一首/下一首默认中性色，hover 才跟随主题色 */
  color: rgba(29, 29, 31, 0.6);
}

.mini-center-btn:hover {
  color: var(--color-primary);
  transform: translateY(-1px);
}

.mini-center-play {
  width: 30px;
  height: 30px;
  /* 圆形背景用中性底色 + 细边框（不跟随主题色）；图标默认中性、hover/播放时才主题色 */
  background: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.06);
  color: rgba(29, 29, 31, 0.7);
}

.mini-center-play:hover {
  color: var(--color-primary);
  transform: scale(1.06);
}

.mini-center-play.playing {
  color: var(--color-primary);
}

.play-offset {
  margin-left: 2px;
}

.mini-right-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgba(84, 84, 88, 0.78);
  /* 与中间区一致上移，给贴底进度条留白 */
  margin-bottom: 8px;
}

.mini-action-btn {
  width: 20px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mini-action-btn.active {
  color: var(--color-primary);
}

/* 收藏按钮始终红色（无论是否已收藏，由实心/空心爱心区分状态） */
.mini-fav-btn {
  color: #fa2d48;
}

.mini-fav-btn:hover {
  color: #fa2d48;
}

/* 音量：图标 + 内联横向滑块。保持在 mini 窗口内部，避免 hover 触发窗口尺寸变化。 */
.mini-volume {
  position: relative;
  display: flex;
  align-items: center;
}

.mini-volume-slider {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-right: 4px;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 132px;
  padding: 7px 10px 7px 12px;
  border-radius: 999px;
  background: var(--mini-volume-pop-bg, rgba(248, 248, 248, 0.96));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
  z-index: 6;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.mini-volume.open .mini-volume-slider {
  opacity: 1;
  pointer-events: auto;
  cursor: pointer;
}

.mini-volume-track {
  position: relative;
  flex: 1 1 auto;
  height: 12px;
  border-radius: 999px;
}

.mini-volume-track::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  border-radius: 999px;
  background: rgba(120, 120, 120, 0.32);
  transform: translateY(-50%);
}

.mini-volume-value {
  position: absolute;
  left: 0;
  top: 50%;
  height: 3px;
  border-radius: inherit;
  background: var(--color-primary);
  transform: translateY(-50%);
}

.mini-volume-thumb {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--color-primary);
  box-shadow: none;
  transform: translate(-50%, -50%) scale(0.9);
  transition: transform 0.12s ease;
}

.mini-volume.open .mini-volume-thumb {
  transform: translate(-50%, -50%) scale(1);
}

.mini-volume-label {
  flex: 0 0 auto;
  width: 24px;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: rgba(84, 84, 88, 0.78);
}

.mini-progress {
  position: absolute;
  left: 91px;
  right: 16px;
  bottom: 9px;
  height: 8px;
  border-radius: 999px;
  background: transparent;
  overflow: visible;
  cursor: pointer;
}

.mini-progress-value {
  position: relative;
  top: 50%;
  height: 3px;
  width: 0;
  border-radius: inherit;
  background: var(--color-primary);
  min-width: 0;
  transform: translateY(-50%);
  transition: width 0.12s linear;
}

.mini-progress::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  border-radius: 999px;
  background: rgba(210, 210, 210, 0.86);
  transform: translateY(-50%);
}

.mini-progress-value::after {
  content: '';
  position: absolute;
  top: 50%;
  right: -4px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-primary);
  opacity: 0;
  transform: translateY(-50%);
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}

.mini-progress:hover .mini-progress-value::after {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}

.mini-queue {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}

.mini-shell.is-expanded .mini-queue {
  border-top-color: rgba(0, 0, 0, 0.08);
  opacity: 1;
  transform: translateY(0);
}

.mini-shell.is-expanded.expand-up .mini-queue {
  border-top-color: transparent;
  border-bottom-color: rgba(0, 0, 0, 0.08);
  transform: translateY(0);
}

.mini-shell.expand-up .mini-queue {
  transform: translateY(8px);
}

.mini-queue-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.mini-queue-list::-webkit-scrollbar {
  width: 6px;
}

.mini-queue-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.18);
}

.mini-queue-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  box-sizing: border-box;
  transition: background 0.14s ease;
}

.mini-queue-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.mini-queue-item.active {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.mini-queue-cover {
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 4px;
  overflow: hidden;
}

.mini-queue-cover :deep(.cover-container) {
  -webkit-mask-image: none;
  mask-image: none;
}

.mini-queue-playing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
}

.mini-queue-meta {
  min-width: 0;
  flex: 1 1 auto;
}

.mini-queue-song {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}

.mini-queue-item.active .mini-queue-song {
  color: var(--color-primary);
}

.mini-queue-artist {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 14px;
  color: rgba(29, 29, 31, 0.55);
}

.mini-queue-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: rgba(29, 29, 31, 0.45);
}

.dark .mini-card {
  background: #2c2c30;
  color: #f5f5f7;
  border-color: rgba(255, 255, 255, 0.14);
}

.dark .mini-cover-placeholder {
  background: rgba(255, 255, 255, 0.06);
}

.dark .mini-artist {
  color: rgba(245, 245, 247, 0.58);
}

.dark .mini-left-actions,
.dark .mini-right-actions,
.dark .mini-hover-controls {
  color: rgba(245, 245, 247, 0.72);
}

.dark .mini-volume-label {
  color: rgba(245, 245, 247, 0.72);
}

.dark .mini-volume-slider {
  --mini-volume-pop-bg: rgba(50, 50, 54, 0.96);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}

.dark .mini-window-btn:hover,
.dark .mini-action-btn:hover {
  color: #fff;
}

.dark .mini-window-btn.active,
.dark .mini-window-btn.active:hover {
  color: var(--color-primary);
}

/* 收藏按钮在深色下也始终保持红色 */
.dark .mini-fav-btn,
.dark .mini-fav-btn:hover {
  color: #fa2d48;
}

/* 深色下中间控制：默认浅色中性、hover/播放跟随主题色；播放键圆形背景用浅色半透明中性底 */
.dark .mini-center-btn {
  color: rgba(245, 245, 247, 0.7);
}

.dark .mini-center-btn:hover,
.dark .mini-center-play.playing {
  color: var(--color-primary);
}

.dark .mini-center-play {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(245, 245, 247, 0.85);
}

.dark .mini-progress::before {
  background: rgba(255, 255, 255, 0.18);
}

.dark .mini-shell.is-expanded .mini-queue {
  border-top-color: rgba(255, 255, 255, 0.08);
}

.dark .mini-shell.is-expanded.expand-up .mini-queue {
  border-top-color: transparent;
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.dark .mini-queue-artist {
  color: rgba(245, 245, 247, 0.55);
}

.dark .mini-queue-empty {
  color: rgba(245, 245, 247, 0.45);
}

.dark .mini-queue-item:hover {
  background: rgba(255, 255, 255, 0.07);
}

.dark .mini-queue-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
}
</style>
