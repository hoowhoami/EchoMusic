<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRafFn, useThrottleFn, useWindowSize, useDebounceFn } from '@vueuse/core';
import {
  iconLock,
  iconLockOpen,
  iconPause,
  iconPlayerPlay,
  iconStepBack,
  iconStepForward,
  iconList,
  iconRefreshCw,
  iconRotateCcw,
  iconRotateCw,
  iconX,
} from '@/icons';
import {
  mergeDesktopLyricSnapshotMessage,
  type DesktopLyricSnapshot,
  type LyricLinePayload,
} from '../../shared/desktop-lyric';
import { buildFontFamily } from '../../shared/font';
import {
  getPluginLyricEffectClassNames,
  getPluginLyricEffectSummary,
  registerPluginLyricEffectHost,
  type PluginLyricEffectSnapshot,
} from '@/plugins/lyricEffects';

// ── 渲染行类型 ──

interface RenderLine {
  line: LyricLinePayload;
  index: number;
  key: string;
  active: boolean;
}

// ── 状态 ──

const snapshot = ref<DesktopLyricSnapshot | null>(null);
const isWayland = window.electron?.isWayland ?? false;
let disposeSnapshotListener: (() => void) | null = null;
let disposeHoverListener: (() => void) | null = null;
let lyricEffectHostRegistration: ReturnType<typeof registerPluginLyricEffectHost> | null = null;
let reducedMotionQuery: MediaQueryList | null = null;

// 锚点时间（毫秒）与锚点帧时间，用于插值推进
let baseMs = 0;
let anchorTick = 0;
let lastPlaybackUpdateTick = 0;

// 实时播放进度（毫秒） - 非响应式以提升性能
let playSeekMsRaw = 0;
const activeLineIndex = ref(-1);
const lyricEffectRootRef = ref<HTMLElement | null>(null);
const lyricEffectScrollerRef = ref<HTMLElement | null>(null);
const lyricEffectOverlayRef = ref<HTMLElement | null>(null);
const reducedMotion = ref(false);

// 缓存 DOM 引用
let cachedYrcElements: HTMLElement[] = [];
let cachedYrcLineKey = '';

const calculateCurrentIndex = (seekMs: number) => {
  const lines = lyrics.value;
  if (lines.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].characters?.[0]?.startTime ?? Math.round(lines[i].time * 1000);
    if (seekMs >= start) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
};

// 每帧推进播放游标
const { pause: pauseSeek, resume: resumeSeek } = useRafFn(() => {
  const state = snapshot.value?.playback;
  const now = performance.now();
  const hasFreshPlaybackProgress = now - lastPlaybackUpdateTick <= PLAYBACK_STALE_THRESHOLD;
  if (state?.isPlaying && hasFreshPlaybackProgress) {
    playSeekMsRaw = baseMs + (now - anchorTick) * (state.playbackRate || 1);
  } else {
    playSeekMsRaw = baseMs;
  }

  // 更新 currentIndexRef (触发 Vue 更新行)
  const nextIndex = calculateCurrentIndex(playSeekMsRaw + lyricTimeOffset.value);
  if (nextIndex !== activeLineIndex.value) {
    activeLineIndex.value = nextIndex;
  }

  // 手动更新 DOM
  updateYrcDomManual();
  updateScrollManual();
  notifyLyricEffectHost();
});

const updateYrcDomManual = () => {
  const idx = activeLineIndex.value;
  const renderLines = renderLyricLines.value;
  // 查找当前活跃的渲染行（逐字层）
  const activeRenderLine = renderLines.find((l) => l.active && l.index === idx);

  if (!activeRenderLine || !isYrcLine(activeRenderLine.line)) {
    cachedYrcElements = [];
    cachedYrcLineKey = '';
    return;
  }

  const key = activeRenderLine.key;
  if (key !== cachedYrcLineKey) {
    // 重新查找 DOM
    const container = lineRefs.get(key);
    if (container) {
      cachedYrcElements = Array.from(container.querySelectorAll('.word'));
      cachedYrcLineKey = key;
    } else {
      cachedYrcElements = [];
      cachedYrcLineKey = '';
    }
  }

  if (cachedYrcElements.length === 0) return;

  const seekMs = playSeekMsRaw + lyricTimeOffset.value + LYRIC_LOOKAHEAD;
  const characters = activeRenderLine.line.characters;
  const vertical = lyricLayout.value === 'vertical';

  for (let i = 0; i < cachedYrcElements.length; i++) {
    const char = characters[i];
    const el = cachedYrcElements[i];
    if (!char || !el) continue;

    const duration = Math.max((char.endTime || 0) - (char.startTime || 0), 0.001);
    const progress = Math.max(Math.min((seekMs - (char.startTime || 0)) / duration, 1), 0);
    const position = `${100 - progress * 100}%`;
    if (vertical) {
      el.style.backgroundPositionX = '0%';
      el.style.backgroundPositionY = position;
    } else {
      el.style.backgroundPositionX = position;
      el.style.backgroundPositionY = '0%';
    }
  }
};

const updateScrollManual = () => {
  const vertical = lyricLayout.value === 'vertical';
  renderLyricLines.value.forEach((line) => {
    const container = lineRefs.get(line.key);
    const content = contentRefs.get(line.key);
    if (!container || !content || !line.line) return;

    const overflow = vertical
      ? Math.max(0, content.scrollHeight - container.clientHeight)
      : Math.max(0, content.scrollWidth - container.clientWidth);
    if (overflow <= 0) {
      content.style.transform = vertical ? 'translateY(0px)' : 'translateX(0px)';
      return;
    }

    const seekMs = playSeekMsRaw + lyricTimeOffset.value;
    const chars = line.line.characters;
    if (!chars?.length) return;

    const start = chars[0].startTime;
    const endRaw = chars[chars.length - 1].endTime;
    if (!endRaw || endRaw <= start) return;

    const end = Math.max(start + 0.001, endRaw - 2000);
    const duration = Math.max(end - start, 0.001);
    const progress = Math.max(Math.min((seekMs - start) / duration, 1), 0);

    let tx = 0;
    if (progress > 0.3) {
      const ratio = (progress - 0.3) / 0.7;
      tx = -Math.round(overflow * ratio);
    }
    content.style.transform = vertical ? `translateY(${tx}px)` : `translateX(${tx}px)`;
  });
};

// 逐字高亮提前量（毫秒）
const LYRIC_LOOKAHEAD = 150;
// 锚点同步阈值（毫秒）
const SYNC_THRESHOLD = 300;
// player 没有持续上报进度时，桌面歌词不再自行推进
const PLAYBACK_STALE_THRESHOLD = 1800;
// ── 计算属性 ──

const settings = computed(() => snapshot.value?.settings);
const playback = computed(() => snapshot.value?.playback);
const activeLyricsTrackId = computed(
  () => playback.value?.lyricHash || playback.value?.trackId || null,
);
const lyricsSnapshotKey = computed(
  () => snapshot.value?.lyricsTrackId || activeLyricsTrackId.value || 'idle',
);
const renderScopeKey = computed(
  () =>
    `${activeLyricsTrackId.value || 'idle'}:${lyricsSnapshotKey.value}:${
      snapshot.value?.lyricsRevision ?? 0
    }`,
);
const lyrics = computed(() => {
  if (!snapshot.value) return [];
  if (snapshot.value.lyricsTrackId !== activeLyricsTrackId.value) return [];
  return snapshot.value.lyrics ?? [];
});
const isLocked = computed(() => settings.value?.locked ?? false);
const hasLyrics = computed(() => lyrics.value.length > 0);
const lyricTimeOffset = computed(() => snapshot.value?.lyricTimeOffset ?? 0);
const offsetStepLabel = computed(() => `${Number(settings.value?.offsetStep ?? 0.5).toFixed(1)}s`);

// 本地计算 currentIndex，不再依赖主窗口传来的值
const currentIndex = computed(() => activeLineIndex.value);
const isPlaying = computed(() => playback.value?.isPlaying ?? false);
const songName = computed(() => playback.value?.title || 'EchoMusic');
const artistName = computed(() => playback.value?.artist || '');
const alignment = computed(() => settings.value?.alignment ?? 'center');
const doubleLine = computed(() => settings.value?.doubleLine ?? true);
const lyricLayout = computed(() => settings.value?.layout ?? 'horizontal');
const isVerticalLayout = computed(() => lyricLayout.value === 'vertical');
const lyricSyncWarning = computed(() => snapshot.value?.lyricSyncWarning ?? false);
const secondaryEnabled = computed(() => {
  const s = settings.value;
  return (s?.wantTranslation ?? false) || (s?.wantRomanization ?? false);
});
const lyricsMode = computed(() => {
  const s = settings.value;
  const canTrans = (s?.wantTranslation ?? false) && hasTranslation.value;
  const canRoman = (s?.wantRomanization ?? false) && hasRomanization.value;
  if (canTrans && canRoman) return 'both';
  if (canTrans) return 'translation';
  if (canRoman) return 'romanization';
  return 'none';
});
// 当前歌词是否有翻译或音译数据
const hasTranslation = computed(() => lyrics.value.some((l) => l.translated?.trim()));
const hasRomanization = computed(() => lyrics.value.some((l) => l.romanized?.trim()));
const hasSecondary = computed(() => hasTranslation.value || hasRomanization.value);
const playedColor = computed(() => settings.value?.playedColor ?? '#31cfa1');
const unplayedColor = computed(() => settings.value?.unplayedColor ?? '#7a7a7a');
const lyricTextShadow = computed(() => {
  switch (settings.value?.shadowStrength ?? 'normal') {
    case 'none':
      return 'none';
    case 'soft':
      return '0 1px 2px rgba(0,0,0,0.32)';
    case 'strong':
      return '0 1px 0 rgba(0,0,0,0.95), 1px 0 0 rgba(0,0,0,0.78), -1px 0 0 rgba(0,0,0,0.78), 0 2px 2px rgba(0,0,0,0.45)';
    case 'normal':
    default:
      return '0 1px 2px rgba(0,0,0,0.58), 0 0 3px rgba(0,0,0,0.38)';
  }
});
const lyricDropShadow = computed(() => {
  switch (settings.value?.shadowStrength ?? 'normal') {
    case 'none':
      return 'none';
    case 'soft':
      return 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))';
    case 'strong':
      return 'drop-shadow(0 1px 0 rgba(0,0,0,0.95)) drop-shadow(1px 0 0 rgba(0,0,0,0.78)) drop-shadow(-1px 0 0 rgba(0,0,0,0.78))';
    case 'normal':
    default:
      return 'drop-shadow(0 1px 1px rgba(0,0,0,0.65)) drop-shadow(0 0 2px rgba(0,0,0,0.45))';
  }
});
const fontFamily = computed(() => {
  const raw = settings.value?.fontFamily ?? 'follow';
  const resolved = raw === 'follow' ? settings.value?.resolvedFontFamily : raw;
  return buildFontFamily(resolved || 'system-ui');
});
const fontWeight = computed(() => (settings.value?.bold ? 700 : 400));
const lyricEffectClassName = computed(() => getPluginLyricEffectClassNames('desktop').join(' '));
const lyricEffectSummary = computed(() => getPluginLyricEffectSummary('desktop'));

// hover 状态
const isHovered = ref(false);
let lastRequestedIgnoreMouseEvents: boolean | null = null;

const setDesktopLyricIgnoreMouseEvents = (ignore: boolean, force = false) => {
  if (!force && lastRequestedIgnoreMouseEvents === ignore) return;
  lastRequestedIgnoreMouseEvents = ignore;
  window.electron?.desktopLyric?.setIgnoreMouseEvents(ignore);
};

const handleMouseMove = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;

  if (isLocked.value) {
    // forward 穿透模式下能收到 mousemove 即说明鼠标在窗口内，立即显示解锁按钮；
    // 鼠标离开由主进程光标轮询兜底重置（规避 forward 模式下 mouseleave 不可靠）
    isHovered.value = true;
    const isOnLockBtn = target?.closest('.lock-btn') !== null;
    setDesktopLyricIgnoreMouseEvents(!isOnLockBtn);
    return;
  }

  // 非锁定状态：检测鼠标是否在歌词内容或工具栏区域
  const isOnContent = target?.closest('.lyric-container') !== null;
  const isOnHeader = target?.closest('.header') !== null;

  if (isOnContent || isOnHeader) {
    isHovered.value = true;
  }

  // 检测鼠标是否完全离开窗口容器
  const container = document.querySelector('.desktop-lyric');
  if (container) {
    const rect = container.getBoundingClientRect();
    const isInContainer =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!isInContainer) {
      isHovered.value = false;
    }
  }
};

const handleMouseLeave = () => {
  isHovered.value = false;
  if (isLocked.value) {
    setDesktopLyricIgnoreMouseEvents(true);
  }
};

// ── 占位行 ──

const placeholder = (word: string): RenderLine[] => [
  {
    line: { time: 0, text: word, characters: [{ text: word, startTime: 0, endTime: 0 }] },
    index: -1,
    key: `${renderScopeKey.value}:placeholder`,
    active: true,
  },
];

// ── 过渡名称 ──

const transitionName = computed(() =>
  isVerticalLayout.value ? 'lyric-slide-vertical' : 'lyric-slide',
);

// ── 行高计算 ──

const getLineTop = (index: number) => {
  if (index === 0) return '0px';
  return `${localFontSize.value * 1.9}px`;
};

const getLineInlineOffset = (index: number) => {
  if (index === 0) return '0px';
  return `${localFontSize.value * 1.35}px`;
};

const renderLyricLines = computed<RenderLine[]>(() => {
  if (!snapshot.value) return [];
  const lines = lyrics.value;
  const idx = currentIndex.value;
  // 无歌词
  if (!lines.length) {
    if (!songName.value) return placeholder('EchoMusic Desktop Lyric');
    return placeholder('EchoMusic - 听你想听');
  }
  // 索引小于 0，显示歌曲名称
  if (idx < 0) {
    return placeholder(`${songName.value} - ${artistName.value}`);
  }
  const current = lines[idx];
  if (!current) return [];
  const next = lines[idx + 1];

  // 计算安全结束时间
  const safeEnd = next
    ? (next.characters?.[0]?.startTime ?? next.time * 1000)
    : (current.characters?.[current.characters.length - 1]?.endTime ?? 0);

  // 翻译模式
  if (secondaryEnabled.value && hasSecondary.value) {
    const tran = current.translated?.trim() ?? '';
    const roman = current.romanized?.trim() ?? '';
    const mode = lyricsMode.value;
    let secondaryText = '';
    if (mode === 'both') {
      secondaryText = [roman, tran].filter(Boolean).join(' / ');
    } else if (mode === 'translation') {
      secondaryText = tran;
    } else if (mode === 'romanization') {
      secondaryText = roman;
    } else {
      secondaryText = [roman, tran].filter(Boolean).join(' / ');
    }
    if (secondaryText) {
      return [
        {
          line: { ...current, characters: current.characters.map((c) => ({ ...c })) },
          index: idx,
          key: `${renderScopeKey.value}:${idx}-orig`,
          active: true,
        },
        {
          line: {
            time: current.time,
            text: secondaryText,
            characters: [
              {
                text: secondaryText,
                startTime: current.characters?.[0]?.startTime ?? 0,
                endTime: safeEnd,
              },
            ],
          },
          index: idx,
          key: `${renderScopeKey.value}:${idx}-secondary`,
          active: false,
        },
      ];
    }
  }
  // 双行模式：当前 + 下一句
  if (doubleLine.value) {
    const result: RenderLine[] = [
      { line: current, index: idx, key: `${renderScopeKey.value}:${idx}-orig`, active: true },
    ];
    if (next) {
      result.push({
        line: next,
        index: idx + 1,
        key: `${renderScopeKey.value}:${idx + 1}-orig`,
        active: false,
      });
    }
    return result;
  }
  // 单行模式：也预渲染下一句（视觉隐藏），切换时走 move 动画而非 enter/leave
  const result: RenderLine[] = [
    { line: current, index: idx, key: `${renderScopeKey.value}:${idx}-orig`, active: true },
  ];
  if (next) {
    result.push({
      line: next,
      index: idx + 1,
      key: `${renderScopeKey.value}:${idx + 1}-orig`,
      active: false,
    });
  }
  return result;
});

const buildLyricEffectSnapshot = (): PluginLyricEffectSnapshot => {
  const index = currentIndex.value;
  const state = playback.value;
  return {
    scope: 'desktop',
    lines: lyrics.value,
    currentIndex: index,
    scrollIndex: index,
    currentLine: index >= 0 ? (lyrics.value[index] ?? null) : null,
    currentTime: Math.max(0, playSeekMsRaw / 1000),
    duration: state?.duration ?? 0,
    playbackRate: state?.playbackRate ?? 1,
    isPlaying: state?.isPlaying ?? false,
    timelineMs: playSeekMsRaw + lyricTimeOffset.value,
    lyricOffsetMs: lyricTimeOffset.value,
    lyricsMode: lyricsMode.value,
    collapsed: false,
    hasLyrics: hasLyrics.value,
    reducedMotion: reducedMotion.value,
  };
};

const notifyLyricEffectHost = () => {
  const root = lyricEffectRootRef.value;
  if (root) {
    root.style.setProperty('--echo-lyric-current-index', String(currentIndex.value));
    root.style.setProperty('--echo-lyric-scroll-index', String(currentIndex.value));
    root.dataset.echoLyricPlaying = isPlaying.value ? 'true' : 'false';
    root.dataset.echoLyricCollapsed = 'false';
    root.dataset.echoLyricReducedMotion = reducedMotion.value ? 'true' : 'false';
    root.dataset.echoLyricLayout = lyricLayout.value;
  }
  lyricEffectHostRegistration?.notify();
};

const setupLyricEffectHost = () => {
  if (lyricEffectHostRegistration) return;
  const root = lyricEffectRootRef.value;
  const scroller = lyricEffectScrollerRef.value;
  const overlay = lyricEffectOverlayRef.value;
  if (!root || !scroller || !overlay) return;

  lyricEffectHostRegistration = registerPluginLyricEffectHost({
    scope: 'desktop',
    root,
    scroller,
    overlay,
    getSnapshot: buildLyricEffectSnapshot,
  });
  notifyLyricEffectHost();
};

const updateReducedMotion = () => {
  reducedMotion.value = Boolean(reducedMotionQuery?.matches);
  notifyLyricEffectHost();
};
// 判断行是否有逐字数据
const isYrcLine = (line: LyricLinePayload) => (line.characters?.length ?? 0) > 1;

// 歌词行引用管理 (用于手动 DOM 补丁)
const lineRefs = new Map<string, HTMLElement>();
const contentRefs = new Map<string, HTMLElement>();
const resetLyricDomCache = () => {
  cachedYrcElements = [];
  cachedYrcLineKey = '';
};
const setLineRef = (el: Element | ComponentPublicInstance | null, key: string) => {
  if (el) lineRefs.set(key, el as HTMLElement);
  else lineRefs.delete(key);
};
const setContentRef = (el: Element | ComponentPublicInstance | null, key: string) => {
  if (el) contentRefs.set(key, el as HTMLElement);
  else contentRefs.delete(key);
};

watch(renderScopeKey, () => {
  resetLyricDomCache();
  lineRefs.clear();
  contentRefs.clear();
  activeLineIndex.value = calculateCurrentIndex(playSeekMsRaw + lyricTimeOffset.value);
  notifyLyricEffectHost();
});

watch(lyricTimeOffset, () => {
  activeLineIndex.value = calculateCurrentIndex(playSeekMsRaw + lyricTimeOffset.value);
  notifyLyricEffectHost();
});

watch([renderLyricLines, lyricsMode, lyricLayout, isPlaying], () => {
  notifyLyricEffectHost();
});

// 拖拽
// EchoMusic 的 preload send 只接受 (channel, data)，多参数包装成数组
const sendToMain = (channel: string, ...args: any[]) => {
  window.electron?.ipcRenderer?.send(channel, ...args);
};

// 缓存窗口和屏幕边界
const cachedBounds = reactive({
  x: 0,
  y: 0,
  width: 800,
  height: 180,
  screenMinX: -99999,
  screenMinY: -99999,
  screenMaxX: 99999,
  screenMaxY: 99999,
});

const updateCachedBounds = async () => {
  try {
    const [winBounds, screenBounds] = await Promise.all([
      window.electron.ipcRenderer.invoke('desktop-lyric:get-bounds'),
      window.electron.ipcRenderer.invoke('desktop-lyric:get-virtual-screen-bounds'),
    ]);
    cachedBounds.x = winBounds?.x ?? 0;
    cachedBounds.y = winBounds?.y ?? 0;
    cachedBounds.width = winBounds?.width ?? 800;
    cachedBounds.height = winBounds?.height ?? 180;
    cachedBounds.screenMinX = screenBounds?.minX ?? -99999;
    cachedBounds.screenMinY = screenBounds?.minY ?? -99999;
    cachedBounds.screenMaxX = screenBounds?.maxX ?? 99999;
    cachedBounds.screenMaxY = screenBounds?.maxY ?? 99999;
  } catch (e) {
    console.warn('Failed to update cached bounds:', e);
  }
};

const dragState = reactive({
  isDragging: false,
  hasMoved: false,
  startX: 0,
  startY: 0,
  startWinX: 0,
  startWinY: 0,
  winWidth: 0,
  winHeight: 0,
});

const isResizing = ref(false);

const onDocPointerDown = async (event: PointerEvent) => {
  if (isWayland) return;
  if (isLocked.value || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.menu-btn')) return;

  // 同步获取最新窗口位置，避免缓存过时导致瞬移
  try {
    const winBounds = await window.electron.ipcRenderer.invoke('desktop-lyric:get-bounds');
    if (winBounds) {
      cachedBounds.x = winBounds.x;
      cachedBounds.y = winBounds.y;
      cachedBounds.width = winBounds.width;
      cachedBounds.height = winBounds.height;
    }
  } catch {
    // 获取失败时使用缓存值
  }

  const safeWidth = cachedBounds.width > 0 ? cachedBounds.width : 800;
  const safeHeight = cachedBounds.height > 0 ? cachedBounds.height : 180;
  dragState.isDragging = true;
  dragState.hasMoved = false;
  dragState.startX = event.screenX;
  dragState.startY = event.screenY;
  dragState.startWinX = cachedBounds.x;
  dragState.startWinY = cachedBounds.y;
  dragState.winWidth = safeWidth;
  dragState.winHeight = safeHeight;
  // 捕获 pointer，确保触摸拖拽时手指移出窗口边界后仍能收到事件
  (event.target as HTMLElement)?.setPointerCapture?.(event.pointerId);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerUp);
  event.preventDefault();
};

const onDocPointerMove = useThrottleFn(
  (event: PointerEvent) => {
    if (!dragState.isDragging || isLocked.value) return;
    const deltaX = event.screenX - dragState.startX;
    const deltaY = event.screenY - dragState.startY;
    // 判断是否真正移动（超过 3px 阈值）
    if (!dragState.hasMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      dragState.hasMoved = true;
      // 只有真正开始拖动时才固定尺寸
      sendToMain('desktop-lyric:toggle-fixed-size', {
        width: dragState.winWidth,
        height: dragState.winHeight,
        fixed: true,
      });
    }
    if (dragState.hasMoved) {
      const newX = Math.round(dragState.startWinX + deltaX);
      const newY = Math.round(dragState.startWinY + deltaY);
      sendToMain('desktop-lyric:move', newX, newY, dragState.winWidth, dragState.winHeight);
    }
  },
  16,
  true,
  false,
);

const onDocPointerUp = (event?: PointerEvent | Event) => {
  if (!dragState.isDragging) return;
  const wasDragging = dragState.hasMoved;
  dragState.isDragging = false;
  dragState.hasMoved = false;
  // 释放 pointer capture
  if (event && 'pointerId' in event) {
    (event.target as HTMLElement)?.releasePointerCapture?.((event as PointerEvent).pointerId);
  }
  document.removeEventListener('pointermove', onDocPointerMove);
  document.removeEventListener('pointerup', onDocPointerUp);
  document.removeEventListener('pointercancel', onDocPointerUp);

  // 只有真正拖动过才需要恢复尺寸限制
  if (wasDragging) {
    requestAnimationFrame(() => {
      // 恢复窗口最大尺寸限制（取消 fixed 状态）
      sendToMain('desktop-lyric:toggle-fixed-size', {
        width: dragState.winWidth,
        height: dragState.winHeight,
        fixed: false,
      });
      updateCachedBounds();
    });
  }
};

// 字体大小随窗口变化

const { height: winHeight, width: winWidth } = useWindowSize();

// 检测窗口大小变化（调整大小）
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
watch([winWidth, winHeight], ([w, h], [oldW, oldH]) => {
  if (!dragState.isDragging) {
    cachedBounds.width = w;
    cachedBounds.height = h;

    // 检测是否在调整大小
    if (oldW !== undefined && oldH !== undefined && (w !== oldW || h !== oldH)) {
      isResizing.value = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        isResizing.value = false;
      }, 300);
    }
  }
});

// 本地字体大小
const localFontSize = ref(30);

const computedFontSize = computed(() => {
  if (isVerticalLayout.value) {
    const w = dragState.isDragging ? dragState.winWidth : Math.round(Number(winWidth.value ?? 0));
    const minW = 120;
    const maxW = 520;
    const minF = 20;
    const maxF = 64;
    if (!Number.isFinite(w) || w <= minW) return minF;
    if (w >= maxW) return maxF;
    return Math.round(minF + ((w - minW) / (maxW - minW)) * (maxF - minF));
  }
  const h = dragState.isDragging ? dragState.winHeight : Math.round(Number(winHeight.value ?? 0));
  const minH = 140;
  const maxH = 360;
  const minF = 20;
  const maxF = 96;
  if (!Number.isFinite(h) || h <= minH) return minF;
  if (h >= maxH) return maxF;
  return Math.round(minF + ((h - minH) / (maxH - minH)) * (maxF - minF));
});

const debouncedSaveConfig = useDebounceFn((size: number) => {
  const nextHeight = fontSizeToHeight(size);
  if (nextHeight) pushWindowHeight(nextHeight);
}, 500);

const fontSizeToHeight = (size: number) => {
  const minH = 140;
  const maxH = 360;
  const minF = 20;
  const maxF = 96;
  const s = Math.min(Math.max(Math.round(size), minF), maxF);
  return Math.round(minH + ((s - minF) / (maxF - minF)) * (maxH - minH));
};

const pushWindowHeight = (nextHeight: number) => {
  if (!Number.isFinite(nextHeight) || dragState.isDragging || lyricLayout.value !== 'horizontal')
    return;
  sendToMain('desktop-lyric:set-height', nextHeight);
};

let initialized = false;

// 窗口高度变 → 计算字体大小 → 更新本地变量 + 防抖保存
watch(computedFontSize, (size) => {
  if (!Number.isFinite(size) || dragState.isDragging || !initialized) return;
  if (Math.abs(localFontSize.value - size) > 1) {
    localFontSize.value = size;
    if (!isVerticalLayout.value) debouncedSaveConfig(size);
  }
});

// 锁定/解锁

const toggleLyricLock = () => {
  void window.electron?.desktopLyric?.toggleLock();
  // 锁定后立即设置穿透并重置 hover
  if (!isLocked.value) {
    // 即将变为锁定状态
    isHovered.value = false;
    setDesktopLyricIgnoreMouseEvents(true, true);
  }
};

// ── 操作命令 ──

const adjustLyricOffsetBackward = () => {
  window.electron?.desktopLyric?.command('lyricOffsetBackward');
};

const adjustLyricOffsetForward = () => {
  window.electron?.desktopLyric?.command('lyricOffsetForward');
};

const resetLyricOffset = () => {
  window.electron?.desktopLyric?.command('lyricOffsetReset');
};

const toggleTranslation = () => {
  if (!hasTranslation.value) return;
  window.electron?.desktopLyric?.command('toggleTranslation');
};

const toggleRomanization = () => {
  if (!hasRomanization.value) return;
  window.electron?.desktopLyric?.command('toggleRomanization');
};

const openLyricSource = () => {
  window.electron?.desktopLyric?.command('openLyricSource');
};

const closeWindow = async () => {
  if (!window.electron?.desktopLyric) return;
  snapshot.value = await window.electron.desktopLyric.hide();
};

const togglePlayback = () => {
  window.electron?.desktopLyric?.command('togglePlayback');
};
const playPrevious = () => {
  window.electron?.desktopLyric?.command('previousTrack');
};
const playNext = () => {
  window.electron?.desktopLyric?.command('nextTrack');
};

// ── 锚点同步 ──

const syncAnchor = (force = false) => {
  const state = playback.value;
  if (!state) return;
  lastPlaybackUpdateTick = performance.now();
  const newBaseMs = Math.round((state.currentTime || 0) * 1000);
  const ipcDelay = performance.now() - (state.updatedAt || performance.now());
  const compensated = ipcDelay > 0 && ipcDelay < 1000 ? newBaseMs + ipcDelay : newBaseMs;
  if (force || Math.abs(compensated - playSeekMsRaw) > SYNC_THRESHOLD) {
    baseMs = compensated;
    anchorTick = performance.now();
    playSeekMsRaw = compensated;
  }
  if (!state.isPlaying) {
    baseMs = newBaseMs;
    anchorTick = performance.now();
  }
};

// ── 生命周期 ──

onMounted(async () => {
  document.documentElement.classList.add('desktop-lyric-window');
  document.body.classList.add('desktop-lyric-window');
  document.getElementById('app')?.classList.add('desktop-lyric-window');

  snapshot.value = (await window.electron?.desktopLyric?.getSnapshot()) ?? null;
  syncAnchor(true);
  // 从窗口高度计算初始字体大小
  localFontSize.value = computedFontSize.value;
  reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  updateReducedMotion();
  reducedMotionQuery?.addEventListener?.('change', updateReducedMotion);
  setupLyricEffectHost();

  disposeSnapshotListener =
    window.electron?.desktopLyric?.onSnapshot((message) => {
      const next = mergeDesktopLyricSnapshotMessage(snapshot.value, message);
      if (!next) return;
      snapshot.value = next;
      // 每次收到 snapshot 都同步锚点，保持时间精度
      syncAnchor();
      // 按播放状态节能
      if (next.playback?.isPlaying) {
        resumeSeek();
      } else {
        baseMs = playSeekMsRaw;
        anchorTick = performance.now();
        pauseSeek();
      }
      notifyLyricEffectHost();
    }) ?? null;

  await updateCachedBounds();

  // 锁定状态下，由主进程光标轮询驱动解锁按钮的显隐（可靠跨平台）
  disposeHoverListener =
    window.electron?.desktopLyric?.onHover((hovered) => {
      if (!isLocked.value) return;
      isHovered.value = hovered;
    }) ?? null;

  // 启动 RAF
  if (isPlaying.value) {
    resumeSeek();
  } else {
    pauseSeek();
  }

  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseleave', handleMouseLeave);

  // 延迟标记初始化完成
  setTimeout(() => {
    initialized = true;
  }, 2000);
});

onBeforeUnmount(() => {
  pauseSeek();
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseleave', handleMouseLeave);
  reducedMotionQuery?.removeEventListener?.('change', updateReducedMotion);
  reducedMotionQuery = null;
  lyricEffectHostRegistration?.dispose();
  lyricEffectHostRegistration = null;
  if (dragState.isDragging) onDocPointerUp();
  document.documentElement.classList.remove('desktop-lyric-window');
  document.body.classList.remove('desktop-lyric-window');
  document.getElementById('app')?.classList.remove('desktop-lyric-window');
  disposeSnapshotListener?.();
  disposeHoverListener?.();
});
</script>

<template>
  <div
    ref="lyricEffectRootRef"
    :class="[
      'desktop-lyric',
      'echo-lyric-effect-host',
      lyricEffectClassName,
      {
        locked: isLocked,
        hovered: isHovered,
        dragging: dragState.isDragging,
        resizing: isResizing,
        'is-wayland': isWayland,
      },
    ]"
    data-echo-lyric-host="desktop"
    :data-echo-lyric-layout="lyricLayout"
    :data-echo-lyric-effect-count="lyricEffectSummary.count"
    :data-echo-lyric-effect-decorator="lyricEffectSummary.hasDecorator ? 'true' : 'false'"
  >
    <!-- 顶部工具栏 -->
    <div class="header">
      <div class="header-left" @pointerdown.stop>
        <span class="song-name">{{ songName }} - {{ artistName }}</span>
        <div v-if="hasLyrics" class="offset-controls">
          <button
            class="menu-btn"
            :title="`歌词后退 ${offsetStepLabel}`"
            @click.stop="adjustLyricOffsetBackward"
          >
            <Icon :icon="iconRotateCcw" width="18" height="18" />
          </button>
          <button
            class="menu-btn"
            :title="`歌词前进 ${offsetStepLabel}`"
            @click.stop="adjustLyricOffsetForward"
          >
            <Icon :icon="iconRotateCw" width="18" height="18" />
          </button>
          <button
            v-if="lyricTimeOffset !== 0"
            class="menu-btn"
            title="重置偏移"
            @click.stop="resetLyricOffset"
          >
            <Icon :icon="iconRefreshCw" width="17" height="17" />
          </button>
        </div>
      </div>
      <div class="header-center" @pointerdown.stop>
        <button class="menu-btn" title="上一首" @click.stop="playPrevious">
          <Icon :icon="iconStepBack" width="20" height="20" />
        </button>
        <button class="menu-btn" :title="isPlaying ? '暂停' : '播放'" @click.stop="togglePlayback">
          <Icon :icon="isPlaying ? iconPause : iconPlayerPlay" width="20" height="20" />
        </button>
        <button class="menu-btn" title="下一首" @click.stop="playNext">
          <Icon :icon="iconStepForward" width="20" height="20" />
        </button>
      </div>
      <div class="header-right" @pointerdown.stop>
        <button class="menu-btn" title="选择歌词" @click.stop="openLyricSource">
          <Icon :icon="iconList" width="20" height="20" />
        </button>
        <div v-if="hasLyrics && hasSecondary" class="tran-group">
          <button
            v-if="hasTranslation"
            class="menu-btn text-toggle-btn"
            :class="{ 'is-active': settings?.wantTranslation }"
            title="翻译"
            @click.stop="toggleTranslation"
          >
            译
          </button>
          <button
            v-if="hasRomanization"
            class="menu-btn text-toggle-btn"
            :class="{ 'is-active': settings?.wantRomanization }"
            title="音译"
            @click.stop="toggleRomanization"
          >
            音
          </button>
        </div>
        <button class="menu-btn lock-btn" @click.stop="toggleLyricLock">
          <Icon :icon="isLocked ? iconLockOpen : iconLock" width="20" height="20" />
        </button>
        <button class="menu-btn" @click.stop="closeWindow">
          <Icon :icon="iconX" width="20" height="20" />
        </button>
      </div>
    </div>

    <!-- 歌词区域 -->
    <TransitionGroup
      ref="lyricEffectScrollerRef"
      tag="div"
      :name="transitionName"
      :style="{
        fontSize: localFontSize + 'px',
        fontFamily,
        fontWeight,
        textShadow: lyricTextShadow,
      }"
      :class="['lyric-container', alignment, lyricLayout]"
      data-echo-lyric-scroller="desktop"
      :data-echo-lyric-current-index="currentIndex"
      :data-echo-lyric-scroll-index="currentIndex"
    >
      <div
        v-for="(line, index) in renderLyricLines"
        :key="line.key"
        :class="[
          'lyric-line',
          {
            active: line.active,
            'is-yrc': line.active && isYrcLine(line.line),
            'is-next': !line.active && doubleLine,
            'is-hidden-next': !line.active && !doubleLine,
            'align-left': alignment === 'both' && line.index % 2 === 0,
            'align-right': alignment === 'both' && line.index % 2 !== 0,
          },
        ]"
        :style="{
          color: line.active ? playedColor : unplayedColor,
          top: isVerticalLayout ? '0px' : getLineTop(index),
          right: isVerticalLayout
            ? `calc(${getLineInlineOffset(index)} + var(--desktop-lyric-vertical-safe-inline))`
            : undefined,
          left: isVerticalLayout ? 'auto' : undefined,
          fontSize: index > 0 ? '0.8em' : '1em',
        }"
        data-echo-lyric-row
        :data-echo-lyric-index="line.index"
        :data-echo-lyric-current="line.active ? 'true' : 'false'"
        :data-echo-lyric-distance="line.index - currentIndex"
        :data-echo-lyric-abs-distance="Math.abs(line.index - currentIndex)"
        :data-echo-lyric-line-start-ms="
          line.line.characters?.[0]?.startTime ?? Math.round(line.line.time * 1000)
        "
        :ref="(el) => setLineRef(el, line.key)"
      >
        <!-- 逐字歌词 (如果存在逐字数据则始终渲染 YRC 结构，以便手动补丁 DOM) -->
        <template v-if="isYrcLine(line.line)">
          <span class="scroll-content" :ref="(el) => setContentRef(el, line.key)">
            <span
              class="content"
              data-echo-lyric-line
              data-echo-lyric-primary
              :data-echo-lyric-current="line.active ? 'true' : 'false'"
            >
              <span
                v-for="(char, ci) in line.line.characters"
                :key="ci"
                :class="{
                  'content-text': true,
                  'end-with-space': char.text.endsWith(' ') || char.startTime === 0,
                }"
              >
                <span
                  class="word"
                  data-echo-lyric-char
                  :style="
                    line.active
                      ? {
                          backgroundImage: `linear-gradient(${isVerticalLayout ? 'to bottom' : 'to right'}, ${playedColor} 50%, ${unplayedColor} 50%)`,
                          backgroundSize: isVerticalLayout ? '100% 200%' : '200% 100%',
                          textShadow: 'none',
                          filter: lyricDropShadow,
                          backgroundPositionX: isVerticalLayout ? '0%' : '100%',
                          backgroundPositionY: isVerticalLayout ? '100%' : '0%',
                        }
                      : undefined
                  "
                  >{{ char.text }}</span
                >
              </span>
            </span>
          </span>
        </template>
        <!-- 普通歌词 -->
        <template v-else>
          <span
            class="scroll-content"
            data-echo-lyric-line
            data-echo-lyric-primary
            :data-echo-lyric-current="line.active ? 'true' : 'false'"
            :ref="(el) => setContentRef(el, line.key)"
            >{{ line.line.text || '' }}</span
          >
        </template>
      </div>
      <!-- 占位 -->
      <span v-if="renderLyricLines.length === 0" class="lyric-line" key="placeholder">&nbsp;</span>
    </TransitionGroup>

    <div
      ref="lyricEffectOverlayRef"
      class="desktop-lyric-effect-overlay"
      data-echo-lyric-effect-overlay
    ></div>

    <!-- 歌词同步警告 -->
    <div v-if="lyricSyncWarning" class="sync-warning">播放时长与原曲存在差异，歌词可能不同步</div>
  </div>
</template>

<style scoped>
.desktop-lyric {
  position: relative;
  --desktop-lyric-vertical-rail-width: 36px;
  --desktop-lyric-vertical-rail-inset: 8px;
  --desktop-lyric-vertical-lyric-gap: 12px;
  --desktop-lyric-vertical-safe-inline: calc(
    var(--desktop-lyric-vertical-rail-width) + var(--desktop-lyric-vertical-rail-inset) +
      var(--desktop-lyric-vertical-lyric-gap)
  );
  display: flex;
  flex-direction: column;
  height: 100%;
  color: #fff;
  background-color: transparent;
  padding: 12px;
  border-radius: 12px;
  overflow: hidden;
  transition: background-color 0.3s;
  cursor: default;
  touch-action: none;
  user-select: none;
}

.desktop-lyric-effect-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] {
  padding: 10px;
}

/* 顶部工具栏 */
.header {
  position: relative;
  margin-bottom: 12px;
  cursor: default;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  grid-gap: 12px;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .header {
  position: absolute;
  top: 10px;
  right: var(--desktop-lyric-vertical-rail-inset);
  bottom: 10px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  width: var(--desktop-lyric-vertical-rail-width);
  max-height: calc(100% - 20px);
  margin-bottom: 0;
  gap: 8px;
  pointer-events: none;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .header-left,
.desktop-lyric[data-echo-lyric-layout='vertical'] .header-center,
.desktop-lyric[data-echo-lyric-layout='vertical'] .header-right {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  overflow: visible;
  pointer-events: auto;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .header-left {
  justify-content: flex-start;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .header-center {
  justify-content: center;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .header-right {
  justify-content: flex-end;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .song-name {
  display: none;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .menu-btn {
  width: 30px;
  height: 30px;
  padding: 4px;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .offset-controls {
  flex-direction: column;
  gap: 6px;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group {
  flex-direction: column;
  gap: 0;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group .menu-btn {
  border-radius: 0;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group .menu-btn:first-child {
  border-radius: 8px 8px 0 0;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group .menu-btn:last-child {
  border-radius: 0 0 8px 8px;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group .menu-btn:only-child {
  border-radius: 8px;
}

.desktop-lyric[data-echo-lyric-layout='vertical'] .tran-group .menu-btn + .menu-btn {
  border-left: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}
.header > * {
  min-width: 0;
}
.header-left {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  overflow: hidden;
}
.header-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.song-name {
  font-size: 1em;
  text-align: left;
  flex: 1 1 auto;
  line-height: 36px;
  padding: 0 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.3s;
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 6px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: inherit;
  will-change: transform;
  transition:
    opacity 0.3s,
    background-color 0.3s,
    transform 0.3s;
  cursor: pointer;
}
.menu-btn.lock-btn {
  pointer-events: auto;
}
.menu-btn.lock-btn svg {
  filter: drop-shadow(0 0 6px rgba(0, 0, 0, 0.9)) drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
}
.menu-btn:hover {
  background-color: rgba(255, 255, 255, 0.3);
}
.menu-btn:active {
  transform: scale(0.98);
}
.menu-btn.text-toggle-btn.is-active {
  color: #31cfa1;
}

.tran-group {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border-radius: 8px;
  overflow: hidden;
  gap: 0;
  opacity: 0;
  transition:
    opacity 0.3s,
    background-color 0.3s;
}

.desktop-lyric.hovered:not(.locked) .tran-group,
.desktop-lyric.dragging:not(.locked) .tran-group,
.desktop-lyric.resizing:not(.locked) .tran-group,
.desktop-lyric.is-wayland:hover:not(.locked) .tran-group {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.tran-group .menu-btn {
  border-radius: 0;
  margin: 0;
  opacity: 1;
}

.tran-group .menu-btn:first-child {
  border-radius: 8px 0 0 8px;
}

.tran-group .menu-btn:last-child {
  border-radius: 0 8px 8px 0;
}

.tran-group .menu-btn:only-child {
  border-radius: 8px;
}

.tran-group .menu-btn + .menu-btn {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.offset-controls {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.text-toggle-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  line-height: 1;
}

/* 默认隐藏工具栏 */
.song-name,
.menu-btn {
  opacity: 0;
}

/* 歌词容器 */
.lyric-container {
  height: 100%;
  padding: 0 8px;
  cursor: move;
  position: relative;
}

.lyric-container.vertical {
  min-height: 0;
  padding: 4px 0;
  writing-mode: vertical-rl;
  text-orientation: mixed;
}

.desktop-lyric.is-wayland:not(.locked) .lyric-container {
  -webkit-app-region: drag;
}

.desktop-lyric.is-wayland .header,
.desktop-lyric.is-wayland .menu-btn {
  -webkit-app-region: no-drag;
}

.lyric-line {
  position: absolute;
  width: 100%;
  left: 0;
  line-height: normal;
  padding: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    top 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    font-size 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    color 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  will-change: top, font-size, transform;
  transform-origin: left center;
}

.lyric-container.vertical .lyric-line {
  top: 0;
  bottom: 0;
  width: auto;
  height: 100%;
  min-width: 1em;
  padding: 4px 6px;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  transition:
    right 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    font-size 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    color 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  transform-origin: center top;
}

/* 单行模式：隐藏预渲染的下一句，不占视觉空间 */
.lyric-line.is-hidden-next {
  opacity: 0 !important;
  height: 0 !important;
  padding: 0 !important;
  overflow: hidden;
  pointer-events: none;
}

.scroll-content {
  display: inline-block;
  white-space: nowrap;
  will-change: transform;
}

.lyric-container.vertical .scroll-content {
  max-height: 100%;
}

/* 逐字歌词 */
.lyric-line.is-yrc .content {
  display: inline-flex;
  flex-wrap: nowrap;
  width: auto;
  overflow-wrap: normal;
  word-break: normal;
  white-space: nowrap;
  text-align: inherit;
}
.lyric-container.vertical .lyric-line.is-yrc .content {
  flex-direction: row;
  align-items: center;
  height: auto;
  max-height: none;
  writing-mode: vertical-rl;
  text-orientation: mixed;
}
.lyric-line.is-yrc .content-text {
  position: relative;
  display: inline-block;
}
.lyric-line.is-yrc .content-text .word {
  display: inline-block;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
  will-change: background-position-x;
}
.lyric-container.vertical .lyric-line.is-yrc .content-text .word {
  background-size: 100% 200%;
  will-change: background-position-y;
}
.lyric-line.is-yrc .content-text.end-with-space {
  margin-inline-end: 5vh;
}
.lyric-container.vertical .lyric-line.is-yrc .content-text.end-with-space {
  margin-inline-end: 2vh;
}
.lyric-line.is-yrc .content-text.end-with-space:last-child {
  margin-inline-end: 0;
}

/* 对齐方式 */
.lyric-container.center .lyric-line {
  text-align: center;
  transform-origin: center center;
}
.lyric-container.vertical.center .lyric-line {
  text-align: center;
}
.lyric-container.center .lyric-line.is-yrc .content {
  justify-content: center;
}
.lyric-container.vertical.center .lyric-line.is-yrc .content {
  align-items: center;
}
.lyric-container.right .lyric-line {
  text-align: right;
  transform-origin: right center;
}
.lyric-container.vertical.right .lyric-line {
  text-align: end;
  transform-origin: center bottom;
}
.lyric-container.right .lyric-line.is-yrc .content {
  justify-content: flex-end;
}
.lyric-container.both .lyric-line.align-right {
  text-align: right;
  transform-origin: right center;
}
.lyric-container.vertical.both .lyric-line.align-right {
  text-align: end;
  transform-origin: center bottom;
}
.lyric-container.both .lyric-line.align-left {
  text-align: left;
  transform-origin: left center;
}
.lyric-container.vertical.both .lyric-line.align-left {
  text-align: start;
  transform-origin: center top;
}
.lyric-container.both .lyric-line.is-yrc.align-right .content {
  justify-content: flex-end;
}

/* 过渡动画 */
.lyric-slide-move,
.lyric-slide-enter-active,
.lyric-slide-leave-active {
  transition:
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  will-change: transform, opacity;
}
.lyric-slide-enter-from {
  opacity: 0;
  transform: translateY(100%);
}
.lyric-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
.lyric-slide-leave-active {
  position: absolute;
}

.lyric-slide-vertical-move,
.lyric-slide-vertical-enter-active,
.lyric-slide-vertical-leave-active {
  transition:
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  will-change: transform, opacity;
}
.lyric-slide-vertical-enter-from {
  opacity: 0;
  transform: translateX(100%);
}
.lyric-slide-vertical-leave-to {
  opacity: 0;
  transform: translateX(-100%);
}
.lyric-slide-vertical-leave-active {
  position: absolute;
}

/* Hover 状态 */
.desktop-lyric.hovered:not(.locked) {
  background-color: rgba(0, 0, 0, 0.6);
}
.desktop-lyric.is-wayland:hover:not(.locked) {
  background-color: rgba(0, 0, 0, 0.6);
}
.desktop-lyric.hovered:not(.locked) .song-name,
.desktop-lyric.hovered:not(.locked) .menu-btn,
.desktop-lyric.is-wayland:hover:not(.locked) .song-name,
.desktop-lyric.is-wayland:hover:not(.locked) .menu-btn {
  opacity: 1;
}

/* 拖动和调整大小状态 */
.desktop-lyric.dragging:not(.locked),
.desktop-lyric.resizing:not(.locked) {
  background-color: rgba(0, 0, 0, 0.7) !important;
  border: 2px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.desktop-lyric.dragging:not(.locked) .song-name,
.desktop-lyric.dragging:not(.locked) .menu-btn,
.desktop-lyric.resizing:not(.locked) .song-name,
.desktop-lyric.resizing:not(.locked) .menu-btn {
  opacity: 1;
}

/* 锁定状态 */
.desktop-lyric.locked {
  cursor: default;
}
.desktop-lyric.locked .song-name,
.desktop-lyric.locked .menu-btn,
.desktop-lyric.locked .lyric-container {
  pointer-events: none;
}
.desktop-lyric.locked .menu-btn.lock-btn {
  pointer-events: auto;
}
.desktop-lyric.locked.hovered .lock-btn {
  opacity: 1;
  background-color: rgba(0, 0, 0, 0.45);
}

.sync-warning {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: rgba(255, 200, 50, 0.85);
  white-space: nowrap;
  pointer-events: none;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
</style>

<style>
body {
  background-color: transparent !important;
}
html,
body {
  overflow: hidden;
}
.desktop-lyric-window {
  background-color: transparent !important;
}
</style>
