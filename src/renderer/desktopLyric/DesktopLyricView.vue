<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRafFn, useWindowSize } from '@vueuse/core';
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
  DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_SECONDS,
  isDesktopLyricFullSnapshot,
  mergeDesktopLyricSnapshotMessage,
  type DesktopLyricSnapshot,
  type LyricCharacterPayload,
  type LyricLinePayload,
} from '../../shared/desktop-lyric';
import { buildFontFamily } from '../../shared/font';
import {
  getPluginLyricEffectClassNames,
  getPluginLyricEffectSummary,
  registerPluginLyricEffectHost,
  type PluginLyricEffectSnapshot,
} from '@/plugins/lyricEffects';
import {
  computeLyricCharBackgroundPosition,
  computeLyricCharProgress,
  createLyricTimeline,
  DEFAULT_LYRIC_RECENT_SEEK_WINDOW_MS,
  findLyricIndexAtTimeMs,
} from '@/composables/useLyricTimeline';
import { createStableLyricIndex } from '@/composables/useStableLyricIndex';
import { findNextVisibleLyricIndex, resolveVisibleLyricIndex } from '@/utils/lyricFilter';

// ── 渲染行类型 ──

interface RenderLine {
  line: LyricLinePayload;
  index: number;
  key: string;
  active: boolean;
  kind: 'placeholder' | 'primary' | 'secondary' | 'next';
  // 该行需逐字卡拉OK（当前行翻译，且提供逐字数据时）
  karaoke?: boolean;
}

// ── 状态 ──

const snapshot = ref<DesktopLyricSnapshot | null>(null);
const isWayland = window.electron?.isWayland ?? false;
let disposeSnapshotListener: (() => void) | null = null;
let disposeHoverListener: (() => void) | null = null;
let lyricEffectHostRegistration: ReturnType<typeof registerPluginLyricEffectHost> | null = null;
let reducedMotionQuery: MediaQueryList | null = null;

// 实时播放进度（毫秒） - 非响应式以提升性能
let playSeekMsRaw = 0;
const activeLineIndex = ref(-1);
const lyricEffectRootRef = ref<HTMLElement | null>(null);
const lyricEffectScrollerRef = ref<HTMLElement | null>(null);
const lyricEffectOverlayRef = ref<HTMLElement | null>(null);
const lockButtonRef = ref<HTMLButtonElement | null>(null);
const reducedMotion = ref(false);

// 缓存 DOM 引用
let cachedYrcElements: HTMLElement[] = [];
let cachedRubyElements: HTMLElement[] = [];
let cachedYrcLineKey = '';
const lyricTimeline = createLyricTimeline();
const stableLyricIndex = createStableLyricIndex();

const getTimelinePlayback = () => snapshot.value?.playback ?? null;

const isRecentLyricSeek = () => {
  const seekTimestamp = Number(snapshot.value?.playback?.seekTimestamp ?? 0);
  return seekTimestamp > 0 && Date.now() - seekTimestamp < DEFAULT_LYRIC_RECENT_SEEK_WINDOW_MS;
};

const refreshTimelineState = (options?: { resetStable?: boolean }) => {
  const state = getTimelinePlayback();
  playSeekMsRaw = lyricTimeline.getPlaybackMs(state);
  const timelineMs = Math.round(playSeekMsRaw + lyricTimeOffset.value);
  const rawIndex = findLyricIndexAtTimeMs(lyrics.value, timelineMs);
  const nextIndex = options?.resetStable
    ? stableLyricIndex.reset(rawIndex, timelineMs)
    : stableLyricIndex.apply(rawIndex, timelineMs);
  if (nextIndex !== activeLineIndex.value) {
    activeLineIndex.value = nextIndex;
  }
  return timelineMs;
};

// 每帧推进播放游标
const { pause: pauseSeek, resume: resumeSeek } = useRafFn(() => {
  const timelineMs = refreshTimelineState();
  updateYrcDomManual(timelineMs);
  updateScrollManual(timelineMs);
  notifyLyricEffectHost();
});

const updateYrcDomManual = (timelineMs: number) => {
  const renderLines = renderLyricLines.value;
  // 查找当前活跃的渲染行（逐字层）
  const activeRenderLine = renderLines.find((line) => line.active);
  const seekMs = timelineMs + LYRIC_LOOKAHEAD;
  const vertical = lyricLayout.value === 'vertical';

  // 主行逐字填充（仅当主行有逐字数据）
  if (activeRenderLine && isYrcLine(activeRenderLine.line)) {
    const key = activeRenderLine.key;
    if (key !== cachedYrcLineKey) {
      // 重新查找 DOM
      const container = lineRefs.get(key);
      if (container) {
        cachedYrcElements = Array.from(container.querySelectorAll('.word'));
        cachedRubyElements = Array.from(container.querySelectorAll('.ruby-word'));
        cachedYrcLineKey = key;
      } else {
        cachedYrcElements = [];
        cachedRubyElements = [];
        cachedYrcLineKey = '';
      }
    }

    if (cachedYrcElements.length > 0 || cachedRubyElements.length > 0) {
      const characters = activeRenderLine.line.characters;

      for (let i = 0; i < cachedYrcElements.length; i++) {
        const char = characters[i];
        const el = cachedYrcElements[i];
        if (!char || !el) continue;

        const position = computeLyricCharBackgroundPosition(
          char.startTime || 0,
          char.endTime || 0,
          seekMs,
        );
        if (vertical) {
          el.style.backgroundPositionX = '0%';
          el.style.backgroundPositionY = position;
        } else {
          el.style.backgroundPositionX = position;
          el.style.backgroundPositionY = '0%';
        }
      }

      // 注音模式的读音逐字填充：按注音单元自身时间轴与主歌词同步着色
      const rubyUnits = activeRenderLine.line.rubyUnits;
      for (let i = 0; i < cachedRubyElements.length; i++) {
        const unit = rubyUnits?.[i];
        const el = cachedRubyElements[i];
        if (!unit || !el) continue;

        const position = computeLyricCharBackgroundPosition(
          unit.startTime || 0,
          unit.endTime || 0,
          seekMs,
        );
        if (vertical) {
          el.style.backgroundPositionX = '0%';
          el.style.backgroundPositionY = position;
        } else {
          el.style.backgroundPositionX = position;
          el.style.backgroundPositionY = '0%';
        }
      }
    }
  } else {
    cachedYrcElements = [];
    cachedRubyElements = [];
    cachedYrcLineKey = '';
  }

  // 当前行副歌词逐字填充（翻译/音译，与页面歌词一致）——不依赖主行是否有逐字数据
  const secondaryLines = renderLines.filter((line) => line.kind === 'secondary' && line.karaoke);
  for (const secondaryLine of secondaryLines) {
    const secondaryContainer = lineRefs.get(secondaryLine.key);
    if (!secondaryContainer) continue;
    const secondaryWords = secondaryContainer.querySelectorAll<HTMLElement>('.word');
    const transChars = secondaryLine.line.characters;
    for (let i = 0; i < secondaryWords.length; i++) {
      const char = transChars[i];
      const el = secondaryWords[i];
      if (!char || !el) continue;
      const position = computeLyricCharBackgroundPosition(
        char.startTime || 0,
        char.endTime || 0,
        seekMs,
      );
      if (vertical) {
        el.style.backgroundPositionX = '0%';
        el.style.backgroundPositionY = position;
      } else {
        el.style.backgroundPositionX = position;
        el.style.backgroundPositionY = '0%';
      }
    }
  }
};

const updateScrollManual = (timelineMs: number) => {
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

    const chars = line.line.characters;
    if (!chars?.length) return;

    const start = chars[0].startTime;
    const endRaw = chars[chars.length - 1].endTime;
    if (!endRaw || endRaw <= start) return;

    const end = Math.max(start + 0.001, endRaw - 2000);
    const progress = computeLyricCharProgress(start, end, timelineMs);

    let tx = 0;
    if (progress > 0.3) {
      const ratio = (progress - 0.3) / 0.7;
      tx = -Math.round(overflow * ratio);
    }
    content.style.transform = vertical ? `translateY(${tx}px)` : `translateX(${tx}px)`;
  });
};

const syncManualDomAfterRender = (options?: { resetStable?: boolean }) => {
  void nextTick(() => {
    const timelineMs = refreshTimelineState(options);
    updateYrcDomManual(timelineMs);
    updateScrollManual(timelineMs);
    notifyLyricEffectHost();
  });
};

// 播放引擎时间锚点已由共享时间轴插值补偿，逐字进度不再额外提前。
const LYRIC_LOOKAHEAD = 0;
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
const showUnlockButton = computed(() => settings.value?.showUnlockButton ?? true);
// Wayland 不支持全局光标坐标与鼠标事件转发，锁定后只能通过托盘菜单解锁。
const canShowUnlockButton = computed(() => showUnlockButton.value && !isWayland);
const hasLyrics = computed(() => lyrics.value.length > 0);
const lyricTimeOffset = computed(() => snapshot.value?.lyricTimeOffset ?? 0);
const offsetStepLabel = computed(() => {
  const step = Number(settings.value?.offsetStep);
  const safeStep =
    Number.isFinite(step) && step > 0 ? step : DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_SECONDS;
  return `${safeStep.toFixed(1)}s`;
});

// 本地计算 currentIndex，不再依赖主窗口传来的值
const currentIndex = computed(() => activeLineIndex.value);
const isPlaying = computed(() => playback.value?.isPlaying ?? false);
const songName = computed(() => playback.value?.title || 'EchoMusic');
const artistName = computed(() => playback.value?.artist || '');
const alignment = computed(() => settings.value?.alignment ?? 'center');
const showNextLinePreview = computed(() => settings.value?.showNextLinePreview ?? true);
const lyricLayout = computed(() => settings.value?.layout ?? 'horizontal');
const isVerticalLayout = computed(() => lyricLayout.value === 'vertical');
const lyricSyncWarning = computed(() => snapshot.value?.lyricSyncWarning ?? false);
const lyricFilterConfig = computed(() => ({
  enabled: settings.value?.filterEnabled ?? false,
  pattern: settings.value?.filterPattern ?? '',
}));
const visibleCurrentIndex = computed(() =>
  resolveVisibleLyricIndex(lyrics.value, currentIndex.value, lyricFilterConfig.value),
);
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
    if (!canShowUnlockButton.value) {
      isHovered.value = false;
      setDesktopLyricIgnoreMouseEvents(true);
      return;
    }
    // forward 穿透模式下能收到 mousemove 即说明鼠标在窗口内，立即显示解锁按钮；
    // 鼠标离开由主进程光标轮询兜底重置（规避 forward 模式下 mouseleave 不可靠）
    isHovered.value = true;
    const isOnLockBtn = target?.closest('.lock-btn') !== null;
    setDesktopLyricIgnoreMouseEvents(!isOnLockBtn);
    return;
  }

  // 桌面歌词页面本身就是窗口内容；窗口内任意位置移动都应显示背景和工具栏。
  // pointer capture 等情况下事件可能带着窗外坐标抵达，保留 rect 语义兜底。
  isHovered.value =
    event.clientX >= 0 &&
    event.clientX <= window.innerWidth &&
    event.clientY >= 0 &&
    event.clientY <= window.innerHeight;
};

const handleMouseLeave = () => {
  isHovered.value = false;
  if (isLocked.value) {
    setDesktopLyricIgnoreMouseEvents(true);
  }
};

const handleWindowBlur = () => {
  if (!isLocked.value) isHovered.value = false;
};

// ── 占位行 ──

const placeholder = (word: string): RenderLine[] => [
  {
    line: { time: 0, text: word, characters: [{ text: word, startTime: 0, endTime: 0 }] },
    index: -1,
    key: `${renderScopeKey.value}:placeholder`,
    active: true,
    kind: 'placeholder',
  },
];

// ── 过渡名称 ──

const transitionName = computed(() =>
  isVerticalLayout.value ? 'lyric-slide-vertical' : 'lyric-slide',
);

// ── 行高计算 ──

const LYRIC_BASE_LINE_HEIGHT = 1.24;
const LYRIC_SECONDARY_FONT_SCALE = 0.72;
const LYRIC_NEXT_LINE_FONT_SCALE = 0.8;
const LYRIC_RUBY_FONT_SCALE = 0.68;
const LYRIC_RUBY_LINE_HEIGHT = 1.1;
const LYRIC_LINE_VERTICAL_PADDING_PX = 8;

const getHorizontalLineGap = () => Math.min(8, Math.max(3, Math.round(localFontSize.value * 0.1)));

const getHorizontalLineBlockHeight = (line: RenderLine, index: number, rubyActive: boolean) => {
  if (index === 0 && rubyActive) {
    return (
      localFontSize.value *
        (LYRIC_BASE_LINE_HEIGHT + LYRIC_RUBY_FONT_SCALE * LYRIC_RUBY_LINE_HEIGHT) +
      LYRIC_LINE_VERTICAL_PADDING_PX
    );
  }

  const fontScale =
    line.kind === 'secondary'
      ? LYRIC_SECONDARY_FONT_SCALE
      : index > 0
        ? LYRIC_NEXT_LINE_FONT_SCALE
        : 1;
  return localFontSize.value * fontScale * LYRIC_BASE_LINE_HEIGHT + LYRIC_LINE_VERTICAL_PADDING_PX;
};

const getLineTop = (index: number) => {
  if (index === 0) return '0px';
  const lines = renderLyricLines.value;
  const current = lines[0];
  const rubyActive = Boolean(current?.active && isRubyLine(current.line));
  // 按每行的实际视觉高度堆叠，并为普通/注音布局使用一致的行间留白。
  let top = 0;
  for (let i = 0; i < index && i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    top += getHorizontalLineBlockHeight(line, i, rubyActive) + getHorizontalLineGap();
  }
  return `${top}px`;
};

const getLineInlineOffset = (index: number) => {
  if (index === 0) return '0px';
  const lines = renderLyricLines.value;
  // 竖排布局：主行靠右，副歌词行以副行字号紧凑向左堆叠
  let offset = 0;
  for (let i = 0; i < index && i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    if (i === 0) {
      offset += localFontSize.value * 1.35;
    } else if (line.kind === 'secondary') {
      offset += localFontSize.value * 0.72 * 1.35;
    } else {
      offset += localFontSize.value * 1.35;
    }
  }
  return `${offset}px`;
};

const renderLyricLines = computed<RenderLine[]>(() => {
  if (!snapshot.value) return [];
  const lines = lyrics.value;
  const idx = visibleCurrentIndex.value;
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
  const nextIndex = findNextVisibleLyricIndex(lines, idx, lyricFilterConfig.value);
  const next = nextIndex >= 0 ? lines[nextIndex] : undefined;

  // 计算安全结束时间
  const safeEnd = next
    ? (next.characters?.[0]?.startTime ?? next.time * 1000)
    : (current.characters?.[current.characters.length - 1]?.endTime ?? 0);

  // 翻译模式
  if (secondaryEnabled.value && hasSecondary.value) {
    const tran = current.translated?.trim() ?? '';
    const roman = current.romanized?.trim() ?? '';
    const mode = lyricsMode.value;
    // 注音行：音译已标注在每个字上方，副歌词只保留翻译
    const romanShownAsRuby = isRubyLine(current);

    const makeSecondary = (
      key: string,
      text: string,
      chars: LyricCharacterPayload[] | undefined,
    ): RenderLine => {
      const karaoke = Boolean(chars?.length);
      return {
        line: {
          time: current.time,
          text,
          characters: karaoke
            ? chars!.map((c) => ({ ...c }))
            : [
                {
                  text,
                  startTime: current.characters?.[0]?.startTime ?? 0,
                  endTime: safeEnd,
                },
              ],
        },
        index: idx,
        key,
        active: false,
        kind: 'secondary',
        karaoke,
      };
    };

    const result: RenderLine[] = [
      {
        line: { ...current, characters: current.characters.map((c) => ({ ...c })) },
        index: idx,
        key: `${renderScopeKey.value}:${idx}-orig`,
        active: true,
        kind: 'primary',
      },
    ];

    // 译+音：音译与翻译各占一行（与页面歌词一致），均支持逐字卡拉OK
    if (mode === 'both' && !romanShownAsRuby && roman && tran) {
      result.push(
        makeSecondary(`${renderScopeKey.value}:${idx}-roman`, roman, current.romanizedCharacters),
      );
      result.push(
        makeSecondary(`${renderScopeKey.value}:${idx}-tran`, tran, current.translatedCharacters),
      );
      return result;
    }

    let secondaryText = '';
    if (mode === 'both') {
      secondaryText = romanShownAsRuby ? tran : roman || tran;
    } else if (mode === 'translation') {
      secondaryText = tran;
    } else if (mode === 'romanization') {
      secondaryText = romanShownAsRuby ? '' : roman;
    } else {
      secondaryText = roman || tran;
    }
    if (secondaryText) {
      // 纯翻译 / 纯音译副歌词支持逐字卡拉OK（与页面歌词一致）；
      // 「音译/翻译」混排时无法在单行内同时逐字，退回整行着色
      const isPureTranslation =
        Boolean(tran) && (mode === 'translation' || !roman || romanShownAsRuby);
      const isPureRomanization = Boolean(roman) && (mode === 'romanization' || !tran);
      const chars = isPureRomanization
        ? current.romanizedCharacters
        : isPureTranslation
          ? current.translatedCharacters
          : undefined;
      result.push(makeSecondary(`${renderScopeKey.value}:${idx}-secondary`, secondaryText, chars));
      return result;
    }
  }
  // 没有副歌词可显示时，下一行预览才占用第二行。
  if (showNextLinePreview.value) {
    const result: RenderLine[] = [
      {
        line: current,
        index: idx,
        key: `${renderScopeKey.value}:${idx}-orig`,
        active: true,
        kind: 'primary',
      },
    ];
    if (next) {
      result.push({
        line: next,
        index: nextIndex,
        key: `${renderScopeKey.value}:${nextIndex}-orig`,
        active: false,
        kind: 'next',
      });
    }
    return result;
  }
  // 下一行预览关闭时，也预渲染下一行（视觉隐藏），切换时走 move 动画而非 enter/leave
  const result: RenderLine[] = [
    {
      line: current,
      index: idx,
      key: `${renderScopeKey.value}:${idx}-orig`,
      active: true,
      kind: 'primary',
    },
  ];
  if (next) {
    result.push({
      line: next,
      index: nextIndex,
      key: `${renderScopeKey.value}:${nextIndex}-orig`,
      active: false,
      kind: 'next',
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
    scrollIndex: visibleCurrentIndex.value,
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
    appearance: {
      playedColor: playedColor.value,
      unplayedColor: unplayedColor.value,
      fontFamily: fontFamily.value,
      fontScale: Math.max(0.1, localFontSize.value / 32),
      fontWeight: fontWeight.value,
      textShadow: lyricTextShadow.value,
      dropShadow: lyricDropShadow.value,
    },
  };
};

let lastLyricEffectHostDomKey = '';
const notifyLyricEffectHost = () => {
  const root = lyricEffectRootRef.value;
  const domKey = [
    currentIndex.value,
    visibleCurrentIndex.value,
    isPlaying.value ? 1 : 0,
    reducedMotion.value ? 1 : 0,
    lyricLayout.value,
  ].join(':');
  if (root && domKey !== lastLyricEffectHostDomKey) {
    lastLyricEffectHostDomKey = domKey;
    root.style.setProperty('--echo-lyric-current-index', String(currentIndex.value));
    root.style.setProperty('--echo-lyric-scroll-index', String(visibleCurrentIndex.value));
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
const isYrcLine = (line: LyricLinePayload) => (line.characters?.length ?? 0) > 0;
// 注音模式：音译逐字标注在主歌词每个字上方（需开启音译、开启注音模式且该行有注音配对时）
// 竖排布局下注音列无法正确排列，回退到普通副歌词行
const isRubyLine = (line: LyricLinePayload) => {
  if (isVerticalLayout.value) return false;
  const mode = lyricsMode.value;
  return (
    (mode === 'both' || mode === 'romanization') &&
    Boolean(settings.value?.showRomanizationAsRuby) &&
    (line.rubyUnits?.length ?? 0) > 0
  );
};

// 歌词行引用管理 (用于手动 DOM 补丁)
const lineRefs = new Map<string, HTMLElement>();
const contentRefs = new Map<string, HTMLElement>();
const resetLyricDomCache = () => {
  cachedYrcElements = [];
  cachedRubyElements = [];
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
  refreshTimelineState({ resetStable: true });
  syncManualDomAfterRender({ resetStable: true });
});

watch(lyricTimeOffset, () => {
  refreshTimelineState({ resetStable: true });
  syncManualDomAfterRender({ resetStable: true });
});

watch([renderLyricLines, lyricsMode, lyricLayout, isPlaying], () => {
  // 渲染行结构变化（注音/普通副歌词/逐字数据就绪等）时丢弃旧 DOM 缓存，
  // 避免同 key 行切换渲染分支后逐字填充作用在已脱离文档的旧节点上
  resetLyricDomCache();
  syncManualDomAfterRender({ resetStable: !isPlaying.value || isRecentLyricSeek() });
});

// 拖拽
type DesktopLyricDragSession = {
  pointerId: number;
  captureTarget: HTMLElement;
  startScreenX: number;
  startScreenY: number;
  latestScreenX: number;
  latestScreenY: number;
  startWindowX: number;
  startWindowY: number;
};

type DesktopLyricWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const dragState = reactive({
  isDragging: false,
  hasMoved: false,
});
let dragSession: DesktopLyricDragSession | null = null;
let dragAnimationFrame = 0;
let cachedWindowBounds: DesktopLyricWindowBounds | null = null;

const cacheWindowBounds = (bounds: DesktopLyricWindowBounds | null | undefined) => {
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  )
    return;
  cachedWindowBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
};

const cancelDragAnimationFrame = () => {
  if (!dragAnimationFrame) return;
  cancelAnimationFrame(dragAnimationFrame);
  dragAnimationFrame = 0;
};

const flushWindowDragPosition = () => {
  dragAnimationFrame = 0;
  const session = dragSession;
  if (!session || !dragState.hasMoved) return;
  const x = Math.round(session.startWindowX + (session.latestScreenX - session.startScreenX));
  const y = Math.round(session.startWindowY + (session.latestScreenY - session.startScreenY));
  cacheWindowBounds({
    x,
    y,
    width: cachedWindowBounds?.width ?? window.innerWidth,
    height: cachedWindowBounds?.height ?? window.innerHeight,
  });
  const width = cachedWindowBounds?.width ?? window.innerWidth;
  const height = cachedWindowBounds?.height ?? window.innerHeight;
  window.electron?.desktopLyric?.move(x, y, width, height);
};

const scheduleWindowDragPosition = () => {
  if (dragAnimationFrame) return;
  dragAnimationFrame = requestAnimationFrame(flushWindowDragPosition);
};

const updateWindowDragPointer = (event: PointerEvent) => {
  const session = dragSession;
  if (!session || event.pointerId !== session.pointerId) return false;
  session.latestScreenX = event.screenX;
  session.latestScreenY = event.screenY;
  if (
    !dragState.hasMoved &&
    (Math.abs(session.latestScreenX - session.startScreenX) > 3 ||
      Math.abs(session.latestScreenY - session.startScreenY) > 3)
  ) {
    dragState.hasMoved = true;
  }
  return true;
};

const removeWindowDragListeners = () => {
  document.removeEventListener('pointermove', onDocPointerMove);
  document.removeEventListener('pointerup', onDocPointerUp);
  document.removeEventListener('pointercancel', onDocPointerCancel);
  window.removeEventListener('blur', onWindowBlur);
};

const finishWindowDrag = (event?: PointerEvent, commitPosition = true) => {
  const session = dragSession;
  if (!session || (event && event.pointerId !== session.pointerId)) return;
  if (event) updateWindowDragPointer(event);
  cancelDragAnimationFrame();
  if (commitPosition) flushWindowDragPosition();

  const didMove = dragState.hasMoved;
  dragSession = null;
  dragState.isDragging = false;
  dragState.hasMoved = false;
  removeWindowDragListeners();
  try {
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }
  } catch {
    // pointer 可能已被系统取消或释放
  }
  if (didMove && commitPosition) {
    const endDragPromise = window.electron?.desktopLyric?.endDrag();
    if (endDragPromise) void endDragPromise.then(cacheWindowBounds).catch(() => undefined);
  }
};

function onDocPointerMove(event: PointerEvent) {
  if (!updateWindowDragPointer(event)) return;
  if (dragState.hasMoved) scheduleWindowDragPosition();
  event.preventDefault();
}

function onDocPointerUp(event: PointerEvent) {
  finishWindowDrag(event);
}

function onDocPointerCancel(event: PointerEvent) {
  finishWindowDrag(event);
}

function onWindowBlur() {
  finishWindowDrag();
}

const onDocPointerDown = (event: PointerEvent) => {
  if (isWayland || isLocked.value || event.button !== 0 || dragSession || resizeSession) return;
  const target = event.target as HTMLElement | null;
  if (!target || target.closest('.header, .menu-btn, .resize-handle')) return;

  // 初始化阶段会预取真实窗口位置。极端情况下预取失败，screen/client 坐标差仍能
  // 同步得到当前无边框窗口的左上角，保证快速点拖不依赖 IPC 往返。
  const startWindowX = cachedWindowBounds?.x ?? Math.round(event.screenX - event.clientX);
  const startWindowY = cachedWindowBounds?.y ?? Math.round(event.screenY - event.clientY);

  const session: DesktopLyricDragSession = {
    pointerId: event.pointerId,
    captureTarget: target,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    latestScreenX: event.screenX,
    latestScreenY: event.screenY,
    startWindowX,
    startWindowY,
  };
  dragSession = session;
  dragState.isDragging = true;
  dragState.hasMoved = false;
  document.addEventListener('pointermove', onDocPointerMove, { passive: false });
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerCancel);
  window.addEventListener('blur', onWindowBlur);
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    // capture 失败时 document 监听器仍可完成同一窗口内的拖动
  }
  event.preventDefault();
};

const isResizing = ref(false);
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
type DesktopLyricResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

type DesktopLyricResizeSession = {
  pointerId: number;
  captureTarget: HTMLElement;
  direction: DesktopLyricResizeDirection;
  startScreenX: number;
  startScreenY: number;
  latestScreenX: number;
  latestScreenY: number;
  startBounds: DesktopLyricWindowBounds;
};

const DESKTOP_LYRIC_MIN_WIDTH = 80;
const DESKTOP_LYRIC_MIN_HEIGHT = 80;
const resizeDirections: DesktopLyricResizeDirection[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
];
let resizeSession: DesktopLyricResizeSession | null = null;
let resizeAnimationFrame = 0;

const getResizedWindowBounds = (session: DesktopLyricResizeSession) => {
  const dx = session.latestScreenX - session.startScreenX;
  const dy = session.latestScreenY - session.startScreenY;
  const resizeWest = session.direction.includes('w');
  const resizeEast = session.direction.includes('e');
  const resizeNorth = session.direction.includes('n');
  const resizeSouth = session.direction.includes('s');
  let { x, y, width, height } = session.startBounds;

  if (resizeWest) {
    width = Math.max(DESKTOP_LYRIC_MIN_WIDTH, session.startBounds.width - dx);
    x = session.startBounds.x + session.startBounds.width - width;
  } else if (resizeEast) {
    width = Math.max(DESKTOP_LYRIC_MIN_WIDTH, session.startBounds.width + dx);
  }
  if (resizeNorth) {
    height = Math.max(DESKTOP_LYRIC_MIN_HEIGHT, session.startBounds.height - dy);
    y = session.startBounds.y + session.startBounds.height - height;
  } else if (resizeSouth) {
    height = Math.max(DESKTOP_LYRIC_MIN_HEIGHT, session.startBounds.height + dy);
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
};

const flushWindowResize = () => {
  resizeAnimationFrame = 0;
  if (!resizeSession) return;
  const bounds = getResizedWindowBounds(resizeSession);
  cacheWindowBounds(bounds);
  window.electron?.desktopLyric?.resize(bounds);
};

const scheduleWindowResize = () => {
  if (resizeAnimationFrame) return;
  resizeAnimationFrame = requestAnimationFrame(flushWindowResize);
};

const updateWindowResizePointer = (event: PointerEvent) => {
  if (!resizeSession || event.pointerId !== resizeSession.pointerId) return false;
  resizeSession.latestScreenX = event.screenX;
  resizeSession.latestScreenY = event.screenY;
  return true;
};

const removeWindowResizeListeners = () => {
  document.removeEventListener('pointermove', onResizePointerMove);
  document.removeEventListener('pointerup', onResizePointerUp);
  document.removeEventListener('pointercancel', onResizePointerCancel);
  window.removeEventListener('blur', onResizeWindowBlur);
};

const finishWindowResize = (event?: PointerEvent, commitBounds = true) => {
  const session = resizeSession;
  if (!session || (event && event.pointerId !== session.pointerId)) return;
  if (event) updateWindowResizePointer(event);
  if (resizeAnimationFrame) {
    cancelAnimationFrame(resizeAnimationFrame);
    resizeAnimationFrame = 0;
  }
  if (commitBounds) flushWindowResize();
  resizeSession = null;
  isResizing.value = false;
  removeWindowResizeListeners();
  try {
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId);
    }
  } catch {
    // pointer 可能已被系统取消或释放
  }
  if (commitBounds) {
    const endResizePromise = window.electron?.desktopLyric?.endDrag();
    if (endResizePromise) void endResizePromise.then(cacheWindowBounds).catch(() => undefined);
  }
};

function onResizePointerMove(event: PointerEvent) {
  if (!updateWindowResizePointer(event)) return;
  scheduleWindowResize();
  event.preventDefault();
}

function onResizePointerUp(event: PointerEvent) {
  finishWindowResize(event);
}

function onResizePointerCancel(event: PointerEvent) {
  finishWindowResize(event);
}

function onResizeWindowBlur() {
  finishWindowResize();
}

const onResizePointerDown = (event: PointerEvent, direction: DesktopLyricResizeDirection) => {
  if (isWayland || isLocked.value || event.button !== 0 || resizeSession || dragSession) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }

  resizeSession = {
    pointerId: event.pointerId,
    captureTarget: target,
    direction,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    latestScreenX: event.screenX,
    latestScreenY: event.screenY,
    startBounds: {
      x: Math.round(event.screenX - event.clientX),
      y: Math.round(event.screenY - event.clientY),
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    },
  };
  isResizing.value = true;
  isHovered.value = true;
  document.addEventListener('pointermove', onResizePointerMove, { passive: false });
  document.addEventListener('pointerup', onResizePointerUp);
  document.addEventListener('pointercancel', onResizePointerCancel);
  window.addEventListener('blur', onResizeWindowBlur);
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    // capture 失败时 document 监听器仍可完成缩放
  }
  event.preventDefault();
};

// 字体大小随窗口变化

const { height: winHeight, width: winWidth } = useWindowSize();

let lastUnlockButtonBoundsKey: string | null = null;
const syncUnlockButtonBounds = () => {
  void nextTick(() => {
    const element = lockButtonRef.value;
    if (isWayland || !showUnlockButton.value || !element) {
      if (lastUnlockButtonBoundsKey !== null) {
        lastUnlockButtonBoundsKey = null;
        window.electron?.desktopLyric?.setUnlockButtonBounds(null);
      }
      return;
    }
    const rect = element.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    if (key === lastUnlockButtonBoundsKey) return;
    lastUnlockButtonBoundsKey = key;
    window.electron?.desktopLyric?.setUnlockButtonBounds(bounds);
  });
};

watch([winWidth, winHeight, showUnlockButton, isLocked, lyricLayout], syncUnlockButtonBounds, {
  flush: 'post',
});

// 检测窗口大小变化（调整大小）
watch([winWidth, winHeight], ([w, h], [oldW, oldH]) => {
  if (
    !dragState.isDragging &&
    !resizeSession &&
    cachedWindowBounds &&
    Number.isFinite(w) &&
    Number.isFinite(h)
  ) {
    cachedWindowBounds = {
      ...cachedWindowBounds,
      width: Math.round(w),
      height: Math.round(h),
    };
  }
  if (dragState.isDragging) return;
  if (resizeSession) return;
  // 检测是否在调整大小
  if (oldW !== undefined && oldH !== undefined && (w !== oldW || h !== oldH)) {
    isResizing.value = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      isResizing.value = false;
    }, 300);
  }
});

// 本地字体大小
const localFontSize = ref(30);

const computedFontSize = computed(() => {
  const vertical = isVerticalLayout.value;
  const base = (() => {
    if (vertical) {
      const w = Math.round(Number(winWidth.value ?? 0));
      const minW = 120;
      const maxW = 520;
      const minF = 20;
      const maxF = 64;
      if (!Number.isFinite(w) || w <= minW) return minF;
      if (w >= maxW) return maxF;
      return Math.round(minF + ((w - minW) / (maxW - minW)) * (maxF - minF));
    }
    const h = Math.round(Number(winHeight.value ?? 0));
    const minH = 140;
    const maxH = 360;
    const minF = 20;
    const maxF = 96;
    if (!Number.isFinite(h) || h <= minH) return minF;
    if (h >= maxH) return maxF;
    return Math.round(minF + ((h - minH) / (maxH - minH)) * (maxF - minF));
  })();
  // 内容实际占用的视觉行数：主行 1 行 + 每条副歌词 1 行 + 注音模式主行额外占 1 行（读音+原词）
  if (!vertical) {
    const lines = renderLyricLines.value;
    const secondaryCount = lines.filter((line) => line.kind === 'secondary').length;
    const rubyActive = Boolean(lines[0]?.active && isRubyLine(lines[0].line));
    if (1 + secondaryCount + (rubyActive ? 1 : 0) >= 3) {
      return Math.max(16, Math.round(base * 0.7));
    }
  }
  return base;
});

// 窗口尺寸单向决定字体大小。不要再把字体大小反写为窗口高度，否则 Windows
// DPI 舍入会形成“高度 → 字号 → 高度”的反馈环，拖动时窗口会缓慢变大。
watch(computedFontSize, (size) => {
  if (!Number.isFinite(size) || dragState.isDragging) return;
  if (Math.abs(localFontSize.value - size) > 1) {
    localFontSize.value = size;
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
  lyricTimeline.sync(getTimelinePlayback(), force);
  refreshTimelineState({ resetStable: force || !isPlaying.value || isRecentLyricSeek() });
};

// ── 生命周期 ──

onMounted(async () => {
  document.documentElement.classList.add('desktop-lyric-window');
  document.body.classList.add('desktop-lyric-window');
  document.getElementById('app')?.classList.add('desktop-lyric-window');

  const desktopLyricApi = window.electron?.desktopLyric;
  const initialBoundsPromise = desktopLyricApi?.getWindow().catch(() => null);
  snapshot.value = (await desktopLyricApi?.getSnapshot()) ?? null;
  syncUnlockButtonBounds();
  cacheWindowBounds(await initialBoundsPromise);
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
      // settings/lyrics-only patch 不改变播放循环状态；只有全量快照或明确的
      // playback patch 才切换 RAF。
      if (isDesktopLyricFullSnapshot(message) || message.playback !== undefined) {
        if (next.playback?.isPlaying) {
          resumeSeek();
        } else {
          pauseSeek();
          syncManualDomAfterRender();
        }
      }
      notifyLyricEffectHost();
    }) ?? null;

  const applyHoverState = (hovered: boolean) => {
    if (!isLocked.value) {
      isHovered.value = hovered;
      return;
    }
    isHovered.value = canShowUnlockButton.value && hovered;
  };

  // 先订阅增量变化，再查询一次当前状态；轮询无需在状态未变化时重复发 IPC。
  let hoverEventRevision = 0;
  disposeHoverListener =
    desktopLyricApi?.onHover((hovered) => {
      hoverEventRevision += 1;
      applyHoverState(hovered);
    }) ?? null;
  const initialHoverRevision = hoverEventRevision;
  void desktopLyricApi
    ?.getHover()
    .then((hovered) => {
      // 查询响应在后续 hover 事件之后到达时，不用旧快照覆盖新状态。
      if (hoverEventRevision === initialHoverRevision) applyHoverState(hovered);
    })
    .catch(() => undefined);

  // 启动 RAF
  if (isPlaying.value) {
    resumeSeek();
  } else {
    pauseSeek();
  }

  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseleave', handleMouseLeave);
  window.addEventListener('blur', handleWindowBlur);
});

onBeforeUnmount(() => {
  pauseSeek();
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  isResizing.value = false;
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseleave', handleMouseLeave);
  window.removeEventListener('blur', handleWindowBlur);
  reducedMotionQuery?.removeEventListener?.('change', updateReducedMotion);
  reducedMotionQuery = null;
  lyricEffectHostRegistration?.dispose();
  lyricEffectHostRegistration = null;
  lastLyricEffectHostDomKey = '';
  finishWindowDrag(undefined, false);
  finishWindowResize(undefined, false);
  document.documentElement.classList.remove('desktop-lyric-window');
  document.body.classList.remove('desktop-lyric-window');
  document.getElementById('app')?.classList.remove('desktop-lyric-window');
  disposeSnapshotListener?.();
  disposeHoverListener?.();
  window.electron?.desktopLyric?.setUnlockButtonBounds(null);
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
    <template v-if="!isWayland && !isLocked">
      <div
        v-for="direction in resizeDirections"
        :key="direction"
        class="resize-handle"
        :data-direction="direction"
        aria-hidden="true"
        @pointerdown.stop="onResizePointerDown($event, direction)"
      ></div>
    </template>

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
        <button
          v-if="!isLocked || canShowUnlockButton"
          ref="lockButtonRef"
          class="menu-btn lock-btn"
          @click.stop="toggleLyricLock"
        >
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
      :data-echo-lyric-scroll-index="visibleCurrentIndex"
    >
      <div
        v-for="(line, index) in renderLyricLines"
        :key="line.key"
        :class="[
          'lyric-line',
          {
            active: line.active,
            'is-yrc': (line.active || line.karaoke) && isYrcLine(line.line),
            'is-next': line.kind === 'next' && showNextLinePreview,
            'is-hidden-next': line.kind === 'next' && !showNextLinePreview,
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
          fontSize: line.kind === 'secondary' ? '0.72em' : index > 0 ? '0.8em' : '1em',
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
        <!-- 注音模式：音译逐字标注在每个字上方（仅当前行，卡拉OK 填充按注音单元时间轴） -->
        <template v-if="line.active && isRubyLine(line.line)">
          <span class="scroll-content" :ref="(el) => setContentRef(el, line.key)">
            <span
              class="content"
              data-echo-lyric-line
              data-echo-lyric-primary
              :data-echo-lyric-current="line.active ? 'true' : 'false'"
            >
              <span
                v-for="(unit, ui) in line.line.rubyUnits"
                :key="ui"
                class="ruby-unit"
                data-echo-lyric-ruby-unit
              >
                <span class="ruby-text" data-echo-lyric-secondary-kind="romanized">
                  <span
                    v-if="unit.ruby"
                    class="ruby-word"
                    data-echo-lyric-char
                    :data-echo-lyric-char-index="ui"
                    :style="{
                      backgroundImage: `linear-gradient(${isVerticalLayout ? 'to bottom' : 'to right'}, ${playedColor} 50%, ${unplayedColor} 50%)`,
                      backgroundSize: isVerticalLayout ? '100% 200%' : '200% 100%',
                      textShadow: 'none',
                      filter: lyricDropShadow,
                    }"
                    >{{ unit.ruby }}</span
                  >
                </span>
                <span class="ruby-base">
                  <span
                    v-for="(char, ci) in unit.chars"
                    :key="ci"
                    :class="{
                      'content-text': true,
                      'end-with-space': char.text.endsWith(' ') || char.startTime === 0,
                    }"
                  >
                    <span
                      class="word"
                      data-echo-lyric-char
                      :data-echo-lyric-char-index="unit.charStart + ci"
                      :style="{
                        backgroundImage: `linear-gradient(${isVerticalLayout ? 'to bottom' : 'to right'}, ${playedColor} 50%, ${unplayedColor} 50%)`,
                        backgroundSize: isVerticalLayout ? '100% 200%' : '200% 100%',
                        textShadow: 'none',
                        filter: lyricDropShadow,
                      }"
                      >{{ char.text }}</span
                    >
                  </span>
                </span>
              </span>
            </span>
          </span>
        </template>
        <!-- 逐字歌词 (如果存在逐字数据则始终渲染 YRC 结构，以便手动补丁 DOM) -->
        <template v-else-if="isYrcLine(line.line)">
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
                    line.active || line.karaoke
                      ? {
                          backgroundImage: `linear-gradient(${isVerticalLayout ? 'to bottom' : 'to right'}, ${playedColor} 50%, ${unplayedColor} 50%)`,
                          backgroundSize: isVerticalLayout ? '100% 200%' : '200% 100%',
                          textShadow: 'none',
                          filter: lyricDropShadow,
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

/* 透明无边框窗口使用内侧缩放热区，鼠标无需移出窗口。 */
.resize-handle {
  position: absolute;
  z-index: 10;
  touch-action: none;
}

.resize-handle[data-direction='n'],
.resize-handle[data-direction='s'] {
  right: 12px;
  left: 12px;
  height: 8px;
  cursor: ns-resize;
}

.resize-handle[data-direction='n'] {
  top: 0;
}

.resize-handle[data-direction='s'] {
  bottom: 0;
}

.resize-handle[data-direction='e'],
.resize-handle[data-direction='w'] {
  top: 12px;
  bottom: 12px;
  width: 8px;
  cursor: ew-resize;
}

.resize-handle[data-direction='e'] {
  right: 0;
}

.resize-handle[data-direction='w'] {
  left: 0;
}

.resize-handle[data-direction='ne'],
.resize-handle[data-direction='se'],
.resize-handle[data-direction='sw'],
.resize-handle[data-direction='nw'] {
  width: 14px;
  height: 14px;
}

.resize-handle[data-direction='ne'] {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.resize-handle[data-direction='se'] {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.resize-handle[data-direction='sw'] {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.resize-handle[data-direction='nw'] {
  top: 0;
  left: 0;
  cursor: nwse-resize;
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
  app-region: drag;
  -webkit-app-region: drag;
}

.desktop-lyric.is-wayland .header,
.desktop-lyric.is-wayland .menu-btn {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.lyric-line {
  position: absolute;
  width: 100%;
  left: 0;
  line-height: 1.24;
  padding: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    top 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    font-size 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.18s ease,
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
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
    right 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    font-size 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.18s ease,
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: center top;
}

/* 单行模式：隐藏预渲染的下一行，不占视觉空间 */
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

/* 注音标注（音译显示在每个字上方，类似汉字注音 / 日文振假名） */
.lyric-line.is-yrc .ruby-unit {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  white-space: nowrap;
}
.lyric-line.is-yrc .ruby-text {
  display: block;
  line-height: 1.1;
  padding: 0 0.06em;
  font-size: 0.68em;
  opacity: 0.72;
  /* 即使该单元没有读音也占位，保证同一行内基线对齐 */
  min-height: 1.1em;
  /* 保留读音内部的音节空格 */
  white-space: pre;
}
.lyric-line.is-yrc .ruby-base {
  display: block;
  line-height: 1.24;
  /* 保留原词中的空格（flex 列内单独的空格会被折叠） */
  white-space: pre;
}
.lyric-line.is-yrc .ruby-unit .ruby-word {
  display: inline-block;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
  will-change: background-position-x;
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
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.18s ease;
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
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.18s ease;
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
.desktop-lyric.locked .lyric-container {
  app-region: no-drag;
  -webkit-app-region: no-drag;
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
