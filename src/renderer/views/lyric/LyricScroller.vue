<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useLyricScroll } from './composables/useLyricScroll';
import { useYrcAnimation } from './composables/useYrcAnimation';
import { formatDuration } from '@/utils/format';
import { iconPlay } from '@/icons';

interface Props {
  collapsed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  collapsed: false,
});

const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();

const lyricListRef = ref<HTMLElement | null>(null);

const collapsedRef = computed(() => props.collapsed);

const { isUserScrolling, scrollHighlightIndex, scrollToLine, handleWheel, dispose } =
  useLyricScroll(() => lyricListRef.value, collapsedRef);

const { getNowMs, updateYrcDom, syncSeekAnchor } = useYrcAnimation(lyricListRef);

const effectivePlayedColor = computed(() => lyricStore.effectivePlayedColor);
const effectiveUnplayedColor = computed(() => lyricStore.effectiveUnplayedColor);
const currentIndex = computed(() => lyricStore.currentIndex);
const hasLyrics = computed(() => lyricStore.lines.length > 0);
const titleFontSize = computed(() => `${1.5 * lyricStore.fontScale}rem`);
const secondaryFontSize = computed(() => `${1.2 * lyricStore.fontScale}rem`);
const lyricFontFamily = computed(() => settingStore.buildLyricFontFamily());

const isYrcLine = (line: { characters: unknown[] }) => (line.characters?.length ?? 0) > 1;

const handleLineClick = (time: number) => {
  playerStore.seek(time);
};

const handleLyricWheel = () => {
  handleWheel();
};

// 虚拟列表优化
const VIRTUAL_OVERSCAN_BEFORE = 15;
const VIRTUAL_OVERSCAN_AFTER = 25;

const getEstimatedLineHeight = (line: (typeof lyricStore.lines)[0]) => {
  const scale = lyricStore.fontScale;
  let base = 36;
  if (lyricStore.lyricsMode === 'both' && lyricStore.secondaryEnabled) {
    base = 72;
  } else if (lyricStore.lineSecondaryText(line)) {
    base = 56;
  }
  return base * scale + 32;
};

const visibleRange = computed(() => {
  const lines = lyricStore.lines;
  if (lines.length === 0) return { start: 0, end: 0 };
  // 用户滚动期间以 scrollHighlightIndex 为锚点，避免播放进度导致跳动
  const anchor =
    isUserScrolling.value && scrollHighlightIndex.value >= 0
      ? scrollHighlightIndex.value
      : lyricStore.currentIndex;
  const index = anchor;
  if (index < 0) return { start: 0, end: Math.min(lines.length, VIRTUAL_OVERSCAN_AFTER) };
  const start = Math.max(0, index - VIRTUAL_OVERSCAN_BEFORE);
  const end = Math.min(lines.length, index + VIRTUAL_OVERSCAN_AFTER);
  return { start, end };
});

const visibleLines = computed(() => {
  const { start, end } = visibleRange.value;
  return lyricStore.lines.slice(start, end).map((line, offset) => ({
    line,
    index: start + offset,
  }));
});

const beforeSpacerHeight = computed(() => {
  const { start } = visibleRange.value;
  if (start <= 0) return 0;
  let total = 0;
  const lines = lyricStore.lines;
  for (let i = 0; i < start; i++) {
    total += getEstimatedLineHeight(lines[i]);
  }
  return total;
});

const afterSpacerHeight = computed(() => {
  const { end } = visibleRange.value;
  const lines = lyricStore.lines;
  if (end >= lines.length) return 0;
  let total = 0;
  for (let i = end; i < lines.length; i++) {
    total += getEstimatedLineHeight(lines[i]);
  }
  return total;
});

// 逐字歌词 RAF 更新
let rafId: number | null = null;
let lastRafTime = 0;

const rafLoop = () => {
  rafId = requestAnimationFrame((timestamp) => {
    if (timestamp - lastRafTime >= 33) {
      lastRafTime = timestamp;
      lyricStore.updateCurrentIndex(getNowMs() / 1000, true);
      updateYrcDom(effectivePlayedColor.value, effectiveUnplayedColor.value);
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
    if (playing) startRaf();
    else stopRaf();
  },
);

watch(
  () => playerStore.currentTime,
  () => syncSeekAnchor(),
);

onMounted(() => {
  syncSeekAnchor();
  if (playerStore.isPlaying) startRaf();
  nextTick(() => scrollToLine(lyricStore.currentIndex, false));
});

onUnmounted(() => {
  stopRaf();
  dispose();
});

// 切歌时重置滚动
watch(
  () => playerStore.currentTrackSnapshot?.id,
  async () => {
    await nextTick();
    scrollToLine(lyricStore.currentIndex, false);
  },
);

// 收起/展开时重新定位（瞬间跳转，不用动画）
watch(
  () => props.collapsed,
  (collapsed) => {
    nextTick(() => {
      scrollToLine(lyricStore.currentIndex, false, collapsed);
    });
  },
);

watch(
  () => lyricStore.lyricsMode,
  async () => {
    await nextTick();
    scrollToLine(lyricStore.currentIndex, false);
  },
);
</script>

<template>
  <div class="lyric-scroller-wrap">
    <div
      ref="lyricListRef"
      class="lyric-scroller"
      :class="{ 'is-collapsed': props.collapsed }"
      :style="{ fontFamily: lyricFontFamily }"
      @wheel.passive="handleLyricWheel"
    >
      <template v-if="hasLyrics">
        <div
          :style="{
            paddingTop: props.collapsed ? '60vh' : '40vh',
            paddingBottom: props.collapsed ? '10px' : '40vh',
          }"
        >
          <!-- 上方虚拟占位 -->
          <div :style="{ height: `${beforeSpacerHeight}px` }"></div>

          <div
            v-for="entry in visibleLines"
            :key="entry.line.time"
            class="lyric-row"
            :data-lyric-index="entry.index"
            :style="{
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
              @dblclick.prevent.stop="handleLineClick(entry.line.time)"
            >
              <!-- 主歌词 -->
              <span
                class="block leading-[1.24] tracking-[0.01em]"
                :style="{
                  fontSize: titleFontSize,
                  fontWeight: String(lyricStore.fontWeightValue),
                }"
              >
                <!-- 逐字歌词 -->
                <template v-if="currentIndex === entry.index && isYrcLine(entry.line)">
                  <span class="lyric-yrc-line-wrap">
                    <span
                      v-for="(char, ci) in entry.line.characters"
                      :key="ci"
                      class="lyric-yrc-char"
                      :style="{
                        backgroundImage: `linear-gradient(to right, ${effectivePlayedColor} 50%, ${effectiveUnplayedColor} 50%)`,
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

              <!-- 翻译/音译 -->
              <template v-if="lyricStore.lyricsMode === 'both' && lyricStore.secondaryEnabled">
                <span
                  v-if="entry.line.translated?.trim()"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: String(
                      currentIndex === entry.index
                        ? Math.max(500, lyricStore.fontWeightValue - 200)
                        : 400,
                    ),
                    color: effectiveUnplayedColor,
                    opacity: 0.7,
                  }"
                >
                  {{ entry.line.translated.trim() }}
                </span>
                <span
                  v-if="entry.line.romanized?.trim()"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: String(
                      currentIndex === entry.index
                        ? Math.max(500, lyricStore.fontWeightValue - 200)
                        : 400,
                    ),
                    color: effectiveUnplayedColor,
                    opacity: 0.55,
                  }"
                >
                  {{ entry.line.romanized.trim() }}
                </span>
              </template>
              <template v-else>
                <span
                  v-if="lyricStore.lineSecondaryText(entry.line)"
                  class="lyric-subline mt-1 block max-w-full truncate"
                  :style="{
                    fontSize: secondaryFontSize,
                    fontWeight: String(
                      currentIndex === entry.index
                        ? Math.max(500, lyricStore.fontWeightValue - 200)
                        : 400,
                    ),
                    color: effectiveUnplayedColor,
                    opacity: 0.7,
                  }"
                >
                  {{ lyricStore.lineSecondaryText(entry.line) }}
                </span>
              </template>
            </div>
          </div>

          <!-- 下方虚拟占位 -->
          <div :style="{ height: `${afterSpacerHeight}px` }"></div>
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
}

.lyric-scroller.is-collapsed {
  mask-image: none;
  -webkit-mask-image: none;
}

.lyric-scroller::-webkit-scrollbar {
  display: none;
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
  transition:
    opacity 0.26s ease,
    transform 0.26s ease;
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
  transform: scale(0.97);
}

.lyric-line.is-current {
  opacity: 1;
  transform: scale(1);
}

.lyric-line.is-scroll-highlight {
  opacity: 1;
  transform: scale(1);
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

.lyric-subline {
  opacity: 0.6;
}

.lyric-line.is-current .lyric-subline {
  opacity: 0.75;
}
</style>
