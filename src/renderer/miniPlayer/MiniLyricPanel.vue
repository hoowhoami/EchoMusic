<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { MiniPlayerLyricPayload } from '../../shared/mini-player';

const props = defineProps<{
  lyric: MiniPlayerLyricPayload | null;
  title: string;
  artist: string;
  coverUrl: string;
  visible: boolean;
  isDark: boolean;
}>();

const lyricLines = computed(() => props.lyric?.lines ?? []);
const lyricViewportRef = ref<HTMLElement | null>(null);
const lyricTrackRef = ref<HTMLElement | null>(null);
const lyricTrackOffset = ref(0);
const animateLyricTrack = ref(false);
// 面板刚打开时抑制前几次 index 变化引起的滚动，等稳定后再响应
const isStabilizing = ref(false);
let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
let lyricMeasureFrameId: number | null = null;
let lyricSettleTimer: ReturnType<typeof setTimeout> | null = null;

const activeLyricIndex = computed(() => {
  const index = props.lyric?.currentIndex ?? -1;
  if (index >= 0 && index < lyricLines.value.length) return index;
  return lyricLines.value.length > 0 ? 0 : -1;
});

const lyricBackgroundStyle = computed(() =>
  props.coverUrl ? { backgroundImage: `url("${props.coverUrl}")` } : {},
);

const resolveLyricSecondaryLines = (line: MiniPlayerLyricPayload['lines'][number]) => {
  const translated = line.translated?.trim() ?? '';
  const romanized = line.romanized?.trim() ?? '';
  if (props.lyric?.wantTranslation && props.lyric?.wantRomanization) {
    return [romanized, translated].filter(Boolean);
  }
  if (props.lyric?.wantRomanization) return [romanized || translated].filter(Boolean);
  if (props.lyric?.wantTranslation) return [translated || romanized].filter(Boolean);
  return [] as string[];
};

const lyricEntries = computed(() =>
  lyricLines.value.map((line, index) => ({
    line,
    index,
    secondaryLines: resolveLyricSecondaryLines(line),
  })),
);

const lyricTrackStyle = computed(() => ({
  transform: `translate3d(0, ${-lyricTrackOffset.value}px, 0)`,
  transition: animateLyricTrack.value ? 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
}));

const cancelPendingLyricMeasure = () => {
  if (lyricMeasureFrameId !== null) {
    cancelAnimationFrame(lyricMeasureFrameId);
    lyricMeasureFrameId = null;
  }
};

const cancelLyricSettleTimer = () => {
  if (lyricSettleTimer !== null) {
    clearTimeout(lyricSettleTimer);
    lyricSettleTimer = null;
  }
};

const cancelStabilizeTimer = () => {
  if (stabilizeTimer !== null) {
    clearTimeout(stabilizeTimer);
    stabilizeTimer = null;
  }
};

const positionActiveLyric = (animate: boolean) => {
  cancelPendingLyricMeasure();
  lyricMeasureFrameId = requestAnimationFrame(() => {
    lyricMeasureFrameId = null;
    if (!props.visible) return;

    const viewport = lyricViewportRef.value;
    const index = activeLyricIndex.value;
    const track = lyricTrackRef.value;
    if (!viewport || !track || index < 0 || viewport.clientHeight <= 0) return;

    const target = viewport.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
    if (!target) return;

    const anchorRatio = 0.42;
    const nextTop =
      target.offsetTop - viewport.clientHeight * anchorRatio + target.offsetHeight / 2;
    const maxTop = Math.max(0, track.scrollHeight - viewport.clientHeight);
    const boundedTop = Math.min(maxTop, Math.max(0, nextTop));
    const distance = boundedTop - lyricTrackOffset.value;
    if (Math.abs(distance) < 1) return;

    animateLyricTrack.value = animate && Math.abs(distance) <= viewport.clientHeight * 1.4;
    lyricTrackOffset.value = boundedTop;
  });
};

watch(
  [activeLyricIndex, () => props.lyric?.trackId ?? null, () => props.visible],
  async ([index, trackId, visible], oldValue) => {
    if (!visible || index < 0) {
      cancelLyricSettleTimer();
      cancelStabilizeTimer();
      isStabilizing.value = false;
      return;
    }
    cancelLyricSettleTimer();
    const [previousIndex = -1, previousTrackId = null, wasVisible = false] = oldValue ?? [];

    // 面板刚打开：进入稳定化阶段，延迟后定位一次（无动画），忽略中间的 index 变化
    if (!wasVisible) {
      isStabilizing.value = true;
      cancelStabilizeTimer();
      stabilizeTimer = setTimeout(async () => {
        stabilizeTimer = null;
        isStabilizing.value = false;
        await nextTick();
        positionActiveLyric(false);
      }, 200);
      return;
    }

    // 稳定化期间忽略后续 index 变化
    if (isStabilizing.value) return;

    await nextTick();
    const isSameVisibleTrack = trackId === previousTrackId;
    positionActiveLyric(isSameVisibleTrack && previousIndex >= 0);

    if (!isSameVisibleTrack) {
      lyricSettleTimer = setTimeout(() => {
        lyricSettleTimer = null;
        positionActiveLyric(false);
      }, 280);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  cancelPendingLyricMeasure();
  cancelLyricSettleTimer();
  cancelStabilizeTimer();
});
</script>

<template>
  <div class="mini-lyric no-drag" :class="{ dark: isDark }">
    <div class="mini-lyric-bg" :style="lyricBackgroundStyle"></div>
    <div class="mini-lyric-scrim"></div>
    <div class="mini-lyric-content">
      <div class="mini-lyric-heading">
        <div class="mini-lyric-song">{{ title }}</div>
        <div class="mini-lyric-artist">{{ artist }}</div>
      </div>
      <div v-if="lyricEntries.length" ref="lyricViewportRef" class="mini-lyric-lines">
        <div ref="lyricTrackRef" class="mini-lyric-track" :style="lyricTrackStyle">
          <div
            v-for="entry in lyricEntries"
            :key="`${entry.index}-${entry.line.time}`"
            :data-lyric-index="entry.index"
            class="mini-lyric-line"
            :class="{ active: entry.index === activeLyricIndex }"
          >
            <div class="mini-lyric-primary">{{ entry.line.text }}</div>
            <div
              v-for="(secondaryLine, secondaryIndex) in entry.secondaryLines"
              :key="secondaryIndex"
              class="mini-lyric-secondary"
            >
              {{ secondaryLine }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="mini-lyric-empty">{{ lyric?.tips || '暂无歌词' }}</div>
    </div>
  </div>
</template>

<style scoped>
.mini-lyric {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  isolation: isolate;
  contain: paint;
}

.mini-lyric-bg,
.mini-lyric-scrim {
  position: absolute;
  pointer-events: none;
}

.mini-lyric-bg {
  inset: 0;
  background-position: center;
  background-size: cover;
  opacity: 0.22;
  transform: translateZ(0);
  backface-visibility: hidden;
}

.mini-lyric-scrim {
  inset: 0;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(245, 245, 245, 0.94)),
    radial-gradient(circle at 20% 10%, rgba(255, 255, 255, 0.62), transparent 46%);
}

.mini-lyric-content {
  position: relative;
  z-index: 1;
  height: 100%;
  box-sizing: border-box;
  padding: 16px 22px 18px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.mini-lyric-heading {
  flex: 0 0 auto;
  min-width: 0;
}

.mini-lyric-song,
.mini-lyric-artist,
.mini-lyric-primary,
.mini-lyric-secondary {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini-lyric-song {
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
  font-weight: 800;
}

.mini-lyric-artist {
  white-space: nowrap;
  margin-top: 1px;
  font-size: 11px;
  line-height: 15px;
  font-weight: 650;
  color: rgba(29, 29, 31, 0.58);
}

.mini-lyric-lines {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 10px;
  overflow: hidden;
  overflow-anchor: none;
  overscroll-behavior: none;
}

.mini-lyric-track {
  position: relative;
  padding: 92px 0 104px;
  will-change: transform;
}

.mini-lyric-line {
  min-width: 0;
  padding: 7px 0;
  text-align: center;
  color: rgba(60, 60, 67, 0.6);
  transition:
    color 0.18s ease,
    opacity 0.18s ease;
}

.mini-lyric-line + .mini-lyric-line {
  margin-top: 2px;
}

.mini-lyric-line.active {
  color: var(--color-primary);
}

.mini-lyric-primary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 14px;
  line-height: 20px;
  font-weight: 780;
  letter-spacing: 0;
}

.mini-lyric-line.active .mini-lyric-primary {
  text-shadow: 0 0 0 currentColor;
}

.mini-lyric-secondary {
  display: block;
  white-space: nowrap;
  margin-top: 3px;
  font-size: 11px;
  line-height: 15px;
  font-weight: 650;
  color: rgba(60, 60, 67, 0.45);
}

.mini-lyric-line.active .mini-lyric-secondary {
  color: color-mix(in srgb, var(--color-primary) 74%, #1d1d1f);
}

.mini-lyric-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  color: rgba(29, 29, 31, 0.52);
}

.mini-lyric.dark {
  border-top-color: rgba(255, 255, 255, 0.08);
}

.mini-lyric.dark .mini-lyric-scrim {
  background:
    linear-gradient(180deg, rgba(36, 36, 40, 0.84), rgba(24, 24, 28, 0.95)),
    radial-gradient(circle at 20% 10%, rgba(255, 255, 255, 0.12), transparent 46%);
}

.mini-lyric.dark .mini-lyric-artist,
.mini-lyric.dark .mini-lyric-secondary {
  color: rgba(245, 245, 247, 0.45);
}

.mini-lyric.dark .mini-lyric-line {
  color: rgba(245, 245, 247, 0.55);
}

.mini-lyric.dark .mini-lyric-line.active {
  color: var(--color-primary);
}

.mini-lyric.dark .mini-lyric-line.active .mini-lyric-secondary {
  color: color-mix(in srgb, var(--color-primary) 72%, #f5f5f7);
}

.mini-lyric.dark .mini-lyric-empty {
  color: rgba(245, 245, 247, 0.5);
}
</style>
