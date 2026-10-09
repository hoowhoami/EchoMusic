<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import {
  normalizeMiniLyricStyle,
  type MiniPlayerLyricStyle,
  type MiniPlayerExpandDirection,
  type MiniPlayerLyricPayload,
} from '../../shared/miniPlayer';
import { computeLyricCharBackgroundPosition } from '@/composables/useLyricTimeline';

const props = defineProps<{
  lyric: MiniPlayerLyricPayload | null;
  title: string;
  artist: string;
  coverUrl: string;
  playedColor?: string;
  unplayedColor?: string;
  lyricStyle?: Partial<MiniPlayerLyricStyle>;
  visible: boolean;
  expandDirection?: MiniPlayerExpandDirection;
  timelineMs?: number;
  seekTimestamp?: number;
}>();

const lyricLines = computed(() => props.lyric?.lines ?? []);
const resolvedLyricStyle = computed(() => normalizeMiniLyricStyle(props.lyricStyle));
const lyricAppearanceStyle = computed(() => ({
  '--mini-lyric-played': props.playedColor || 'var(--color-primary-text)',
  '--mini-lyric-unplayed': props.unplayedColor || 'var(--text-secondary)',
  '--mini-lyric-font-size': `${resolvedLyricStyle.value.fontSize}px`,
  '--mini-lyric-secondary-size': `${resolvedLyricStyle.value.secondaryFontSize}px`,
  '--mini-lyric-font-weight': resolvedLyricStyle.value.fontWeight,
  '--mini-lyric-secondary-weight': Math.min(resolvedLyricStyle.value.fontWeight, 650),
  '--mini-lyric-alignment': resolvedLyricStyle.value.alignment,
  '--mini-lyric-line-gap': `${resolvedLyricStyle.value.lineGap}px`,
}));
const lyricViewportRef = ref<HTMLElement | null>(null);
const lyricTrackRef = ref<HTMLElement | null>(null);
const lyricTrackOffset = ref(0);
const animateLyricTrack = ref(false);
const isUserScrolling = ref(false);
// 面板刚打开时抑制前几次 index 变化引起的滚动，等稳定后再响应
const isStabilizing = ref(false);
let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
let lyricMeasureFrameId: number | null = null;
let lyricSettleTimer: ReturnType<typeof setTimeout> | null = null;
let userScrollResumeTimer: ReturnType<typeof setTimeout> | null = null;
const USER_SCROLL_RESUME_MS = 5000;

const activeLyricIndex = computed(() => {
  const index = props.lyric?.currentIndex ?? -1;
  if (index >= 0 && index < lyricLines.value.length) return index;
  return lyricLines.value.length > 0 ? 0 : -1;
});

const lyricBackgroundStyle = computed(() =>
  props.coverUrl ? { backgroundImage: `url("${props.coverUrl}")` } : {},
);

// 注音模式：音译逐字标注在主歌词每个字上方（需开启音译、开启注音模式且该行有注音配对时）
const isRubyLine = (line: MiniPlayerLyricPayload['lines'][number]) =>
  Boolean(props.lyric?.wantRomanization) &&
  Boolean(props.lyric?.showRomanizationAsRuby) &&
  (line.rubyUnits?.length ?? 0) > 0;

// 是否有逐字数据
const isYrcLine = (line: MiniPlayerLyricPayload['lines'][number]) =>
  (line.characters?.length ?? 0) > 0;

// 音译注音开关：仅当正在显示音译时可切换
const canShowRubyToggle = computed(
  () => Boolean(props.lyric?.wantRomanization) && Boolean(props.lyric?.hasRomanization),
);

const handleToggleTranslation = () => {
  window.electron?.miniPlayer?.command('toggleTranslation');
};

const handleToggleRomanization = () => {
  window.electron?.miniPlayer?.command('toggleRomanization');
};

const handleToggleRomanizationAsRuby = () => {
  window.electron?.miniPlayer?.command('toggleRomanizationAsRuby');
};

// 当前行卡拉OK 逐字填充：直接操作 DOM，避免每帧重渲染整个歌词列表
const lineElementRefs = new Map<number, HTMLElement>();
const setLineElement = (index: number) => (el: unknown) => {
  if (el) lineElementRefs.set(index, el as HTMLElement);
  else lineElementRefs.delete(index);
};

const applyActiveLineKaraoke = () => {
  const index = activeLyricIndex.value;
  const line = lyricLines.value[index];
  const root = lineElementRefs.get(index);
  if (!root || !line || !props.visible) return;

  const seekMs = props.timelineMs || 0;
  const words = Array.from(root.querySelectorAll<HTMLElement>('.mini-karaoke-word'));
  const rubies = Array.from(root.querySelectorAll<HTMLElement>('.mini-karaoke-ruby'));
  const characters = line.characters ?? [];
  for (let i = 0; i < words.length; i++) {
    const char = characters[i];
    const el = words[i];
    if (!char || !el) continue;
    el.style.backgroundPositionX = computeLyricCharBackgroundPosition(
      char.startTime || 0,
      char.endTime || 0,
      seekMs,
    );
  }
  const units = line.rubyUnits ?? [];
  for (let i = 0; i < rubies.length; i++) {
    const unit = units[i];
    const el = rubies[i];
    if (!unit || !el) continue;
    el.style.backgroundPositionX = computeLyricCharBackgroundPosition(
      unit.startTime || 0,
      unit.endTime || 0,
      seekMs,
    );
  }
  const transChars = line.translatedCharacters ?? [];
  const transEls = Array.from(root.querySelectorAll<HTMLElement>('.mini-karaoke-tran'));
  for (let i = 0; i < transEls.length; i++) {
    const char = transChars[i];
    const el = transEls[i];
    if (!char || !el) continue;
    el.style.backgroundPositionX = computeLyricCharBackgroundPosition(
      char.startTime || 0,
      char.endTime || 0,
      seekMs,
    );
  }
  const romanChars = line.romanizedCharacters ?? [];
  const romanEls = Array.from(root.querySelectorAll<HTMLElement>('.mini-karaoke-roman'));
  for (let i = 0; i < romanEls.length; i++) {
    const char = romanChars[i];
    const el = romanEls[i];
    if (!char || !el) continue;
    el.style.backgroundPositionX = computeLyricCharBackgroundPosition(
      char.startTime || 0,
      char.endTime || 0,
      seekMs,
    );
  }
};

watch(
  [
    () => activeLyricIndex.value,
    () => props.timelineMs,
    () => props.lyric?.trackId,
    () => props.visible,
    () => props.lyric?.currentIndex,
  ],
  () => {
    void nextTick(() => {
      if (!props.visible) return;
      applyActiveLineKaraoke();
    });
  },
  { immediate: true },
);

type MiniSecondaryLine = { text: string; kind: 'translation' | 'romanization' };

const resolveLyricSecondaryLines = (line: MiniPlayerLyricPayload['lines'][number]) => {
  const translated = line.translated?.trim() ?? '';
  const romanized = line.romanized?.trim() ?? '';
  const wantTranslation = props.lyric?.wantTranslation ?? false;
  const wantRomanization = props.lyric?.wantRomanization ?? false;
  // 注音行：音译已标注在每个字上方，副歌词只保留翻译
  const romanShownAsRuby = isRubyLine(line);
  // 两个开关独立控制对应内容，缺少音译时也不能绕过翻译开关。
  const secondaryLines: MiniSecondaryLine[] = [];
  if (wantRomanization && !romanShownAsRuby && romanized) {
    secondaryLines.push({ text: romanized, kind: 'romanization' });
  }
  if (wantTranslation && translated) {
    secondaryLines.push({ text: translated, kind: 'translation' });
  }
  return secondaryLines;
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

const cancelUserScrollResumeTimer = () => {
  if (userScrollResumeTimer !== null) {
    clearTimeout(userScrollResumeTimer);
    userScrollResumeTimer = null;
  }
};

const stopUserScrolling = () => {
  isUserScrolling.value = false;
  cancelUserScrollResumeTimer();
};

const getLyricMaxOffset = () => {
  const viewport = lyricViewportRef.value;
  const track = lyricTrackRef.value;
  if (!viewport || !track) return 0;
  return Math.max(0, track.scrollHeight - viewport.clientHeight);
};

const applyLyricOffset = (nextTop: number, animate: boolean) => {
  const viewport = lyricViewportRef.value;
  if (!viewport || viewport.clientHeight <= 0) return;
  const boundedTop = Math.min(getLyricMaxOffset(), Math.max(0, nextTop));
  const distance = boundedTop - lyricTrackOffset.value;
  if (Math.abs(distance) < 0.5) return;
  animateLyricTrack.value = animate && Math.abs(distance) <= viewport.clientHeight * 1.4;
  lyricTrackOffset.value = boundedTop;
};

const positionLyricIndex = (index: number, animate: boolean) => {
  cancelPendingLyricMeasure();
  lyricMeasureFrameId = requestAnimationFrame(() => {
    lyricMeasureFrameId = null;
    if (!props.visible) return;

    const viewport = lyricViewportRef.value;
    const track = lyricTrackRef.value;
    if (!viewport || !track || index < 0 || viewport.clientHeight <= 0) return;

    const target = viewport.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
    if (!target) return;

    const anchorRatio = 0.42;
    applyLyricOffset(
      target.offsetTop - viewport.clientHeight * anchorRatio + target.offsetHeight / 2,
      animate,
    );
  });
};

const positionActiveLyric = (animate: boolean) => {
  if (isUserScrolling.value) return;
  positionLyricIndex(activeLyricIndex.value, animate);
};

// 展开动画、换行及译文/注音切换都会改变可视区域或行高。
useResizeObserver([lyricViewportRef, lyricTrackRef], () => {
  if (props.visible) positionActiveLyric(false);
});

const handleLyricWheel = (event: WheelEvent) => {
  if (!props.visible || lyricLines.value.length === 0) return;
  event.preventDefault();
  event.stopPropagation();

  const viewport = lyricViewportRef.value;
  if (!viewport || viewport.clientHeight <= 0) return;

  const delta =
    event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * viewport.clientHeight
        : event.deltaY;

  isUserScrolling.value = true;
  cancelUserScrollResumeTimer();
  applyLyricOffset(lyricTrackOffset.value + delta, false);

  userScrollResumeTimer = setTimeout(() => {
    userScrollResumeTimer = null;
    isUserScrolling.value = false;
    positionActiveLyric(true);
  }, USER_SCROLL_RESUME_MS);
};

const handleLyricLineClick = (index: number, line: MiniPlayerLyricPayload['lines'][number]) => {
  window.electron?.miniPlayer?.command({ type: 'seek', value: Number(line.time) || 0 });
  stopUserScrolling();
  void nextTick(() => positionLyricIndex(index, true));
};

watch(
  [activeLyricIndex, () => props.lyric?.trackId ?? null, () => props.visible],
  async ([index, trackId, visible], oldValue) => {
    if (!visible || index < 0) {
      cancelLyricSettleTimer();
      cancelStabilizeTimer();
      stopUserScrolling();
      isStabilizing.value = false;
      return;
    }
    cancelLyricSettleTimer();
    const [previousIndex = -1, previousTrackId = null, wasVisible = false] = oldValue ?? [];

    // 面板刚打开：先立即定位，再短延迟校准一次，避免刚展开时看起来慢半拍。
    if (!wasVisible) {
      cancelStabilizeTimer();
      isStabilizing.value = false;
      stopUserScrolling();
      await nextTick();
      positionActiveLyric(false);
      stabilizeTimer = setTimeout(() => {
        stabilizeTimer = null;
        positionActiveLyric(false);
      }, 120);
      return;
    }

    const isSameVisibleTrack = trackId === previousTrackId;
    if (!isSameVisibleTrack) stopUserScrolling();

    // 稳定化期间忽略后续 index 变化
    if (isStabilizing.value) return;
    if (isUserScrolling.value) return;

    await nextTick();
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

watch(
  () => props.seekTimestamp ?? 0,
  (timestamp, previous) => {
    if (!props.visible || !timestamp || timestamp === previous) return;
    stopUserScrolling();
    void nextTick(() => positionActiveLyric(true));
  },
);

onBeforeUnmount(() => {
  cancelPendingLyricMeasure();
  cancelLyricSettleTimer();
  cancelStabilizeTimer();
  cancelUserScrollResumeTimer();
});
</script>

<template>
  <div class="mini-lyric no-drag" :class="{ 'expand-up': expandDirection === 'up' }">
    <div
      v-if="resolvedLyricStyle.backgroundBlur"
      class="mini-lyric-bg"
      :style="lyricBackgroundStyle"
    ></div>
    <div class="mini-lyric-scrim"></div>
    <div class="mini-lyric-content">
      <div class="mini-lyric-heading">
        <div class="mini-lyric-heading-main">
          <div class="mini-lyric-song">{{ title }}</div>
          <div class="mini-lyric-artist">{{ artist }}</div>
        </div>
        <div
          v-if="lyric?.hasTranslation || lyric?.hasRomanization"
          class="mini-lyric-heading-actions"
        >
          <button
            v-if="lyric?.hasTranslation"
            type="button"
            class="mini-lyric-mode-btn"
            :class="lyric?.wantTranslation ? 'soft-accent-action' : 'soft-secondary-action'"
            :aria-pressed="Boolean(lyric?.wantTranslation)"
            aria-label="翻译"
            @click="handleToggleTranslation"
          >
            译
          </button>
          <button
            v-if="lyric?.hasRomanization"
            type="button"
            class="mini-lyric-mode-btn"
            :class="lyric?.wantRomanization ? 'soft-accent-action' : 'soft-secondary-action'"
            :aria-pressed="Boolean(lyric?.wantRomanization)"
            aria-label="音译"
            @click="handleToggleRomanization"
          >
            音
          </button>
          <button
            v-if="canShowRubyToggle"
            type="button"
            class="mini-lyric-mode-btn"
            :class="lyric?.showRomanizationAsRuby ? 'soft-accent-action' : 'soft-secondary-action'"
            :aria-pressed="Boolean(lyric?.showRomanizationAsRuby)"
            aria-label="音译注音：将音译标注在原词上方"
            @click="handleToggleRomanizationAsRuby"
          >
            注音
          </button>
        </div>
      </div>
      <div
        v-if="lyricEntries.length"
        ref="lyricViewportRef"
        class="mini-lyric-lines"
        @wheel.prevent="handleLyricWheel"
      >
        <div
          ref="lyricTrackRef"
          class="mini-lyric-track"
          :style="[lyricTrackStyle, lyricAppearanceStyle]"
        >
          <div
            v-for="entry in lyricEntries"
            :key="`${entry.index}-${entry.line.time}`"
            :data-lyric-index="entry.index"
            class="mini-lyric-line"
            :class="{ active: entry.index === activeLyricIndex }"
            :ref="setLineElement(entry.index)"
            role="button"
            tabindex="-1"
            @click="handleLyricLineClick(entry.index, entry.line)"
          >
            <template v-if="isRubyLine(entry.line)">
              <div
                class="mini-lyric-primary mini-lyric-ruby"
                :class="{ 'mini-lyric-karaoke': entry.index === activeLyricIndex }"
              >
                <span
                  v-for="(unit, ui) in entry.line.rubyUnits"
                  :key="ui"
                  class="ruby-unit"
                  data-echo-lyric-ruby-unit
                >
                  <span class="ruby-text">
                    <span v-if="unit.ruby" class="mini-karaoke-ruby">{{ unit.ruby }}</span>
                  </span>
                  <span class="ruby-base">
                    <span v-for="(char, ci) in unit.chars" :key="ci" class="mini-karaoke-word">{{
                      char.text
                    }}</span>
                  </span>
                </span>
              </div>
            </template>

            <template v-else-if="isYrcLine(entry.line) && entry.index === activeLyricIndex">
              <div class="mini-lyric-primary mini-lyric-karaoke">
                <span
                  v-for="(char, ci) in entry.line.characters"
                  :key="ci"
                  class="mini-karaoke-word"
                  >{{ char.text }}</span
                >
              </div>
            </template>

            <div v-else class="mini-lyric-primary">{{ entry.line.text }}</div>
            <div
              v-for="(secondaryLine, secondaryIndex) in entry.secondaryLines"
              :key="secondaryIndex"
              class="mini-lyric-secondary"
              :class="{ 'mini-lyric-karaoke': entry.index === activeLyricIndex }"
            >
              <template
                v-if="
                  entry.index === activeLyricIndex &&
                  secondaryLine.kind === 'romanization' &&
                  entry.line.romanizedCharacters &&
                  entry.line.romanizedCharacters.length > 1
                "
              >
                <span
                  v-for="(char, ci) in entry.line.romanizedCharacters"
                  :key="ci"
                  class="mini-karaoke-roman"
                  >{{ char.text }}</span
                >
              </template>

              <template
                v-else-if="
                  entry.index === activeLyricIndex &&
                  secondaryLine.kind === 'translation' &&
                  entry.line.translatedCharacters &&
                  entry.line.translatedCharacters.length > 1
                "
              >
                <span
                  v-for="(char, ci) in entry.line.translatedCharacters"
                  :key="ci"
                  class="mini-karaoke-tran"
                  >{{ char.text }}</span
                >
              </template>

              <template v-else>{{ secondaryLine.text }} </template>
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
  border-top: 1px solid var(--control-border);
  isolation: isolate;
  contain: paint;
}

.mini-lyric.expand-up {
  border-top: 0;
  border-bottom: 1px solid var(--control-border);
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
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface-elevated-base) 84%, transparent),
    color-mix(in srgb, var(--surface-elevated-base) 95%, transparent)
  );
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mini-lyric-heading-main {
  flex: 1 1 auto;
  min-width: 0;
}

.mini-lyric-heading-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-lyric-mode-btn {
  appearance: none;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 24px;
  border: 0;
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
  white-space: nowrap;
  padding: 0 8px;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard),
    box-shadow var(--motion-duration-fast) var(--motion-ease-standard);
}

@media (prefers-reduced-motion: reduce) {
  .mini-lyric-mode-btn {
    transition: none;
  }
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
  color: var(--text-secondary);
}

.mini-lyric-lines {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 10px;
  overflow: hidden;
  overflow-anchor: none;
  overscroll-behavior: none;
  touch-action: pan-y;
  /* 让滚动边缘的非当前行淡出，避免半行文字被硬切。 */
  mask-image: linear-gradient(
    to bottom,
    transparent,
    black 14px,
    black calc(100% - 14px),
    transparent
  );
}

.mini-lyric-track {
  position: relative;
  padding: 92px 0 104px;
  will-change: transform;
}

.mini-lyric-line {
  min-width: 0;
  padding: 7px 0;
  text-align: var(--mini-lyric-alignment);
  color: var(--mini-lyric-unplayed);
  cursor: pointer;
  transition:
    color 0.18s ease,
    opacity 0.18s ease;
}

.mini-lyric-line + .mini-lyric-line {
  margin-top: var(--mini-lyric-line-gap);
}

.mini-lyric-line:hover {
  color: var(--text-main);
}

.mini-lyric-line.active {
  color: var(--mini-lyric-played);
}

.mini-lyric-primary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--mini-lyric-font-size);
  line-height: calc(var(--mini-lyric-font-size) * 1.428571);
  font-weight: var(--mini-lyric-font-weight);
  letter-spacing: 0;
}

/* 注音模式：音译逐字标注在每个字上方 */
.mini-lyric-primary.mini-lyric-ruby {
  display: block;
  -webkit-line-clamp: unset;
  white-space: normal;
  line-height: 1.34;
}
.mini-lyric-primary .ruby-unit {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  vertical-align: baseline;
  white-space: nowrap;
  margin-inline: 1px;
}
.mini-lyric-primary .ruby-text {
  display: block;
  line-height: 1.1;
  padding: 0 0.06em;
  font-size: 0.72em;
  opacity: 0.72;
  /* 无读音的单元也必须占位，避免原歌词字符上移到注音行 */
  min-height: 1.1em;
  /* 保留读音内部的音节空格 */
  white-space: pre;
}
.mini-lyric-primary .ruby-base {
  display: block;
  line-height: 1.24;
  /* 保留原词中的空格（flex 列内单独的空格会被折叠） */
  white-space: pre;
}

/* 卡拉OK 逐字填充：仅当前行启用背景裁切着色 */
.mini-karaoke-word,
.mini-karaoke-ruby,
.mini-karaoke-tran,
.mini-karaoke-roman {
  display: inline-block;
  white-space: pre;
}
.mini-lyric-line.active .mini-lyric-karaoke .mini-karaoke-word,
.mini-lyric-line.active .mini-lyric-karaoke .mini-karaoke-ruby,
.mini-lyric-line.active .mini-lyric-karaoke .mini-karaoke-tran,
.mini-lyric-line.active .mini-lyric-karaoke .mini-karaoke-roman {
  color: transparent;
  background-color: transparent;
  background-image: linear-gradient(
    to right,
    var(--mini-lyric-played) 50%,
    var(--mini-lyric-unplayed) 50%
  );
  background-clip: text;
  -webkit-background-clip: text;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
  will-change: background-position-x;
}

.mini-lyric-line.active .mini-lyric-primary {
  text-shadow: 0 0 0 currentColor;
}

.mini-lyric-secondary {
  display: block;
  white-space: nowrap;
  margin-top: 3px;
  font-size: var(--mini-lyric-secondary-size);
  line-height: calc(var(--mini-lyric-secondary-size) * 1.363636);
  font-weight: var(--mini-lyric-secondary-weight);
  color: var(--mini-lyric-unplayed);
}

.mini-lyric-line.active .mini-lyric-secondary {
  color: var(--mini-lyric-played);
}

.mini-lyric-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
}
</style>
