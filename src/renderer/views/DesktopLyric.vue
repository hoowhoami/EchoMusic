<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import {
  iconChevronUpDown,
  iconLanguage,
  iconLock,
  iconLockOpen,
  iconPlayerPlay,
  iconPause,
  iconStepBack,
  iconStepForward,
  iconX,
} from '@/icons';
import type {
  DesktopLyricAlign,
  DesktopLyricPointerState,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  LyricCharacterPayload,
} from '../../shared/desktop-lyric';

const defaultSettings: DesktopLyricSettings = {
  enabled: false,
  locked: false,
  clickThrough: true,
  autoShow: true,
  alwaysOnTop: true,
  secondaryEnabled: false,
  theme: 'system',
  opacity: 0.92,
  scale: 1,
  fontFamily:
    'SF Pro Display, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Inter, system-ui, sans-serif',
  inactiveFontSize: 26,
  activeFontSize: 40,
  secondaryFontSize: 18,
  lineGap: 14,
  width: 960,
  height: 220,
  secondaryMode: 'none',
  alignment: 'center',
  fontSize: 30,
  doubleLine: true,
  playedColor: '#31cfa1',
  unplayedColor: '#b9b9b9',
  strokeColor: '#f1b8b3',
  strokeEnabled: false,
  bold: false,
};

const fallbackSnapshot: DesktopLyricSnapshot = {
  playback: null,
  lyrics: [],
  currentIndex: -1,
  settings: defaultSettings,
  lockPhase: 'idle',
};

const snapshot = ref<DesktopLyricSnapshot>(fallbackSnapshot);
const pointerState = ref<DesktopLyricPointerState>({
  insideWindow: false,
  insideUnlockHotzone: false,
  insideToolbarHotzone: false,
});
const isHovering = ref(false);
const nowMs = ref(0);
const currentLineViewportRef = ref<HTMLElement | null>(null);
const currentLineContentRef = ref<HTMLElement | null>(null);
const nextLineViewportRef = ref<HTMLElement | null>(null);
const nextLineContentRef = ref<HTMLElement | null>(null);
const currentLineOverflow = ref(0);
const nextLineOverflow = ref(0);
let animationFrame = 0;
let measureFrame = 0;
let disposeSnapshotListener: (() => void) | null = null;
let disposeHoverStateListener: (() => void) | null = null;

const alignOptions = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
];

type ResizeDirection =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

const resizeHandles: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: 'top', className: 'top' },
  { direction: 'right', className: 'right' },
  { direction: 'bottom', className: 'bottom' },
  { direction: 'left', className: 'left' },
  { direction: 'top-left', className: 'top-left' },
  { direction: 'top-right', className: 'top-right' },
  { direction: 'bottom-left', className: 'bottom-left' },
  { direction: 'bottom-right', className: 'bottom-right' },
];

const effectiveTheme = computed(() => {
  const theme = snapshot.value.settings.theme;
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
});

const isDark = computed(() => effectiveTheme.value === 'dark');
const currentLine = computed(() => snapshot.value.lyrics[snapshot.value.currentIndex] ?? null);
const nextLine = computed(() => snapshot.value.lyrics[snapshot.value.currentIndex + 1] ?? null);
const playback = computed(() => snapshot.value.playback);
const isPlaying = computed(() => Boolean(playback.value?.isPlaying));
const hasTranslation = computed(() => snapshot.value.lyrics.some((line) => Boolean(line.translated?.trim())));
const hasRomanization = computed(() => snapshot.value.lyrics.some((line) => Boolean(line.romanized?.trim())));
const canToggleSecondary = computed(() => hasTranslation.value || hasRomanization.value);
const canCycleSecondaryMode = computed(() => hasTranslation.value && hasRomanization.value);
const displayLabel = computed(() => {
  if (!snapshot.value.settings.secondaryEnabled || !canToggleSecondary.value) return '原词';
  return lyricModeLabel.value;
});
const lyricModeLabel = computed(() => {
  return snapshot.value.settings.secondaryMode === 'romanization' ? '音译' : '翻译';
});
const justifyContent = computed(() => {
  const alignment = snapshot.value.settings.alignment;
  if (alignment === 'left') return 'flex-start';
  if (alignment === 'right') return 'flex-end';
  return 'center';
});
const showChrome = computed(
  () =>
    !snapshot.value.settings.locked &&
    snapshot.value.lockPhase !== 'unlocking' &&
    pointerState.value.insideWindow,
);
const showUnlockChip = computed(
  () =>
    snapshot.value.settings.locked &&
    snapshot.value.lockPhase !== 'locking' &&
    pointerState.value.insideWindow,
);

const currentMs = computed(() => {
  const state = playback.value;
  if (!state) return 0;
  const base = Math.round((state.currentTime || 0) * 1000);
  if (!state.isPlaying) return base;
  const elapsed = Math.max(0, performance.now() - state.updatedAt);
  return base + elapsed * Math.max(0.5, state.playbackRate || 1);
});

const getCharProgress = (char: LyricCharacterPayload) => {
  const start = Number(char.startTime) || 0;
  const end = Math.max(start + 24, Number(char.endTime) || start + 140);
  if (nowMs.value <= start) return 0;
  if (nowMs.value >= end) return 1;
  return (nowMs.value - start) / (end - start);
};

const currentText = computed(() => {
  if (currentLine.value?.text?.trim()) return currentLine.value.text.trim();
  return playback.value?.title || 'EchoMusic';
});

const currentSecondaryText = computed(() => {
  const line = currentLine.value;
  if (!snapshot.value.settings.secondaryEnabled || !line) return '';
  const romanized = line.romanized?.trim() ?? '';
  const translated = line.translated?.trim() ?? '';
  if (snapshot.value.settings.secondaryMode === 'romanization') return romanized || translated;
  if (snapshot.value.settings.secondaryMode === 'translation') return translated || romanized;
  return '';
});

const showSecondaryLine = computed(
  () =>
    snapshot.value.settings.secondaryEnabled
      ? Boolean(currentSecondaryText.value)
      : snapshot.value.settings.doubleLine,
);

const nextText = computed(() => {
  if (snapshot.value.settings.secondaryEnabled) return currentSecondaryText.value;
  if (nextLine.value?.text?.trim()) return nextLine.value.text.trim();
  return playback.value?.artist || '听你想听';
});

const currentShouldScroll = computed(() => currentLineOverflow.value > 6);
const nextShouldScroll = computed(() => false);

const getScrollStyle = (overflow: number) => {
  if (overflow <= 6) return undefined;
  const duration = Math.max(4.8, Math.min(12, overflow / 48 + 3.2));
  return {
    '--qq-scroll-distance': `${overflow}px`,
    '--qq-scroll-duration': `${duration}s`,
  };
};

const measureLineOverflow = (viewport: HTMLElement | null, content: HTMLElement | null) => {
  if (!viewport || !content) return 0;
  return Math.max(0, Math.ceil(content.scrollWidth - viewport.clientWidth));
};

const measureOverflow = () => {
  currentLineOverflow.value = measureLineOverflow(
    currentLineViewportRef.value,
    currentLineContentRef.value,
  );
  nextLineOverflow.value = measureLineOverflow(nextLineViewportRef.value, nextLineContentRef.value);
};

const requestMeasure = () => {
  if (measureFrame) window.cancelAnimationFrame(measureFrame);
  measureFrame = window.requestAnimationFrame(() => {
    measureFrame = 0;
    measureOverflow();
  });
};

const currentChars = computed(() => {
  if (currentLine.value?.characters?.length) return currentLine.value.characters;
  if (currentLine.value?.text?.trim()) {
    return Array.from(currentLine.value.text.trim()).map((char, index) => ({
      text: char,
      startTime: index * 70,
      endTime: (index + 1) * 70,
    }));
  }
  return null;
});

watch(
  [
    currentText,
    nextText,
    currentSecondaryText,
    () => snapshot.value.settings.fontSize,
    () => snapshot.value.settings.secondaryFontSize,
    () => snapshot.value.settings.doubleLine,
    () => snapshot.value.settings.bold,
  ],
  async () => {
    await nextTick();
    requestMeasure();
  },
  { immediate: true },
);

const syncSettings = async (partial: Partial<DesktopLyricSettings>) => {
  if (!window.electron?.desktopLyric) return snapshot.value;
  snapshot.value = await window.electron.desktopLyric.updateSettings({
    ...snapshot.value.settings,
    ...partial,
  });
  return snapshot.value;
};

const setHoverState = (hovering: boolean) => {
  if (snapshot.value.settings.locked) return;
  isHovering.value = hovering;
  window.electron?.desktopLyric?.setHover?.(hovering);
};

const startResize = (direction: ResizeDirection, event: MouseEvent) => {
  if (snapshot.value.settings.locked) return;
  event.preventDefault();
  event.stopPropagation();
  window.electron?.desktopLyric?.startResize(direction, event.screenX, event.screenY);
  window.addEventListener('mousemove', handleResizeMove);
  window.addEventListener('mouseup', handleResizeEnd);
};

const handleResizeMove = (event: MouseEvent) => {
  window.electron?.desktopLyric?.updateResize(event.screenX, event.screenY);
};

const handleResizeEnd = () => {
  window.electron?.desktopLyric?.endResize();
  window.removeEventListener('mousemove', handleResizeMove);
  window.removeEventListener('mouseup', handleResizeEnd);
};

const closeWindow = async () => {
  if (!window.electron?.desktopLyric) return;
  snapshot.value = await window.electron.desktopLyric.hide();
};

const toggleLock = async () => {
  if (!window.electron?.desktopLyric) return;
  snapshot.value = await window.electron.desktopLyric.toggleLock();
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

const toggleSecondary = async () => {
  if (!canToggleSecondary.value) return;
  snapshot.value = await syncSettings({
    secondaryEnabled: !snapshot.value.settings.secondaryEnabled,
    secondaryMode:
      snapshot.value.settings.secondaryMode === 'none'
        ? hasRomanization.value
          ? 'romanization'
          : 'translation'
        : snapshot.value.settings.secondaryMode,
  });
};

const cycleSecondaryMode = async () => {
  if (!canCycleSecondaryMode.value) return;
  snapshot.value = await syncSettings({
    secondaryMode:
      snapshot.value.settings.secondaryMode === 'translation' ? 'romanization' : 'translation',
  });
};

const tick = () => {
  nowMs.value = currentMs.value;
  animationFrame = window.requestAnimationFrame(tick);
};

onMounted(async () => {
  document.documentElement.classList.add('desktop-lyric-window');
  document.body.classList.add('desktop-lyric-window');
  document.getElementById('app')?.classList.add('desktop-lyric-window');
  snapshot.value = (await window.electron?.desktopLyric?.getSnapshot()) ?? fallbackSnapshot;
  disposeSnapshotListener =
    window.electron?.desktopLyric?.onSnapshot((nextSnapshot) => {
      snapshot.value = nextSnapshot;
    }) ?? null;
  disposeHoverStateListener =
    window.electron?.desktopLyric?.onPointerState((nextPointerState) => {
      pointerState.value = nextPointerState;
    }) ?? null;
  window.electron?.desktopLyric?.setHover?.(false);
  window.addEventListener('resize', requestMeasure);
  await nextTick();
  requestMeasure();
  tick();
});

onUnmounted(() => {
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  if (measureFrame) window.cancelAnimationFrame(measureFrame);
  window.removeEventListener('resize', requestMeasure);
  handleResizeEnd();
  pointerState.value = {
    insideWindow: false,
    insideUnlockHotzone: false,
    insideToolbarHotzone: false,
  };
  window.electron?.desktopLyric?.setHover?.(false);
  document.documentElement.classList.remove('desktop-lyric-window');
  document.body.classList.remove('desktop-lyric-window');
  document.getElementById('app')?.classList.remove('desktop-lyric-window');
  disposeSnapshotListener?.();
  disposeHoverStateListener?.();
});
</script>

<template>
  <div
    class="qq-desktop-lyric"
    :class="{ dark: isDark, hovering: showChrome }"
    :style="{
      '--qq-lyric-font-size': `${snapshot.settings.fontSize}px`,
      '--qq-lyric-next-size': `${snapshot.settings.fontSize}px`,
      '--qq-played-color': snapshot.settings.playedColor,
      '--qq-unplayed-color': snapshot.settings.unplayedColor,
      '--qq-font-family': snapshot.settings.fontFamily,
      '--qq-opacity': String(snapshot.settings.opacity),
      '--qq-font-weight': snapshot.settings.bold ? '700' : '400',
    }"
    @mouseenter="setHoverState(true)"
    @mousemove="setHoverState(true)"
    @mouseleave="setHoverState(false)"
  >
    <div class="qq-shell drag">
      <div
        v-for="handle in resizeHandles"
        :key="handle.direction"
        class="qq-resize-handle no-drag"
        :class="handle.className"
        @mousedown="startResize(handle.direction, $event)"
      ></div>
      <div class="qq-hit-area"></div>
      <div class="qq-background" :class="{ visible: showChrome }"></div>

      <div
        v-if="snapshot.settings.locked"
        class="qq-lock-state no-drag"
        :class="{ visible: showUnlockChip }"
      >
        <Button
          variant="unstyled"
          size="none"
          class="qq-unlock-chip"
          title="解锁桌面歌词"
          @click="toggleLock"
        >
          <Icon :icon="iconLockOpen" width="14" height="14" />
          <span>解锁</span>
        </Button>
      </div>

      <div v-else class="qq-toolbar no-drag" :class="{ visible: showChrome }">
        <div class="qq-toolbar-main">
          <Button variant="unstyled" size="none" class="qq-icon-btn" @click="playPrevious">
            <Icon :icon="iconStepBack" width="16" height="16" />
          </Button>
          <Button variant="unstyled" size="none" class="qq-icon-btn" @click="togglePlayback">
            <Icon :icon="isPlaying ? iconPause : iconPlayerPlay" width="16" height="16" />
          </Button>
          <Button variant="unstyled" size="none" class="qq-icon-btn" @click="playNext">
            <Icon :icon="iconStepForward" width="16" height="16" />
          </Button>
          <span class="qq-toolbar-divider"></span>
          <div class="qq-mode-group">
            <Button
              variant="unstyled"
              size="none"
              class="qq-icon-btn qq-toggle-btn"
              :class="{ 'is-active': snapshot.settings.secondaryEnabled }"
              :disabled="!canToggleSecondary"
              title="歌词显示模式"
              @click="toggleSecondary"
            >
              <Icon :icon="iconLanguage" width="16" height="16" />
              <span class="qq-mode-label">{{ displayLabel }}</span>
            </Button>
            <Button
              variant="unstyled"
              size="none"
              class="qq-icon-btn qq-mode-switch"
              :disabled="!canCycleSecondaryMode"
              :title="`切换辅文类型：${lyricModeLabel}`"
              @click="cycleSecondaryMode"
            >
              <Icon :icon="iconChevronUpDown" width="16" height="16" />
            </Button>
          </div>
          <Button
            variant="unstyled"
            size="none"
            class="qq-icon-btn"
            title="锁定桌面歌词"
            @click="toggleLock"
          >
            <Icon :icon="iconLock" width="16" height="16" />
          </Button>
          <Button variant="unstyled" size="none" class="qq-icon-btn" @click="closeWindow">
            <Icon :icon="iconX" width="16" height="16" />
          </Button>
        </div>
      </div>

      <div class="qq-content-layout">
        <div class="qq-top-safe"></div>
        <div class="qq-lyric-stage" :style="{ justifyContent }">
          <div class="qq-lyric-stack" :class="{ 'double-line': showSecondaryLine }">
            <div
              ref="currentLineViewportRef"
              class="qq-lyric-line current"
              :class="{ 'is-scrolling': currentShouldScroll }"
              :style="{ justifyContent: currentShouldScroll ? 'flex-start' : justifyContent }"
            >
              <div
                ref="currentLineContentRef"
                :key="`${currentText}-${snapshot.currentIndex}`"
                class="qq-lyric-line-content"
                :style="getScrollStyle(currentLineOverflow)"
              >
                <template v-if="currentChars">
                  <span
                    v-for="(char, index) in currentChars"
                    :key="`${currentText}-${index}-${char.startTime}`"
                    class="qq-char"
                    :style="{
                      color:
                        getCharProgress(char) >= 1
                          ? snapshot.settings.playedColor
                          : snapshot.settings.unplayedColor,
                      WebkitTextStroke: snapshot.settings.strokeEnabled
                        ? `1px ${snapshot.settings.strokeColor}`
                        : '0 transparent',
                    }"
                  >
                    {{ char.text }}
                  </span>
                </template>
                <template v-else>
                  <span
                    class="qq-char"
                    :style="{
                      color: snapshot.settings.unplayedColor,
                      WebkitTextStroke: snapshot.settings.strokeEnabled
                        ? `1px ${snapshot.settings.strokeColor}`
                        : '0 transparent',
                    }"
                  >{{ currentText }}</span>
                </template>
              </div>
            </div>
            <div
              v-if="showSecondaryLine"
              ref="nextLineViewportRef"
              class="qq-lyric-line next"
              :class="{
                'is-secondary': Boolean(currentSecondaryText),
                'is-scrolling': nextShouldScroll,
              }"
              :style="{ justifyContent: nextShouldScroll ? 'flex-start' : justifyContent }"
            >
              <div
                ref="nextLineContentRef"
                :key="`${nextText}-${snapshot.currentIndex}`"
                class="qq-lyric-line-content"
                :style="getScrollStyle(nextLineOverflow)"
              >
                {{ nextText }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.qq-desktop-lyric {
  width: 100vw;
  height: 100vh;
  background: transparent;
  overflow: hidden;
  user-select: none;
}

.qq-shell {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 0;
}

.qq-hit-area {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: transparent;
  pointer-events: none;
}

.qq-resize-handle {
  position: absolute;
  z-index: 5;
}

.qq-resize-handle.top,
.qq-resize-handle.bottom {
  left: 14px;
  right: 14px;
  height: 8px;
}

.qq-resize-handle.left,
.qq-resize-handle.right {
  top: 14px;
  bottom: 14px;
  width: 8px;
}

.qq-resize-handle.top {
  top: 0;
  cursor: ns-resize;
}

.qq-resize-handle.bottom {
  bottom: 0;
  cursor: ns-resize;
}

.qq-resize-handle.left {
  left: 0;
  cursor: ew-resize;
}

.qq-resize-handle.right {
  right: 0;
  cursor: ew-resize;
}

.qq-resize-handle.top-left,
.qq-resize-handle.top-right,
.qq-resize-handle.bottom-left,
.qq-resize-handle.bottom-right {
  width: 14px;
  height: 14px;
}

.qq-resize-handle.top-left {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.qq-resize-handle.top-right {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.qq-resize-handle.bottom-left {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.qq-resize-handle.bottom-right {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.qq-background {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 0;
  background: rgba(255, 255, 255, calc(var(--qq-opacity) * 0.96));
  border: 1px solid rgba(255, 255, 255, 0.82);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(18px);
  opacity: 0;
  transition: opacity 160ms ease;
}

.qq-background.visible {
  opacity: 1;
}

.dark .qq-background {
  background: rgba(13, 18, 29, calc(var(--qq-opacity) * 0.88));
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
}

.qq-toolbar,
.qq-lock-state {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 3;
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.qq-toolbar.visible,
.qq-lock-state.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.qq-toolbar-main {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(0, 0, 0, 0.56);
}

.dark .qq-toolbar-main {
  color: rgba(255, 255, 255, 0.72);
}

.qq-icon-btn,
.qq-unlock-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  backdrop-filter: blur(10px);
}

.qq-icon-btn {
  width: 28px;
  height: 28px;
}

.qq-mode-btn:disabled {
  opacity: 0.38;
}

.qq-mode-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.05);
}

.qq-toggle-btn.is-active {
  background: rgba(0, 0, 0, 0.12);
}

.qq-mode-btn,
.qq-toggle-btn {
  width: auto;
  min-width: 26px;
  padding: 0 8px;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
  box-shadow: none;
}

.qq-mode-switch {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: transparent;
}

.qq-mode-label {
  line-height: 1;
  white-space: nowrap;
}

.dark .qq-mode-group {
  background: rgba(255, 255, 255, 0.08);
}

.dark .qq-toggle-btn.is-active {
  background: rgba(255, 255, 255, 0.16);
}

.qq-mode-switch:hover,
.qq-toggle-btn:hover {
  background: rgba(0, 0, 0, 0.08);
}

.dark .qq-mode-switch:hover,
.dark .qq-toggle-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.qq-unlock-chip {
  height: 28px;
  padding: 0 10px;
  gap: 4px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.28);
}

.qq-icon-btn:hover,
.qq-unlock-chip:hover {
  background: rgba(0, 0, 0, 0.06);
}

.dark .qq-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.dark .qq-unlock-chip {
  background: rgba(15, 23, 42, 0.6);
}

.qq-toolbar-divider {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: rgba(0, 0, 0, 0.12);
}

.dark .qq-toolbar-divider {
  background: rgba(255, 255, 255, 0.12);
}

.qq-content-layout {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  pointer-events: none;
}

.qq-top-safe {
  flex: 0 0 42px;
}

.qq-lyric-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  padding: 6px 20px 8px;
}

.qq-lyric-stack {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 0 4px;
  text-align: center;
}

.qq-lyric-stack.double-line {
  gap: 10px;
  justify-content: space-between;
}

.qq-lyric-line {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  font-family: var(--qq-font-family);
  font-weight: var(--qq-font-weight);
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
}

.qq-lyric-line-content {
  display: inline-flex;
  align-items: center;
  min-width: max-content;
  max-width: none;
  transform: translate3d(0, 0, 0);
  will-change: transform;
}

.qq-lyric-line.is-scrolling .qq-lyric-line-content {
  animation: qq-lyric-marquee var(--qq-scroll-duration, 6s) linear forwards;
}

.qq-lyric-line.current {
  font-size: var(--qq-lyric-font-size);
  line-height: 1.28;
}

.qq-lyric-stack:not(.double-line) .qq-lyric-line.current {
  min-height: calc(var(--qq-lyric-font-size) * 1.46);
}

.qq-lyric-line.next {
  font-size: var(--qq-lyric-next-size);
  line-height: 1.28;
  color: rgba(127, 127, 127, 0.9);
}

.qq-lyric-line.next.is-secondary {
  opacity: 0.92;
}

.dark .qq-lyric-line.next {
  color: rgba(220, 220, 220, 0.72);
}

.qq-char {
  display: inline-block;
  white-space: pre;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.12);
}

.dark .qq-char {
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.22);
}

@keyframes qq-lyric-marquee {
  0%,
  22% {
    transform: translate3d(0, 0, 0);
  }

  100% {
    transform: translate3d(calc(-1 * var(--qq-scroll-distance, 0px)), 0, 0);
  }
}
</style>
