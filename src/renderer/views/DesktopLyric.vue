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
  unplayedColor: '#7a7a7a',
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
const lyricsContainerRef = ref<HTMLElement | null>(null);
const activeLyricsContentRef = ref<HTMLElement | null>(null);
const currentLineScrollX = ref(0);
let animationFrame = 0;
let disposeSnapshotListener: (() => void) | null = null;

// ── Color helpers (ported from MoeKoeMusic) ──

const FALLBACK_COLOR = '#D4D4D4';
let colorContext: CanvasRenderingContext2D | null = null;

const getColorContext = () => {
  if (colorContext) return colorContext;
  const canvas = document.createElement('canvas');
  colorContext = canvas.getContext('2d');
  return colorContext;
};

const clampChannel = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

const parseHexColor = (hex: string) => {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

const parseRgbString = (s: string) => {
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const [r = '0', g = '0', b = '0'] = m[1].split(',').map((x) => x.trim());
  return {
    r: clampChannel(parseFloat(r)),
    g: clampChannel(parseFloat(g)),
    b: clampChannel(parseFloat(b)),
  };
};

const parseColorToRgb = (color: string) => {
  const ctx = getColorContext();
  if (!ctx) return parseHexColor(FALLBACK_COLOR);
  ctx.fillStyle = FALLBACK_COLOR;
  ctx.fillStyle = color;
  const n = ctx.fillStyle;
  if (n.startsWith('#')) return parseHexColor(n);
  if (n.startsWith('rgb')) {
    const rgb = parseRgbString(n);
    if (rgb) return rgb;
  }
  return parseHexColor(FALLBACK_COLOR);
};

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('')}`;

const shiftRgb = (rgb: { r: number; g: number; b: number }, offset: number) => ({
  r: clampChannel(rgb.r + offset),
  g: clampChannel(rgb.g + offset),
  b: clampChannel(rgb.b + offset),
});

const buildVerticalGradient = (baseColor: string) => {
  const rgb = parseColorToRgb(baseColor);
  return `linear-gradient(to bottom, ${rgbToHex(shiftRgb(rgb, -38))}, ${rgbToHex(shiftRgb(rgb, 28))})`;
};

// ── Mouse / passthrough ──

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
    const vis = controlsOverlayRef.value?.classList.contains('show-locked-controls') ?? false;
    setIgnoreMouseEvents(!vis);
    return;
  }
  const inCtrl = controlsOverlayRef.value?.matches(':hover') ?? false;
  setIgnoreMouseEvents(!(inCtrl || isHovering.value));
};

const checkMousePosition = (event: MouseEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  if (snapshot.value.settings.locked) {
    const inCtrl =
      target?.closest('.desktop-controls-overlay') !== null ||
      target?.closest('.desktop-lock-button') !== null;
    controlsOverlayRef.value?.classList.toggle('show-locked-controls', inCtrl);
    setIgnoreMouseEvents(!inCtrl);
    return;
  }
  const shell = shellRef.value;
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const inContainer =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  const onLyrics = target?.closest('.lyrics-content') !== null;
  const inControls = target?.closest('.desktop-controls-overlay') !== null;
  if (onLyrics || inControls) isHovering.value = true;
  if (!inContainer) isHovering.value = false;
  setIgnoreMouseEvents(!(inControls || isHovering.value));
};

// ── Drag ──

const startDrag = (event: MouseEvent) => {
  if (snapshot.value.settings.locked) return;
  if (!isHovering.value) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.desktop-controls-overlay, .desktop-resize-handle, button')) return;
  isDragging.value = true;
  dragOffset.value = { x: event.clientX, y: event.clientY };
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
  const related = event.relatedTarget;
  if (related instanceof Node && shellRef.value?.contains(related)) return;
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

// ── Resize ──

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

// ── Computed state ──

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
const hasTranslation = computed(() =>
  snapshot.value.lyrics.some((l) => Boolean(l.translated?.trim())),
);
const hasRomanization = computed(() =>
  snapshot.value.lyrics.some((l) => Boolean(l.romanized?.trim())),
);
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
  const a = snapshot.value.settings.alignment;
  if (a === 'left') return 'flex-start';
  if (a === 'right') return 'flex-end';
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

const showSecondaryLine = computed(() =>
  snapshot.value.settings.secondaryEnabled
    ? Boolean(currentSecondaryText.value) || snapshot.value.settings.doubleLine
    : snapshot.value.settings.doubleLine,
);

const nextText = computed(() => {
  if (snapshot.value.settings.secondaryEnabled && currentSecondaryText.value)
    return currentSecondaryText.value;
  if (nextLine.value?.text?.trim()) return nextLine.value.text.trim();
  return playback.value?.artist || '听你想听';
});

// ── Displayed lines ──

const displayedLines = computed(() => {
  const idx = snapshot.value.currentIndex;
  return [idx, idx + 1];
});

// ── Character-level highlight (MoeKoeMusic gradient approach) ──

const currentChars = computed(() => {
  if (currentLine.value?.characters?.length) return currentLine.value.characters;
  if (currentLine.value?.text?.trim()) {
    return Array.from(currentLine.value.text.trim()).map((char, i) => ({
      text: char,
      startTime: i * 70,
      endTime: (i + 1) * 70,
    }));
  }
  return null;
});

const computeHighlightProgress = (lineIndex: number) => {
  const line = snapshot.value.lyrics[lineIndex];
  if (!line?.characters?.length) return 0;
  const chars = line.characters;
  const text = line.text || '';
  const safeLen = Math.max(1, text.length);
  const lineStart = chars[0].startTime;
  const lineEnd = chars[chars.length - 1].endTime;
  const lineDuration = Math.max(1, lineEnd - lineStart);
  if (nowMs.value < lineStart) return 0;
  if (nowMs.value >= lineEnd) return 1;

  let charPos = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (nowMs.value >= c.startTime && nowMs.value <= c.endTime) {
      const dur = Math.max(1, c.endTime - c.startTime);
      const p = (nowMs.value - c.startTime) / dur;
      charPos = (i / safeLen) * 100 + p * (100 / safeLen);
      break;
    }
    if (nowMs.value > c.endTime) charPos = ((i + 1) / safeLen) * 100;
  }
  const lineProgress = Math.min(1, Math.max(0, (nowMs.value - lineStart) / lineDuration));
  return Math.max(0, Math.min(100, Math.max(charPos, lineProgress * 100))) / 100;
};

const defaultLineStyle = computed(() => ({
  background: buildVerticalGradient(snapshot.value.settings.unplayedColor),
  backgroundClip: 'text',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: 'transparent',
  fontWeight: snapshot.value.settings.bold ? '700' : '400',
}));

const getLineHighlightStyle = (lineIndex: number) => ({
  width: `${(computeHighlightProgress(lineIndex) * 100).toFixed(3)}%`,
  background: buildVerticalGradient(snapshot.value.settings.playedColor),
  backgroundClip: 'text',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: 'transparent',
  fontWeight: snapshot.value.settings.bold ? '700' : '400',
});

// ── Scroll overflow by progress (MoeKoeMusic style) ──

const throttle = <T extends (...args: unknown[]) => void>(fn: T, delay: number) => {
  let last = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      fn(...args);
    }
  };
};

const updateActiveLineScroll = () => {
  const activeIdx = displayedLines.value[0];
  const containerEl = lyricsContainerRef.value;
  const contentEl = activeLyricsContentRef.value;
  if (activeIdx === undefined || !containerEl || !contentEl) return;
  const line = snapshot.value.lyrics[activeIdx];
  if (!line) {
    if (currentLineScrollX.value !== 0) currentLineScrollX.value = 0;
    return;
  }
  const cw = containerEl.clientWidth || 0;
  const sw = contentEl.scrollWidth || 0;
  const overflow = sw - cw;
  if (overflow <= 0) {
    if (currentLineScrollX.value !== 0) currentLineScrollX.value = 0;
    return;
  }
  const progress = Math.min(1, Math.max(0, computeHighlightProgress(activeIdx)));
  if (progress <= 0) {
    if (currentLineScrollX.value !== 0) currentLineScrollX.value = 0;
    return;
  }
  const target = -overflow * progress;
  const clamped = Math.max(-overflow, Math.min(0, target));
  if (currentLineScrollX.value !== clamped) currentLineScrollX.value = clamped;
};

const scheduleScroll = throttle(() => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(updateActiveLineScroll);
  else updateActiveLineScroll();
}, 50);

// ── Watchers ──

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

watch(
  [nowMs, () => snapshot.value.currentIndex, displayedLines],
  () => {
    scheduleScroll();
  },
  { immediate: true },
);
watch(
  () => snapshot.value.lyrics,
  () => {
    scheduleScroll();
  },
);
watch(
  () => snapshot.value.settings.fontSize,
  () => {
    scheduleScroll();
  },
);

// ── Commands ──

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

// ── Color picker ──

const defaultColorInput = ref<HTMLInputElement | null>(null);
const highlightColorInput = ref<HTMLInputElement | null>(null);

const handleColorChange = (color: string, type: 'default' | 'highlight') => {
  if (type === 'default') {
    window.electron?.desktopLyric?.updateSettings({ unplayedColor: color });
  } else {
    window.electron?.desktopLyric?.updateSettings({ playedColor: color });
  }
};

// ── Tick ──

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
    window.electron?.desktopLyric?.onSnapshot((next) => {
      snapshot.value = next;
      syncMousePassthrough();
    }) ?? null;
  setIgnoreMouseEvents(true);
  document.addEventListener('mousemove', checkMousePosition);
  document.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('mouseout', handlePointerLeave);
  window.addEventListener('blur', resetHoverState);
  await nextTick();
  tick();
});

onUnmounted(() => {
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  document.removeEventListener('mousemove', checkMousePosition);
  document.removeEventListener('mousedown', startDrag);
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  document.removeEventListener('mouseout', handlePointerLeave);
  window.removeEventListener('blur', resetHoverState);
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
    :class="{
      dark: isDark,
      hovering: isHovering && !snapshot.settings.locked,
      locked: snapshot.settings.locked,
    }"
    :style="{
      '--desktop-lyric-font-size': `${snapshot.settings.fontSize}px`,
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

      <!-- Controls overlay -->
      <div ref="controlsOverlayRef" class="desktop-controls-overlay no-drag">
        <div
          class="desktop-controls-wrapper"
          :class="{ 'locked-controls': snapshot.settings.locked }"
        >
          <template v-if="!snapshot.settings.locked">
            <!-- Color pickers -->
            <div class="desktop-color-controls">
              <button
                class="desktop-color-button"
                title="默认颜色"
                @click="defaultColorInput?.click()"
              >
                <div
                  class="desktop-color-preview"
                  :style="{ backgroundColor: snapshot.settings.unplayedColor }"
                ></div>
              </button>
              <button
                class="desktop-color-button"
                title="高亮颜色"
                @click="highlightColorInput?.click()"
              >
                <div
                  class="desktop-color-preview"
                  :style="{ backgroundColor: snapshot.settings.playedColor }"
                ></div>
              </button>
              <input
                ref="defaultColorInput"
                type="color"
                :value="snapshot.settings.unplayedColor"
                class="desktop-hidden-color-input"
                @input="
                  (e: Event) => handleColorChange((e.target as HTMLInputElement).value, 'default')
                "
              />
              <input
                ref="highlightColorInput"
                type="color"
                :value="snapshot.settings.playedColor"
                class="desktop-hidden-color-input"
                @input="
                  (e: Event) => handleColorChange((e.target as HTMLInputElement).value, 'highlight')
                "
              />
            </div>
            <!-- Playback controls -->
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
            <!-- Lyrics mode -->
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
            <!-- Lock / Close -->
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

      <!-- Lyrics content (MoeKoeMusic gradient-clip approach) -->
      <div class="desktop-content-layout">
        <div class="desktop-top-safe"></div>
        <div ref="lyricsContainerRef" class="desktop-lyric-stage" :style="{ justifyContent }">
          <div class="desktop-lyric-stack" :class="{ 'double-line': showSecondaryLine }">
            <!-- Primary line -->
            <div class="lyrics-line">
              <div
                ref="activeLyricsContentRef"
                class="lyrics-content"
                :class="{ hovering: isHovering && !snapshot.settings.locked }"
                :style="{ transform: `translateX(${currentLineScrollX}px)` }"
              >
                <span class="lyrics-text">
                  <span class="lyrics-layer lyrics-layer-default" :style="defaultLineStyle">
                    {{ currentText }}
                  </span>
                  <span
                    class="lyrics-layer lyrics-layer-highlight"
                    :style="getLineHighlightStyle(displayedLines[0])"
                  >
                    {{ currentText }}
                  </span>
                </span>
              </div>
            </div>
            <!-- Secondary line: translation or next line -->
            <div class="lyrics-line" v-if="showSecondaryLine">
              <div
                class="lyrics-content"
                :class="{ hovering: isHovering && !snapshot.settings.locked }"
              >
                <template v-if="currentSecondaryText">
                  <span class="lyrics-text lyrics-text-static">
                    <span class="lyrics-layer lyrics-layer-default" :style="defaultLineStyle">
                      {{ currentSecondaryText }}
                    </span>
                  </span>
                </template>
                <template v-else-if="nextLine">
                  <span class="lyrics-text">
                    <span class="lyrics-layer lyrics-layer-default" :style="defaultLineStyle">
                      {{ nextText }}
                    </span>
                    <span
                      class="lyrics-layer lyrics-layer-highlight"
                      :style="getLineHighlightStyle(displayedLines[1] ?? -1)"
                    >
                      {{ nextText }}
                    </span>
                  </span>
                </template>
                <template v-else>
                  <span class="lyrics-text lyrics-text-static">
                    <span class="lyrics-layer lyrics-layer-default" :style="defaultLineStyle">
                      {{ nextText }}
                    </span>
                  </span>
                </template>
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

/* ── Window root ── */
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

/* ── Resize handles ── */
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

/* ── Background (EchoMusic style) ── */
.desktop-background {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 12px;
  background: rgba(255, 255, 255, calc(var(--desktop-opacity) * 0.98));
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
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

/* ── Controls overlay (EchoMusic style) ── */
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
  color: rgba(15, 23, 42, 0.92);
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
  background: rgba(255, 255, 255, 0.58);
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 6px 16px rgba(148, 163, 184, 0.12);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.desktop-icon-btn:hover {
  background: rgba(255, 255, 255, 0.88);
  transform: scale(1.1);
}
.desktop-icon-btn:active {
  transform: scale(0.95);
}

.dark .desktop-controls-wrapper {
  color: rgba(255, 255, 255, 0.88);
}
.dark .desktop-icon-btn {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.dark .desktop-icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* ── Color controls (MoeKoeMusic style) ── */
.desktop-color-controls {
  display: flex;
  gap: 4px;
  align-items: center;
}
.desktop-color-button {
  padding: 2px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.desktop-color-button:hover {
  transform: scale(1.1);
  border-color: rgba(15, 23, 42, 0.25);
}
.dark .desktop-color-button {
  border-color: rgba(255, 255, 255, 0.15);
  background: transparent;
}
.dark .desktop-color-button:hover {
  border-color: rgba(255, 255, 255, 0.3);
}
.desktop-color-preview {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.desktop-hidden-color-input {
  position: absolute;
  visibility: hidden;
  width: 0;
  height: 0;
  padding: 0;
  margin: 0;
  border: none;
}

/* ── Mode group (EchoMusic style) ── */
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
  background: rgba(15, 23, 42, 0.12);
}
.dark .desktop-toolbar-divider {
  background: rgba(255, 255, 255, 0.12);
}

/* ── Content layout ── */
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
  align-items: center;
  justify-content: center;
  padding: 6px 20px 8px;
  overflow: hidden;
}
.desktop-lyric-stack {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 6px 0 4px;
  text-align: center;
}
.desktop-lyric-stack.double-line {
  gap: 10px;
  justify-content: space-between;
}

/* ── Lyrics lines (MoeKoeMusic gradient-clip approach) ── */
.lyrics-text {
  display: inline-block;
  position: relative;
  transform: translateZ(0);
  white-space: pre;
  letter-spacing: 0.5px;
}
.lyrics-layer {
  display: block;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  white-space: pre;
}
.lyrics-layer-default {
  position: relative;
}
.lyrics-layer-highlight {
  position: absolute;
  left: 0;
  top: 0;
  overflow: hidden;
  width: 0;
  max-width: 100%;
  will-change: width;
}
.lyrics-text-static .lyrics-layer {
  position: relative;
}

.lyrics-line {
  overflow: hidden;
  position: relative;
  opacity: 1;
  will-change: background-position;
  font-size: var(--desktop-lyric-font-size);
  font-family: var(--desktop-font-family);
  font-weight: var(--desktop-font-weight);
  line-height: 1.28;
}
.lyrics-content {
  display: inline-block;
  white-space: nowrap;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 6px;
  transform: translateX(0);
  background-color: transparent;
}
.desktop-lyric-window:not(.locked) .lyrics-content.hovering:hover {
  cursor: move;
}
.nolyrics {
  margin-bottom: 30px;
}

.desktop-lock-button {
  position: relative;
  z-index: 3;
}
</style>
