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
import type { DesktopLyricSettings, DesktopLyricSnapshot, LyricCharacterPayload } from '../../shared/desktop-lyric';

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
const isLinux = window.electron?.platform === 'linux';
const shellRef = ref<HTMLElement | null>(null);
const controlsOverlayRef = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const isHovering = ref(false);
const nowMs = ref(0);
const dragOffset = ref({ x: 0, y: 0 });
const currentLineViewportRef = ref<HTMLElement | null>(null);
const currentLineContentRef = ref<HTMLElement | null>(null);
const nextLineViewportRef = ref<HTMLElement | null>(null);
const nextLineContentRef = ref<HTMLElement | null>(null);
const currentLineOverflow = ref(0);
const nextLineOverflow = ref(0);
let animationFrame = 0;
let measureFrame = 0;
let disposeSnapshotListener: (() => void) | null = null;

const setIgnoreMouseEvents = (ignore: boolean) => {
  if (isLinux) return;
  window.electron?.desktopLyric?.setIgnoreMouseEvents(ignore);
};

const syncMousePassthrough = (forceInteractive = false) => {
  if (forceInteractive || isDragging.value) {
    setIgnoreMouseEvents(false);
    return;
  }

  if (!snapshot.value.settings.clickThrough) {
    setIgnoreMouseEvents(false);
    return;
  }

  if (snapshot.value.settings.locked) {
    const controlsVisible = controlsOverlayRef.value?.classList.contains('show-locked-controls') ?? false;
    setIgnoreMouseEvents(!controlsVisible);
    return;
  }

  const isMouseInControls = controlsOverlayRef.value?.matches(':hover') ?? false;
  setIgnoreMouseEvents(!(isMouseInControls || isHovering.value));
};

const checkMousePosition = (event: MouseEvent) => {
  const target = event.target instanceof Element ? event.target : null;

  if (snapshot.value.settings.locked) {
    const isMouseInControls =
      target?.closest('.desktop-controls-overlay') !== null ||
      target?.closest('.desktop-lock-button') !== null;

    controlsOverlayRef.value?.classList.toggle('show-locked-controls', isMouseInControls);
    setIgnoreMouseEvents(!isMouseInControls);
    return;
  }

  const shell = shellRef.value;
  if (!shell) return;

  const rect = shell.getBoundingClientRect();
  const isMouseInContainer =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;

  const isMouseOnLyrics = target?.closest('.desktop-lyric-line-content') !== null;
  const isMouseInControls = target?.closest('.desktop-controls-overlay') !== null;

  if (isMouseOnLyrics || isMouseInControls) {
    isHovering.value = true;
  }

  if (!isMouseInContainer) {
    isHovering.value = false;
  }

  setIgnoreMouseEvents(!(isMouseInControls || isHovering.value));
};

const startDrag = (event: MouseEvent) => {
  if (snapshot.value.settings.locked) return;
  if (!isHovering.value) return;

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.desktop-controls-overlay, .desktop-resize-handle, button')) return;

  isDragging.value = true;
  dragOffset.value = {
    x: event.clientX,
    y: event.clientY,
  };
  window.electron?.desktopLyric?.startDrag(
    event.screenX - dragOffset.value.x,
    event.screenY - dragOffset.value.y,
  );
};

const onDrag = (event: MouseEvent) => {
  if (!isDragging.value) return;
  window.electron?.desktopLyric?.updateDrag(
    event.screenX - dragOffset.value.x,
    event.screenY - dragOffset.value.y,
  );
};

const resetHoverState = () => {
  isHovering.value = false;
  controlsOverlayRef.value?.classList.remove('show-locked-controls');
  syncMousePassthrough();
};

const handlePointerLeave = (event: MouseEvent) => {
  const relatedTarget = event.relatedTarget;
  if (relatedTarget instanceof Node && shellRef.value?.contains(relatedTarget)) return;
  resetHoverState();
};

const handleShellMouseLeave = () => {
  resetHoverState();
};

const endDrag = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  window.electron?.desktopLyric?.endDrag();
};

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

const currentLine = computed(() => snapshot.value.lyrics[snapshot.value.currentIndex] ?? null);
const nextLine = computed(() => snapshot.value.lyrics[snapshot.value.currentIndex + 1] ?? null);
const playback = computed(() => snapshot.value.playback);
const isDark = computed(() => effectiveTheme.value === 'dark');
const isPlaying = computed(() => Boolean(playback.value?.isPlaying));
const hasTranslation = computed(() => snapshot.value.lyrics.some((line) => Boolean(line.translated?.trim())));
const hasRomanization = computed(() => snapshot.value.lyrics.some((line) => Boolean(line.romanized?.trim())));
const canToggleSecondary = computed(() => hasTranslation.value || hasRomanization.value);
const canCycleSecondaryMode = computed(() => hasTranslation.value && hasRomanization.value);
const displayLabel = computed(() => {
  if (!snapshot.value.settings.secondaryEnabled || !canToggleSecondary.value) return '原词';
  return snapshot.value.settings.secondaryMode === 'romanization' ? '音译' : '翻译';
});
const lyricModeLabel = computed(() =>
  snapshot.value.settings.secondaryMode === 'romanization' ? '音译' : '翻译',
);
const justifyContent = computed(() => {
  const alignment = snapshot.value.settings.alignment;
  if (alignment === 'left') return 'flex-start';
  if (alignment === 'right') return 'flex-end';
  return 'center';
});

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
      ? Boolean(currentSecondaryText.value) || snapshot.value.settings.doubleLine
      : snapshot.value.settings.doubleLine,
);

const nextText = computed(() => {
  if (snapshot.value.settings.secondaryEnabled && currentSecondaryText.value) {
    return currentSecondaryText.value;
  }
  if (nextLine.value?.text?.trim()) return nextLine.value.text.trim();
  return playback.value?.artist || '听你想听';
});

watch(
  () => snapshot.value.settings.locked,
  () => {
    isHovering.value = false;
    controlsOverlayRef.value?.classList.remove('show-locked-controls');
    syncMousePassthrough();
  },
  { immediate: true },
);

watch(
  () => snapshot.value.settings.clickThrough,
  () => {
    syncMousePassthrough();
  },
);

const currentShouldScroll = computed(() => currentLineOverflow.value > 6);
const nextShouldScroll = computed(() => false);

const getScrollStyle = (overflow: number) => {
  if (overflow <= 6) return undefined;
  const duration = Math.max(4.8, Math.min(12, overflow / 48 + 3.2));
  return {
    '--desktop-scroll-distance': `${overflow}px`,
    '--desktop-scroll-duration': `${duration}s`,
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

const startResize = (direction: ResizeDirection, event: MouseEvent) => {
  if (snapshot.value.settings.locked) return;
  event.preventDefault();
  event.stopPropagation();
  syncMousePassthrough(true);
  window.electron?.desktopLyric?.startResize(direction, event.screenX, event.screenY);
  window.addEventListener('mousemove', handleResizeMove);
  window.addEventListener('mouseup', handleResizeEnd);
};

const handleResizeMove = (event: MouseEvent) => {
  window.electron?.desktopLyric?.updateResize(event.screenX, event.screenY);
};

const handleResizeEnd = () => {
  window.electron?.desktopLyric?.endResize();
  syncMousePassthrough();
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
  controlsOverlayRef.value?.classList.remove('show-locked-controls');
  syncMousePassthrough();
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

const toggleSecondary = () => {
  if (!canToggleSecondary.value) return;
  window.electron?.desktopLyric?.command('toggleLyricsMode');
};

const cycleSecondaryMode = () => {
  if (!canCycleSecondaryMode.value) return;
  window.electron?.desktopLyric?.command('cycleLyricsMode');
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
      syncMousePassthrough();
    }) ?? null;

  setIgnoreMouseEvents(true);
  document.addEventListener('mousemove', checkMousePosition);
  document.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('mouseout', handlePointerLeave);
  window.addEventListener('blur', resetHoverState);
  window.addEventListener('resize', requestMeasure);
  await nextTick();
  requestMeasure();
  tick();
});

onUnmounted(() => {
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  if (measureFrame) window.cancelAnimationFrame(measureFrame);
  document.removeEventListener('mousemove', checkMousePosition);
  document.removeEventListener('mousedown', startDrag);
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  document.removeEventListener('mouseout', handlePointerLeave);
  window.removeEventListener('blur', resetHoverState);
  window.removeEventListener('resize', requestMeasure);
  endDrag();
  handleResizeEnd();
  isHovering.value = false;
  controlsOverlayRef.value?.classList.remove('show-locked-controls');
  document.documentElement.classList.remove('desktop-lyric-window');
  document.body.classList.remove('desktop-lyric-window');
  document.getElementById('app')?.classList.remove('desktop-lyric-window');
  disposeSnapshotListener?.();
});
</script>

<template>
  <div
    class="desktop-lyric-window"
    :class="{ dark: isDark, hovering: isHovering && !snapshot.settings.locked, locked: snapshot.settings.locked }"
    :style="{
      '--desktop-lyric-font-size': `${snapshot.settings.fontSize}px`,
      '--desktop-lyric-next-size': `${snapshot.settings.fontSize}px`,
      '--desktop-played-color': snapshot.settings.playedColor,
      '--desktop-unplayed-color': snapshot.settings.unplayedColor,
      '--desktop-font-family': snapshot.settings.fontFamily,
      '--desktop-opacity': String(snapshot.settings.opacity),
      '--desktop-font-weight': snapshot.settings.bold ? '700' : '400',
    }"
  >
    <div ref="shellRef" class="desktop-shell" @mouseleave="handleShellMouseLeave">
      <div
        v-for="handle in resizeHandles"
        :key="handle.direction"
        class="desktop-resize-handle no-drag"
        :class="handle.className"
        @mousedown="startResize(handle.direction, $event)"
      ></div>
      <div class="desktop-hit-area"></div>
      <div class="desktop-background"></div>

      <div ref="controlsOverlayRef" class="desktop-controls-overlay no-drag">
        <div class="desktop-controls-wrapper" :class="{ 'locked-controls': snapshot.settings.locked }">
          <template v-if="!snapshot.settings.locked">
            <Button variant="unstyled" size="none" class="desktop-icon-btn" @click="playPrevious">
              <Icon :icon="iconStepBack" width="16" height="16" />
            </Button>
            <Button variant="unstyled" size="none" class="desktop-icon-btn" @click="togglePlayback">
              <Icon :icon="isPlaying ? iconPause : iconPlayerPlay" width="16" height="16" />
            </Button>
            <Button variant="unstyled" size="none" class="desktop-icon-btn" @click="playNext">
              <Icon :icon="iconStepForward" width="16" height="16" />
            </Button>
            <span class="desktop-toolbar-divider"></span>
            <div class="desktop-mode-group">
              <Button
                variant="unstyled"
                size="none"
                class="desktop-icon-btn desktop-toggle-btn"
                :class="{ 'is-active': snapshot.settings.secondaryEnabled }"
                :disabled="!canToggleSecondary"
                title="歌词显示模式"
                @click="toggleSecondary"
              >
                <Icon :icon="iconLanguage" width="14" height="14" />
                <span class="desktop-mode-label">{{ displayLabel }}</span>
              </Button>
              <Button
                variant="unstyled"
                size="none"
                class="desktop-icon-btn desktop-mode-switch"
                :disabled="!canCycleSecondaryMode"
                :title="`切换辅文类型：${lyricModeLabel}`"
                @click="cycleSecondaryMode"
              >
                <Icon :icon="iconChevronUpDown" width="14" height="14" />
              </Button>
            </div>
            <Button
              variant="unstyled"
              size="none"
              class="desktop-icon-btn desktop-lock-button"
              title="锁定桌面歌词"
              @click="toggleLock"
            >
              <Icon :icon="iconLock" width="16" height="16" />
            </Button>
            <Button variant="unstyled" size="none" class="desktop-icon-btn" @click="closeWindow">
              <Icon :icon="iconX" width="16" height="16" />
            </Button>
          </template>
          <template v-else>
            <Button
              variant="unstyled"
              size="none"
              class="desktop-icon-btn desktop-lock-button"
              title="解锁桌面歌词"
              @click="toggleLock"
            >
              <Icon :icon="iconLockOpen" width="16" height="16" />
            </Button>
          </template>
        </div>
      </div>

      <div class="desktop-content-layout">
        <div class="desktop-top-safe"></div>
        <div class="desktop-lyric-stage" :style="{ justifyContent }">
          <div class="desktop-lyric-stack" :class="{ 'double-line': showSecondaryLine }">
            <div
              ref="currentLineViewportRef"
              class="desktop-lyric-line current"
              :class="{ 'is-scrolling': currentShouldScroll }"
              :style="{ justifyContent: currentShouldScroll ? 'flex-start' : justifyContent }"
            >
              <div
                ref="currentLineContentRef"
                :key="`${currentText}-${snapshot.currentIndex}`"
                class="desktop-lyric-line-content"
                :style="getScrollStyle(currentLineOverflow)"
              >
                <template v-if="currentChars">
                  <span
                    v-for="(char, index) in currentChars"
                    :key="`${currentText}-${index}-${char.startTime}`"
                    class="desktop-char"
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
                    class="desktop-char"
                    :style="{
                      color: snapshot.settings.unplayedColor,
                      WebkitTextStroke: snapshot.settings.strokeEnabled
                        ? `1px ${snapshot.settings.strokeColor}`
                        : '0 transparent',
                    }"
                    >{{ currentText }}</span
                  >
                </template>
              </div>
            </div>
            <div
              v-if="showSecondaryLine"
              ref="nextLineViewportRef"
              class="desktop-lyric-line next"
              :class="{
                'is-secondary': Boolean(currentSecondaryText),
                'is-scrolling': nextShouldScroll,
              }"
              :style="{ justifyContent: nextShouldScroll ? 'flex-start' : justifyContent }"
            >
              <div
                ref="nextLineContentRef"
                :key="`${nextText}-${snapshot.currentIndex}`"
                class="desktop-lyric-line-content"
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

.desktop-lyric-window {
  width: 100vw;
  height: 100vh;
  background: transparent;
  overflow: hidden;
  user-select: none;
}

.desktop-shell {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 0;
}

.desktop-hit-area {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: transparent;
  pointer-events: none;
}

.desktop-resize-handle {
  position: absolute;
  z-index: 5;
}

.desktop-resize-handle.top,
.desktop-resize-handle.bottom {
  left: 14px;
  right: 14px;
  height: 8px;
}

.desktop-resize-handle.left,
.desktop-resize-handle.right {
  top: 14px;
  bottom: 14px;
  width: 8px;
}

.desktop-resize-handle.top {
  top: 0;
  cursor: ns-resize;
}

.desktop-resize-handle.bottom {
  bottom: 0;
  cursor: ns-resize;
}

.desktop-resize-handle.left {
  left: 0;
  cursor: ew-resize;
}

.desktop-resize-handle.right {
  right: 0;
  cursor: ew-resize;
}

.desktop-resize-handle.top-left,
.desktop-resize-handle.top-right,
.desktop-resize-handle.bottom-left,
.desktop-resize-handle.bottom-right {
  width: 14px;
  height: 14px;
}

.desktop-resize-handle.top-left {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.desktop-resize-handle.top-right {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.desktop-resize-handle.bottom-left {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.desktop-resize-handle.bottom-right {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.desktop-background {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 0;
  background: rgba(255, 255, 255, calc(var(--desktop-opacity) * 0.96));
  border: 1px solid rgba(255, 255, 255, 0.82);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(18px);
  opacity: 0;
  transition: opacity 160ms ease;
}

.desktop-lyric-window.hovering .desktop-background {
  opacity: 1;
}

.dark .desktop-background {
  background: rgba(13, 18, 29, calc(var(--desktop-opacity) * 0.88));
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
}

.desktop-controls-overlay {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 3;
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
  pointer-events: auto;
}

.desktop-lyric-window.hovering .desktop-controls-overlay {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.desktop-lyric-window.locked .desktop-controls-overlay {
  opacity: 0;
}

.desktop-lyric-window.locked .desktop-controls-overlay.show-locked-controls {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.desktop-controls-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(255, 255, 255, 0.88);
  padding: 0;
}

.desktop-controls-wrapper.locked-controls {
  padding: 0;
  min-width: auto;
}

.desktop-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: transparent;
  backdrop-filter: none;
}

.desktop-mode-group {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 3px;
  height: 33.5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  box-shadow: 0 12px 28px rgba(148, 163, 184, 0.1);
  backdrop-filter: blur(18px);
}

.desktop-toggle-btn.is-active {
  opacity: 1;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 10px 24px rgba(148, 163, 184, 0.14);
}

.desktop-toggle-btn {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: max-content;
  flex-shrink: 0;
  height: 27.5px;
  padding: 0 12px;
  gap: 6px;
  border-radius: 999px;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow: none;
  transition: all 0.2s ease;
}

.desktop-mode-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27.5px;
  height: 27.5px;
  margin-left: 2px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.34);
  box-shadow: none;
  backdrop-filter: blur(18px);
  opacity: 0.92;
  transition: all 0.2s ease;
}

.desktop-mode-label {
  display: inline-block;
  min-width: 2em;
  line-height: 1;
  white-space: nowrap;
  color: rgba(15, 23, 42, 0.88);
}

.desktop-mode-switch:hover,
.desktop-toggle-btn:hover {
  transform: translateY(-1px);
}

.desktop-mode-switch:hover {
  background: rgba(255, 255, 255, 0.62);
}

.desktop-icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.dark .desktop-mode-group {
  background: rgba(14, 18, 26, 0.66);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .desktop-toggle-btn.is-active {
  background: rgba(40, 54, 78, 0.96);
  box-shadow: inset 0 0 0 1px rgba(147, 197, 253, 0.2);
}

.dark .desktop-mode-label {
  color: rgba(255, 255, 255, 0.9);
}

.dark .desktop-mode-switch {
  background: rgba(28, 36, 52, 0.92);
  border-color: rgba(255, 255, 255, 0.12);
}

.dark .desktop-mode-switch:hover {
  background: rgba(40, 54, 78, 0.96);
}

.desktop-toolbar-divider {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.12);
}

.desktop-content-layout {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
}

.desktop-top-safe {
  flex: 0 0 42px;
}

.desktop-lyric-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  padding: 6px 20px 8px;
}

.desktop-lyric-stack {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 0 4px;
  text-align: center;
}

.desktop-lyric-stack.double-line {
  gap: 10px;
  justify-content: space-between;
}

.desktop-lyric-line {
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.desktop-lyric-line.current {
  min-height: calc(var(--desktop-lyric-font-size) * 1.36);
  font-size: var(--desktop-lyric-font-size);
  font-family: var(--desktop-font-family);
  font-weight: var(--desktop-font-weight);
  line-height: 1.28;
}

.desktop-lyric-line.next {
  min-height: calc(var(--desktop-lyric-next-size) * 1.28);
  font-size: var(--desktop-lyric-next-size);
  font-family: var(--desktop-font-family);
  font-weight: calc(var(--desktop-font-weight) - 100);
  line-height: 1.22;
  opacity: 0.88;
}

.desktop-lyric-line.next.is-secondary {
  font-size: calc(var(--desktop-lyric-next-size) * 0.72);
  opacity: 0.82;
}

.desktop-lyric-line-content {
  display: inline-flex;
  align-items: center;
  gap: 0;
  white-space: nowrap;
  transform: translateX(0);
}

.desktop-lyric-line.is-scrolling .desktop-lyric-line-content {
  animation: desktop-lyric-marquee var(--desktop-scroll-duration) ease-in-out infinite alternate;
  will-change: transform;
}

.desktop-char {
  display: inline-block;
  white-space: pre;
  transition: color 90ms linear;
}

@keyframes desktop-lyric-marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(calc(var(--desktop-scroll-distance, 0px) * -1));
  }
}
</style>
