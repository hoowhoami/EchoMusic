<script setup lang="ts">
import {
  computed,
  ref,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
  type ComponentPublicInstance,
} from 'vue';
import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useLyricScroll } from './composables/useLyricScroll';
import { useYrcAnimation } from './composables/useYrcAnimation';
import { formatDuration } from '@/utils/format';
import { buildFilteredLyricEntries, resolveVisibleLyricIndex } from '@/utils/lyricFilter';
import { iconPlay } from '@/icons';
import {
  getPluginLyricEffectClassNames,
  getPluginLyricEffectSummary,
  registerPluginLyricEffectHost,
  type PluginLyricEffectSnapshot,
} from '@/plugins/lyricEffects';

interface Props {
  collapsed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  collapsed: false,
});

const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();

const lyricEffectRootRef = ref<HTMLElement | null>(null);
const lyricListRef = ref<HTMLElement | null>(null);
const lyricEffectOverlayRef = ref<HTMLElement | null>(null);
const scrollTargetIndex = ref(-1);
const reducedMotion = ref(false);
let lyricEffectHostRegistration: ReturnType<typeof registerPluginLyricEffectHost> | null = null;
let reducedMotionQuery: MediaQueryList | null = null;

const collapsedRef = computed(() => props.collapsed);

// 主歌词页只提前滚动，不提前切换当前行，避免逐字进度听起来抢拍。
const LYRIC_SCROLL_LOOKAHEAD_MS = 100;

const lyricFilterConfig = computed(() => ({
  enabled: settingStore.lyricFilterEnabled,
  pattern: settingStore.lyricFilterPattern,
}));

const resolveVisibleIndex = (idx: number) =>
  resolveVisibleLyricIndex(lyricStore.lines, idx, lyricFilterConfig.value);

const currentIndex = computed(() => resolveVisibleIndex(lyricStore.currentIndex));
const lyricEffectCurrentIndex = ref(currentIndex.value);
const scrollIndex = computed(() => {
  const index = resolveVisibleIndex(scrollTargetIndex.value);
  return index >= 0 ? index : currentIndex.value;
});
const { scrollHighlightIndex, scrollToLine, handleWheel, dispose } = useLyricScroll(
  () => lyricListRef.value,
  collapsedRef,
  scrollIndex,
);

const {
  getNowMs,
  getLyricTimelineMs,
  updateYrcDom,
  syncSeekAnchor,
  registerMainChar,
  registerSubChar,
  resetCharRegistry,
} = useYrcAnimation(currentIndex);

type CharRefEl = Element | ComponentPublicInstance | null;
const toHtmlEl = (el: CharRefEl): HTMLElement | null => (el instanceof HTMLElement ? el : null);

const effectivePlayedColor = computed(() => lyricStore.effectivePlayedColor);
const effectiveUnplayedColor = computed(() => lyricStore.effectiveUnplayedColor);
const hasLyrics = computed(() => lyricStore.lines.length > 0);
const staticLyricLines = computed(() =>
  lyricStore.rawLyric
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\[\d+:\d+(?:\.\d+)?\]/, '')
        .replace(/^\[\d+,\d+\]/, '')
        .trim(),
    )
    .filter((line) => {
      if (!line) return false;
      return !/^\[(?:id|ar|ti|al|by|offset|hash|language|kana):/i.test(line);
    }),
);
const hasStaticLyrics = computed(
  () => !hasLyrics.value && !lyricStore.isLoading && staticLyricLines.value.length > 0,
);
const titleFontSize = computed(() => `${1.5 * lyricStore.fontScale}rem`);
const secondaryFontSize = computed(() => `${1.2 * lyricStore.fontScale}rem`);
const secondaryFontWeight = computed(() => String(Math.max(500, lyricStore.fontWeightValue - 200)));
const lyricFontFamily = computed(() => settingStore.buildLyricFontFamily());
// 逐字渐变背景（已播色 → 未播色）
const activeYrcBgStyle = computed(
  () =>
    `linear-gradient(to right, ${effectivePlayedColor.value} 50%, ${effectiveUnplayedColor.value} 50%)`,
);

const isYrcLine = (line: { characters: unknown[] }) => (line.characters?.length ?? 0) > 1;

const handleLineClick = (time: number) => {
  playerStore.seek(time);
  if (!playerStore.isPlaying) {
    playerStore.togglePlay();
  }
  // seek 后立即更新当前行索引并滚动到对应位置
  nextTick(() => {
    lyricStore.updateCurrentIndex(time);
    scrollTargetIndex.value = lyricStore.findIndexAtTimeMs(
      Math.round(time * 1000) + lyricStore.currentTimeOffset + LYRIC_SCROLL_LOOKAHEAD_MS,
    );
    scrollToLine(scrollIndex.value, true);
  });
};

const handleLyricWheel = () => {
  handleWheel();
};

const lyricEntries = computed(() =>
  buildFilteredLyricEntries(lyricStore.lines, lyricFilterConfig.value).map((entry) => {
    const { line, index, filtered } = entry;
    const distance = lyricEffectCurrentIndex.value >= 0 ? index - lyricEffectCurrentIndex.value : 0;
    const scrollDistance = scrollIndex.value >= 0 ? index - scrollIndex.value : distance;
    return {
      line,
      index,
      distance,
      absDistance: Math.abs(distance),
      scrollDistance,
      filtered,
    };
  }),
);

const lyricEffectClassName = computed(() => getPluginLyricEffectClassNames('page').join(' '));
const lyricEffectSummary = computed(() => getPluginLyricEffectSummary('page'));

const getLineStartMs = (line: (typeof lyricStore.lines)[number]) =>
  line.characters?.[0]?.startTime ?? Math.round((Number(line.time) || 0) * 1000);

let lastStableLyricIndex = -1;
let lastStableLyricTime = 0;

const resolveLyricEffectCurrentIndex = (timelineMs: number) => {
  let index = currentIndex.value;
  const time = timelineMs / 1000;

  // Filter out playback jitter: if the index jumped backward by <= 2 lines
  // and time hasn't regressed significantly, keep the previous stable index.
  // This prevents the lyric effect from briefly highlighting the wrong line.
  if (
    lastStableLyricIndex >= 0 &&
    index >= 0 &&
    index < lastStableLyricIndex &&
    lastStableLyricIndex - index <= 2 &&
    time >= lastStableLyricTime - 0.35
  ) {
    index = lastStableLyricIndex;
  } else {
    lastStableLyricIndex = index;
  }
  lastStableLyricTime = time;

  if (lyricEffectCurrentIndex.value !== index) {
    lyricEffectCurrentIndex.value = index;
  }

  return index;
};

const buildLyricEffectSnapshot = (): PluginLyricEffectSnapshot => {
  const timelineMs = getLyricTimelineMs(0);
  const index = resolveLyricEffectCurrentIndex(timelineMs);
  const time = Math.max(0, (timelineMs - lyricStore.currentTimeOffset) / 1000);

  return {
    scope: 'page',
    lines: lyricStore.lines,
    currentIndex: index,
    scrollIndex: scrollIndex.value,
    currentLine: index >= 0 ? (lyricStore.lines[index] ?? null) : null,
    currentTime: time,
    duration: playerStore.duration,
    playbackRate: playerStore.playbackRate,
    isPlaying: playerStore.isPlaying,
    timelineMs,
    lyricOffsetMs: lyricStore.currentTimeOffset,
    lyricsMode: lyricStore.lyricsMode,
    collapsed: props.collapsed,
    hasLyrics: hasLyrics.value,
    reducedMotion: reducedMotion.value,
    appearance: {
      playedColor: effectivePlayedColor.value,
      unplayedColor: effectiveUnplayedColor.value,
      fontFamily: lyricFontFamily.value,
      fontScale: lyricStore.fontScale,
      fontWeight: lyricStore.fontWeightValue,
    },
  };
};

// 上次写入歌词特效根元素的离散状态，避免每帧重复写 DOM 触发整片歌词区重绘（内存泄漏根因）。
const lastEffectRootState = {
  currentIndex: Number.NaN,
  scrollIndex: Number.NaN,
  playing: '',
  collapsed: '',
  reducedMotion: '',
};

const syncLyricEffectLineCurrentState = (root: HTMLElement, index: number) => {
  const rows = root.querySelectorAll<HTMLElement>('[data-echo-lyric-row][data-echo-lyric-index]');
  rows.forEach((row) => {
    const rowIndex = Number(row.dataset.echoLyricIndex);
    const isCurrent = Number.isFinite(rowIndex) && rowIndex === index;
    const value = isCurrent ? 'true' : 'false';
    const distance = index >= 0 && Number.isFinite(rowIndex) ? rowIndex - index : 0;

    row.dataset.echoLyricCurrent = value;
    row.dataset.echoLyricDistance = String(distance);
    row.dataset.echoLyricAbsDistance = String(Math.abs(distance));
    row.style.setProperty('--echo-lyric-distance', String(distance));
    row.style.setProperty('--echo-lyric-abs-distance', String(Math.abs(distance)));

    row.querySelectorAll<HTMLElement>('[data-echo-lyric-line]').forEach((line) => {
      line.dataset.echoLyricCurrent = value;
    });
  });
};

// 同步歌词特效根元素状态。
// 注意：timelineMs / currentTime / playbackRate 等每帧变化的高频数据「不再写成 CSS 变量」，
// 因为把它们逐帧写到带 mask-image/isolation/contain 的歌词根上会触发整片歌词区重绘，
// 渲染进程光栅缓存持续堆积导致内存泄漏。插件统一通过 host.subscribe 的快照获取这些数据
// （PluginLyricEffectSnapshot 已包含 timelineMs/currentTime/playbackRate）。
// 这里只写「离散、低频」状态，且仅在值真正变化时才写，确保稳定播放时每帧零 DOM 写入。
const syncLyricEffectRootState = (snapshot: PluginLyricEffectSnapshot) => {
  const root = lyricEffectRootRef.value;
  if (!root) return;

  if (lastEffectRootState.currentIndex !== snapshot.currentIndex) {
    lastEffectRootState.currentIndex = snapshot.currentIndex;
    root.style.setProperty('--echo-lyric-current-index', String(snapshot.currentIndex));
    lyricListRef.value?.setAttribute(
      'data-echo-lyric-current-index',
      String(snapshot.currentIndex),
    );
    syncLyricEffectLineCurrentState(root, snapshot.currentIndex);
  }
  if (lastEffectRootState.scrollIndex !== scrollIndex.value) {
    lastEffectRootState.scrollIndex = scrollIndex.value;
    root.style.setProperty('--echo-lyric-scroll-index', String(scrollIndex.value));
  }

  const playing = playerStore.isPlaying ? 'true' : 'false';
  if (lastEffectRootState.playing !== playing) {
    lastEffectRootState.playing = playing;
    root.dataset.echoLyricPlaying = playing;
  }
  const collapsed = props.collapsed ? 'true' : 'false';
  if (lastEffectRootState.collapsed !== collapsed) {
    lastEffectRootState.collapsed = collapsed;
    root.dataset.echoLyricCollapsed = collapsed;
  }
  const reduced = reducedMotion.value ? 'true' : 'false';
  if (lastEffectRootState.reducedMotion !== reduced) {
    lastEffectRootState.reducedMotion = reduced;
    root.dataset.echoLyricReducedMotion = reduced;
  }
};

const notifyLyricEffectHost = () => {
  const snapshot = buildLyricEffectSnapshot();
  syncLyricEffectRootState(snapshot);
  lyricEffectHostRegistration?.notify(snapshot);
};

const setupLyricEffectHost = () => {
  if (lyricEffectHostRegistration) return;
  const root = lyricEffectRootRef.value;
  const scroller = lyricListRef.value;
  const overlay = lyricEffectOverlayRef.value;
  if (!root || !scroller || !overlay) return;

  lyricEffectHostRegistration = registerPluginLyricEffectHost({
    scope: 'page',
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

const refreshLyricIndexes = () => {
  lyricStore.updateCurrentIndex(getNowMs() / 1000);
  scrollTargetIndex.value = lyricStore.findIndexAtTimeMs(
    getLyricTimelineMs(LYRIC_SCROLL_LOOKAHEAD_MS),
  );
  notifyLyricEffectHost();
};

// 逐字歌词 RAF 更新
let rafId: number | null = null;
let lastRafTime = 0;

const rafLoop = () => {
  rafId = requestAnimationFrame((timestamp) => {
    if (timestamp - lastRafTime >= 33) {
      lastRafTime = timestamp;
      refreshLyricIndexes();
      updateYrcDom();
    }
    rafLoop();
  });
};

const startRaf = () => {
  if (rafId !== null) return;
  lastRafTime = performance.now();
  rafLoop();
};

const stopRaf = () => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
};

watch(
  () => playerStore.isPlaying,
  (playing) => {
    syncSeekAnchor();
    refreshLyricIndexes();
    if (playing) startRaf();
    else stopRaf();
  },
);

watch(
  () => playerStore.currentTime,
  () => {
    syncSeekAnchor();
    refreshLyricIndexes();
    updateYrcDom();
  },
);

watch(
  currentIndex,
  () => {
    updateYrcDom();
    notifyLyricEffectHost();
  },
  { flush: 'sync' },
);

onMounted(() => {
  reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  updateReducedMotion();
  reducedMotionQuery?.addEventListener?.('change', updateReducedMotion);
  syncSeekAnchor();
  refreshLyricIndexes();
  if (playerStore.isPlaying) startRaf();
  nextTick(() => {
    setupLyricEffectHost();
    scrollToLine(scrollIndex.value, false);
  });
});

onUnmounted(() => {
  stopRaf();
  dispose();
  lyricEffectHostRegistration?.dispose();
  lyricEffectHostRegistration = null;
  reducedMotionQuery?.removeEventListener?.('change', updateReducedMotion);
  reducedMotionQuery = null;
});

// 收起/展开时重新定位（瞬间跳转，不用动画）
watch(
  () => props.collapsed,
  (collapsed) => {
    nextTick(() => {
      scrollToLine(scrollIndex.value, false, collapsed);
      notifyLyricEffectHost();
    });
  },
);

watch(
  () => lyricStore.lyricsMode,
  async () => {
    await nextTick();
    scrollToLine(scrollIndex.value, false);
    notifyLyricEffectHost();
  },
);

watch(
  () => lyricStore.currentTimeOffset,
  async () => {
    refreshLyricIndexes();
    await nextTick();
    updateYrcDom();
    notifyLyricEffectHost();
    scrollToLine(scrollIndex.value, false, props.collapsed);
  },
);

watch(
  () => [lyricStore.loadedHash, lyricStore.lines.length],
  async () => {
    resetCharRegistry();
    refreshLyricIndexes();
    await nextTick();
    updateYrcDom();
    notifyLyricEffectHost();
    scrollToLine(scrollIndex.value, false, props.collapsed);
  },
);
</script>

<template>
  <div
    ref="lyricEffectRootRef"
    class="lyric-scroller-wrap echo-lyric-effect-host"
    :class="lyricEffectClassName"
    data-echo-lyric-host="page"
    :data-echo-lyric-effect-count="lyricEffectSummary.count"
    :data-echo-lyric-effect-decorator="lyricEffectSummary.hasDecorator ? 'true' : 'false'"
  >
    <div
      ref="lyricListRef"
      class="lyric-scroller"
      :class="{ 'is-collapsed': props.collapsed }"
      :style="{ fontFamily: lyricFontFamily }"
      data-echo-lyric-scroller="page"
      :data-echo-lyric-current-index="lyricEffectCurrentIndex"
      :data-echo-lyric-scroll-index="scrollIndex"
      @wheel.passive="handleLyricWheel"
    >
      <template v-if="hasLyrics">
        <div
          :style="{
            paddingTop: props.collapsed ? '60vh' : '40vh',
            paddingBottom: props.collapsed ? '10px' : '40vh',
          }"
        >
          <div
            v-for="entry in lyricEntries"
            :key="`${entry.index}-${entry.line.time}`"
            :hidden="entry.filtered"
            class="lyric-row"
            :data-lyric-index="entry.index"
            data-echo-lyric-row
            :data-echo-lyric-index="entry.index"
            :data-echo-lyric-current="lyricEffectCurrentIndex === entry.index ? 'true' : 'false'"
            :data-echo-lyric-filtered="entry.filtered ? 'true' : 'false'"
            :data-echo-lyric-distance="entry.distance"
            :data-echo-lyric-abs-distance="entry.absDistance"
            :data-echo-lyric-scroll-distance="entry.scrollDistance"
            :style="{
              '--echo-lyric-index': String(entry.index),
              '--echo-lyric-line-start-ms': String(getLineStartMs(entry.line)),
              '--echo-lyric-distance': String(entry.distance),
              '--echo-lyric-abs-distance': String(entry.absDistance),
              '--echo-lyric-scroll-distance': String(entry.scrollDistance),
              paddingTop: props.collapsed ? '3px' : '16px',
              paddingBottom: props.collapsed ? '3px' : '16px',
              opacity: props.collapsed
                ? entry.index === currentIndex || entry.index === currentIndex + 1
                  ? 1
                  : 0
                : undefined,
              transition: 'opacity 0.5s cubic-bezier(0.4,0,0.2,1)',
            }"
          >
            <div
              :class="[
                'lyric-line',
                currentIndex === entry.index ? 'is-current' : 'is-idle',
                scrollHighlightIndex === entry.index ? 'is-scroll-highlight' : '',
              ]"
              data-echo-lyric-line
              :data-echo-lyric-index="entry.index"
              :data-echo-lyric-current="lyricEffectCurrentIndex === entry.index ? 'true' : 'false'"
              :data-echo-lyric-scroll-highlight="
                scrollHighlightIndex === entry.index ? 'true' : 'false'
              "
              @dblclick.prevent.stop="handleLineClick(entry.line.time)"
            >
              <!-- 主歌词 -->
              <span
                class="block leading-[1.24] tracking-[0.01em]"
                data-echo-lyric-primary
                :style="{
                  fontSize: titleFontSize,
                  fontWeight: String(lyricStore.fontWeightValue),
                }"
              >
                <!-- 逐字歌词 -->
                <template v-if="isYrcLine(entry.line)">
                  <span class="lyric-yrc-line-wrap">
                    <span
                      v-for="(char, ci) in entry.line.characters"
                      :key="ci"
                      :ref="(el) => registerMainChar(entry.index, ci, toHtmlEl(el))"
                      class="lyric-yrc-char"
                      data-echo-lyric-char
                      :data-echo-lyric-char-index="ci"
                      :style="{
                        backgroundImage: activeYrcBgStyle,
                      }"
                      >{{ char.text }}</span
                    >
                  </span>
                </template>
                <!-- 普通歌词 -->
                <template v-else>
                  <span
                    :style="{
                      color:
                        currentIndex === entry.index
                          ? effectivePlayedColor
                          : effectiveUnplayedColor,
                    }"
                    >{{ entry.line.text }}</span
                  >
                </template>
              </span>

              <!-- 音译/翻译 -->
              <template v-if="lyricStore.lyricsMode === 'both' && lyricStore.secondaryEnabled">
                <span
                  v-if="entry.line.romanized?.trim()"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  data-echo-lyric-secondary
                  data-echo-lyric-secondary-kind="romanized"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: secondaryFontWeight,
                    color:
                      currentIndex === entry.index && !isYrcLine(entry.line)
                        ? effectivePlayedColor
                        : effectiveUnplayedColor,
                    opacity: 0.7,
                  }"
                >
                  <!-- 音译逐字高亮 -->
                  <template
                    v-if="
                      isYrcLine(entry.line) &&
                      entry.line.romanizedCharacters &&
                      entry.line.romanizedCharacters.length > 1
                    "
                  >
                    <span class="lyric-yrc-sub-wrap">
                      <span
                        v-for="(char, ci) in entry.line.romanizedCharacters"
                        :key="ci"
                        :ref="(el) => registerSubChar(entry.index, 'romanized', ci, toHtmlEl(el))"
                        class="lyric-yrc-sub-char"
                        data-echo-lyric-char
                        :data-echo-lyric-char-index="ci"
                        data-echo-lyric-secondary-kind="romanized"
                        :style="{
                          backgroundImage: activeYrcBgStyle,
                        }"
                        >{{ char.text }}</span
                      >
                    </span>
                  </template>
                  <template v-else>
                    {{ entry.line.romanized.trim() }}
                  </template>
                </span>
                <span
                  v-if="entry.line.translated?.trim()"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  data-echo-lyric-secondary
                  data-echo-lyric-secondary-kind="translated"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: secondaryFontWeight,
                    color:
                      currentIndex === entry.index && !isYrcLine(entry.line)
                        ? effectivePlayedColor
                        : effectiveUnplayedColor,
                    opacity: 0.55,
                  }"
                >
                  <!-- 翻译逐字高亮 -->
                  <template
                    v-if="
                      isYrcLine(entry.line) &&
                      entry.line.translatedCharacters &&
                      entry.line.translatedCharacters.length > 1
                    "
                  >
                    <span class="lyric-yrc-sub-wrap">
                      <span
                        v-for="(char, ci) in entry.line.translatedCharacters"
                        :key="ci"
                        :ref="(el) => registerSubChar(entry.index, 'translated', ci, toHtmlEl(el))"
                        class="lyric-yrc-sub-char"
                        data-echo-lyric-char
                        :data-echo-lyric-char-index="ci"
                        data-echo-lyric-secondary-kind="translated"
                        :style="{
                          backgroundImage: activeYrcBgStyle,
                        }"
                        >{{ char.text }}</span
                      >
                    </span>
                  </template>
                  <template v-else>
                    {{ entry.line.translated.trim() }}
                  </template>
                </span>
              </template>
              <template v-else>
                <span
                  v-if="lyricStore.lineSecondaryText(entry.line)"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  data-echo-lyric-secondary
                  :data-echo-lyric-secondary-kind="lyricStore.lyricsMode"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: secondaryFontWeight,
                    color:
                      currentIndex === entry.index && !isYrcLine(entry.line)
                        ? effectivePlayedColor
                        : effectiveUnplayedColor,
                    opacity: 0.7,
                  }"
                >
                  <!-- 单模式逐字高亮（音译） -->
                  <template
                    v-if="
                      isYrcLine(entry.line) &&
                      lyricStore.lyricsMode === 'romanization' &&
                      entry.line.romanizedCharacters &&
                      entry.line.romanizedCharacters.length > 1
                    "
                  >
                    <span class="lyric-yrc-sub-wrap">
                      <span
                        v-for="(char, ci) in entry.line.romanizedCharacters"
                        :key="ci"
                        :ref="(el) => registerSubChar(entry.index, 'romanized', ci, toHtmlEl(el))"
                        class="lyric-yrc-sub-char"
                        data-echo-lyric-char
                        :data-echo-lyric-char-index="ci"
                        data-echo-lyric-secondary-kind="romanized"
                        :style="{
                          backgroundImage: activeYrcBgStyle,
                        }"
                        >{{ char.text }}</span
                      >
                    </span>
                  </template>
                  <!-- 单模式逐字高亮（翻译） -->
                  <template
                    v-else-if="
                      isYrcLine(entry.line) &&
                      lyricStore.lyricsMode === 'translation' &&
                      entry.line.translatedCharacters &&
                      entry.line.translatedCharacters.length > 1
                    "
                  >
                    <span class="lyric-yrc-sub-wrap">
                      <span
                        v-for="(char, ci) in entry.line.translatedCharacters"
                        :key="ci"
                        :ref="(el) => registerSubChar(entry.index, 'translated', ci, toHtmlEl(el))"
                        class="lyric-yrc-sub-char"
                        data-echo-lyric-char
                        :data-echo-lyric-char-index="ci"
                        data-echo-lyric-secondary-kind="translated"
                        :style="{
                          backgroundImage: activeYrcBgStyle,
                        }"
                        >{{ char.text }}</span
                      >
                    </span>
                  </template>
                  <template v-else>
                    {{ lyricStore.lineSecondaryText(entry.line) }}
                  </template>
                </span>
              </template>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="hasStaticLyrics">
        <div class="static-lyric-list">
          <div
            v-for="(line, index) in staticLyricLines"
            :key="`${line}-${index}`"
            class="static-lyric-row"
            data-echo-lyric-static-row
            :data-echo-lyric-index="index"
            :style="{
              color: effectiveUnplayedColor,
              fontSize: titleFontSize,
              fontWeight: String(lyricStore.fontWeightValue),
            }"
          >
            {{ line }}
          </div>
        </div>
      </template>

      <!-- 空状态 -->
      <div v-else class="flex h-full items-center justify-center text-center">
        <div class="space-y-3">
          <p class="text-[28px] font-semibold opacity-80">
            {{ lyricStore.isLoading ? '歌词加载中…' : '暂无歌词' }}
          </p>
        </div>
      </div>
    </div>

    <div
      ref="lyricEffectOverlayRef"
      class="echo-lyric-effect-overlay"
      data-echo-lyric-effect-overlay
      aria-hidden="true"
    ></div>

    <!-- 固定位置时间标签：滚轮停止后显示在右侧中心（在 scroller 外面，不被 mask 裁剪） -->
    <button
      v-if="scrollHighlightIndex >= 0 && hasLyrics"
      class="lyric-time-tag-fixed"
      @click.stop="handleLineClick(lyricStore.lines[scrollHighlightIndex]?.time ?? 0)"
    >
      <Icon :icon="iconPlay" width="9" height="9" class="lyric-time-tag-icon" />
      <span>{{ formatDuration(lyricStore.lines[scrollHighlightIndex]?.time ?? 0) }}</span>
    </button>
  </div>
</template>

<style scoped>
.lyric-scroller-wrap {
  position: relative;
  height: 100%;
  width: 100%;
}

.echo-lyric-effect-host {
  isolation: isolate;
  --echo-lyric-current-index: -1;
  --echo-lyric-scroll-index: -1;
  --echo-lyric-current-time: 0;
  --echo-lyric-timeline-ms: 0;
  --echo-lyric-playback-rate: 1;
}

.lyric-scroller {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  position: relative;
  mask-image: linear-gradient(180deg, transparent 0%, black 10%, black 90%, transparent 100%);
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    black 10%,
    black 90%,
    transparent 100%
  );
  z-index: 1;
}

.lyric-scroller.is-collapsed {
  mask-image: none;
  -webkit-mask-image: none;
}

.lyric-scroller::-webkit-scrollbar {
  display: none;
}

.echo-lyric-effect-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
}

.lyric-row {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 8px;
}

.lyric-line {
  min-width: 0;
  max-width: 100%;
  padding: 6px 16px;
  border-radius: 8px;
  cursor: default;
  transition: opacity 0.22s ease;
  position: relative;
  text-align: center;
}

.lyric-line > span {
  cursor: pointer;
}

.is-collapsed .lyric-line > span {
  cursor: default;
}

.lyric-line.is-idle {
  opacity: 0.6;
}

.lyric-line.is-current {
  opacity: 1;
}

.lyric-line.is-scroll-highlight {
  opacity: 1;
}

.lyric-time-tag-fixed {
  position: fixed;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 5px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.15);
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.lyric-time-tag-fixed:hover {
  background: rgba(255, 255, 255, 0.22);
  color: white;
}

.lyric-yrc-char {
  display: inline;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
}

.lyric-yrc-line-wrap {
  display: inline;
  contain: layout paint;
  isolation: isolate;
}

.lyric-yrc-sub-char {
  display: inline;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
}

.lyric-yrc-sub-wrap {
  display: inline;
  contain: layout paint;
  isolation: isolate;
}

.lyric-subline {
  opacity: 0.6;
}

.lyric-line.is-current .lyric-subline {
  opacity: 0.75;
}

.static-lyric-list {
  min-height: 100%;
  padding: 20vh 8px;
}

.static-lyric-row {
  padding: 10px 16px;
  text-align: center;
  line-height: 1.32;
  opacity: 0.86;
}
</style>
