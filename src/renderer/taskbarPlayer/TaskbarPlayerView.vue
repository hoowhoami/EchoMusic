<script setup lang="ts">
import '@/theme/sliders.css';
import { neutralThemePalette, DEFAULT_THEME_ACCENT } from '../../shared/themePalette';
import { createAccentPaletteFromPrimary } from '../../shared/accentPalette';
import {
  DEFAULT_TASKBAR_LYRIC_SETTINGS,
  normalizeTaskbarLyricSettings,
  type TaskbarLyricState,
} from '../../shared/taskbar';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import {
  iconHeart,
  iconHeartFilled,
  iconMusic,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
} from '@/icons';
import { SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SliderRoot from '@/components/ui/SliderRoot.vue';
import TaskbarLyricLine from './TaskbarLyricLine.vue';
import type { NowPlayingCommand } from '../../shared/nowPlaying';
import { useTaskbarSeek } from './useTaskbarSeek';
import { useTaskbarLyrics } from './useTaskbarLyrics';
const { snapshot, playback, lyric, line, nextLine, timeMs, error } = useTaskbarLyrics();
const settings = ref({ ...DEFAULT_TASKBAR_LYRIC_SETTINGS });
const dark = ref(true);
const anchor = ref('left');
const maxWidth = ref(400);
const hovered = ref(false);
const focused = ref(false);
const width = ref(160);
const primaryWidth = ref(0);
const secondaryWidth = ref(0);
const coverFailed = ref('');
const root = ref<HTMLElement>();
const colors = computed(() => {
  const palette = neutralThemePalette(dark.value);
  const accent = snapshot.value?.appearance.accentColor || DEFAULT_THEME_ACCENT;
  return {
    '--fg': palette.text,
    '--muted': palette.secondary,
    '--bg': palette.main,
    '--accent': accent,
    '--accent-text': createAccentPaletteFromPrimary(accent, dark.value, [palette.main]).primaryText,
    '--font-size': `${settings.value.fontSize}px`,
    '--lyric-unplayed': palette.secondary,
    fontFamily:
      snapshot.value?.appearance.fontFamily || '"Segoe UI", "Microsoft YaHei", sans-serif',
  };
});
const title = computed(() => playback.value?.title || 'EchoMusic');
const primary = computed(() => error.value || line.value?.text || title.value);
const secondary = computed(() => {
  if (error.value) return '';
  if (line.value) {
    if (settings.value.showTranslation && line.value.translated) return line.value.translated;
    if (lyric.value?.wantRomanization && line.value.romanized) return line.value.romanized;
    return nextLine.value?.text || playback.value?.artist || '';
  }
  return playback.value?.artist || '双击打开主窗口';
});
const seek = useTaskbarSeek(
  () => playback.value,
  (value) => window.electron?.nowPlaying.command({ type: 'seek', value }),
);
const { progressValue, duration, isDragging } = seek;
const expanded = computed(() =>
  Boolean(playback.value && (hovered.value || focused.value || isDragging.value)),
);
let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined;
const setHovered = (value: boolean) => {
  clearTimeout(hoverLeaveTimer);
  if (value) hovered.value = true;
  else
    hoverLeaveTimer = setTimeout(() => {
      hovered.value = false;
    }, 60);
};
const command = (value: NowPlayingCommand) => {
  if (playback.value) window.electron?.nowPlaying.command(value);
};
const showMain = () => window.electron?.taskbarLyric?.showMain();
let lastWidth = 0;
let alive = true;
let receivedState = false;
let disposeState: (() => void) | undefined;
const reportWidth = async () => {
  await nextTick();
  if (!alive) return;
  const element = root.value;
  if (!element) return;
  const style = getComputedStyle(element);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const coverWidth = settings.value.showCover
    ? (element.querySelector('.cover')?.getBoundingClientRect().width ?? 0) +
      parseFloat(style.columnGap)
    : 0;
  const naturalWidth = Math.ceil(
    Math.max(primaryWidth.value, secondaryWidth.value) + coverWidth + padding + 8,
  );
  width.value = Math.min(
    maxWidth.value,
    expanded.value ? maxWidth.value : Math.max(160, naturalWidth),
  );
  if (lastWidth === width.value) return;
  lastWidth = width.value;
  window.electron?.taskbarLyric?.setContentWidth(width.value);
};
watch([expanded, maxWidth, primaryWidth, secondaryWidth, settings], reportWidth, { deep: true });
watch(secondary, (value) => {
  if (!value) secondaryWidth.value = 0;
});
const focusOut = (event: FocusEvent) => {
  if (!root.value?.contains(event.relatedTarget as Node | null)) focused.value = false;
};
const stateListener = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as TaskbarLyricState;
  receivedState = true;
  dark.value = Boolean(value.isDark);
  anchor.value = value.anchor === 'right' ? 'right' : 'left';
  maxWidth.value = Number(value.maxWidth) || 400;
  settings.value = normalizeTaskbarLyricSettings(value.settings);
};
onMounted(async () => {
  const api = window.electron?.taskbarLyric;
  if (!api) {
    error.value = '连接不可用，请重新打开任务栏歌词';
    return;
  }
  disposeState = api.onStateChange(stateListener);
  try {
    const value = await api.getState();
    if (alive && !receivedState) stateListener(value);
  } catch {
    if (alive) error.value = '连接失败，请重新打开任务栏歌词';
  }
  void reportWidth();
});
onUnmounted(() => {
  alive = false;
  clearTimeout(hoverLeaveTimer);
  disposeState?.();
});
</script>
<template>
  <section
    class="taskbar"
    :class="{ dark, right: anchor === 'right' }"
    :style="colors"
    aria-label="任务栏歌词"
  >
    <div
      ref="root"
      class="content"
      role="group"
      tabindex="0"
      :aria-label="primary"
      :class="{ expanded }"
      :style="{ width: `${width}px` }"
      @mouseenter="setHovered(true)"
      @mouseleave="setHovered(false)"
      @focusin="focused = ($event.target as HTMLElement).matches(':focus-visible')"
      @focusout="focusOut"
      @dblclick="showMain"
    >
      <button
        v-if="settings.showCover"
        type="button"
        class="cover"
        aria-label="打开 EchoMusic"
        @click="showMain"
      >
        <img
          v-if="playback?.coverUrl && coverFailed !== playback.coverUrl"
          :src="playback.coverUrl"
          alt=""
          draggable="false"
          decoding="async"
          @error="coverFailed = playback?.coverUrl || ''"
        />
        <Icon v-else :icon="iconMusic" width="14" />
      </button>
      <div class="body">
        <div
          v-if="playback"
          class="controls"
          :inert="!expanded"
          :aria-hidden="!expanded"
          @dblclick.stop
        >
          <button type="button" aria-label="上一曲" @click="command('previousTrack')">
            <Icon :icon="iconSkipBack" width="14" />
          </button>
          <button
            type="button"
            class="play"
            :aria-label="playback.isPlaying ? '暂停' : '播放'"
            @click="command('togglePlayback')"
          >
            <Icon :icon="playback.isPlaying ? iconPause : iconPlay" width="14" />
          </button>
          <button type="button" aria-label="下一曲" @click="command('nextTrack')">
            <Icon :icon="iconSkipForward" width="14" />
          </button>
          <button
            type="button"
            class="favorite"
            :class="{ active: playback.isFavorite }"
            :aria-label="playback.isFavorite ? '取消收藏' : '收藏'"
            :aria-pressed="playback.isFavorite"
            @click="command('toggleFavorite')"
          >
            <Icon :icon="playback.isFavorite ? iconHeartFilled : iconHeart" width="14" />
          </button>
        </div>
        <div class="details" :class="{ 'has-progress': playback && duration }">
          <div class="copy" :aria-hidden="expanded">
            <TaskbarLyricLine
              class="primary"
              :text="primary"
              :line="line"
              :time-ms="timeMs"
              :end-time-ms="nextLine ? nextLine.time * 1000 : undefined"
              :word-by-word="settings.wordByWord"
              @width="primaryWidth = $event"
            />
            <TaskbarLyricLine
              v-if="secondary"
              class="secondary"
              :text="secondary"
              :time-ms="timeMs"
              @width="secondaryWidth = $event"
            />
          </div>
          <div class="song-info" :aria-hidden="!expanded">
            <div class="song-title" :title="title">{{ title }}</div>
            <div class="song-artist" :title="playback?.artist">{{ playback?.artist }}</div>
          </div>
          <SliderRoot
            v-if="playback && duration"
            class="progress echo-slider echo-slider-progress"
            :data-dragging="isDragging"
            :inert="!expanded"
            :min="0"
            :max="duration"
            :model-value="progressValue"
            :step="0.1"
            @pointerdown.capture="seek.handleStart"
            @keydown.capture="seek.handleKeydown"
            @keyup="seek.handleEnd"
            @update:model-value="seek.handleValueUpdate"
            @value-commit="seek.handleCommit"
            @pointerup="seek.handleEnd"
            @pointercancel="seek.handleCancel"
            @blur.capture="seek.handleCancel"
          >
            <SliderTrack class="progress-track echo-slider-track"
              ><SliderRange class="progress-range echo-slider-range"
            /></SliderTrack>
            <SliderThumb class="echo-slider-thumb" aria-label="播放进度" />
          </SliderRoot>
        </div>
      </div>
    </div>
  </section>
</template>
<style>
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
* {
  box-sizing: border-box;
}
.taskbar {
  height: 100%;
  display: flex;
  align-items: center;
  color: var(--fg);
  user-select: none;
}
.taskbar.right {
  justify-content: flex-end;
}
.content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  height: calc(100% - 8px);
  padding: 0 4px;
  min-width: 0;
  border-radius: 8px;
  transition: background-color 180ms ease;
}
.content.expanded {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.expanded .cover {
  width: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
  height: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
}
.cover {
  width: calc(100vh - 16px);
  height: calc(100vh - 16px);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
.cover svg {
  max-width: 100%;
  max-height: 100%;
}
.copy {
  width: 100%;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  line-height: 1.2;
  opacity: 1;
  transition: opacity 180ms ease;
}
.expanded .copy {
  opacity: 0;
}
.body {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
}
.details {
  --song-font-size: min(var(--font-size), max(11px, calc((100vh - 21px) / 1.9)));
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0 4px;
  overflow: hidden;
}
.song-info {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  line-height: 1.04;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}
.expanded .has-progress .song-info {
  bottom: 12px;
}
.expanded .song-info {
  opacity: 1;
  transition-delay: 80ms;
}
.song-title,
.song-artist {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.song-title {
  font-size: var(--song-font-size);
}
.song-artist {
  font-size: calc(var(--song-font-size) * 0.82);
  color: var(--muted);
}
.primary {
  font-size: min(var(--font-size), max(11px, calc((100vh - 10px) / 2.3)));
  font-weight: 400;
}
.secondary {
  font-size: calc(min(var(--font-size), max(11px, calc((100vh - 10px) / 2.3))) * 0.82);
  color: var(--muted);
}
.controls {
  --control-size: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
  display: flex;
  flex-shrink: 0;
  height: 100%;
  max-width: 0;
  overflow: hidden;
  gap: 4px;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  transition:
    max-width 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}
.expanded .controls {
  max-width: calc(4 * var(--control-size) + 20px);
  padding: 4px;
  opacity: 1;
  pointer-events: auto;
}
button {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.controls button {
  width: var(--control-size);
  height: var(--control-size);
  flex-shrink: 0;
  border-radius: 6px;
  transition:
    background-color 180ms ease,
    transform 180ms ease;
}
.controls svg {
  width: 14px;
  height: 14px;
  max-width: 100%;
  max-height: 100%;
}
.controls button:hover,
.cover:hover {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.controls .play {
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.controls .play:hover {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}
.controls button:active {
  transform: scale(0.94);
}
.favorite.active {
  color: #ef4444;
}
button:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--fg) 35%, transparent);
  outline-offset: -1px;
}
.progress {
  --slider-track-size: 2px;
  --slider-thumb-size: 8px;
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 12px;
  display: flex;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  cursor: pointer;
}
.progress .echo-slider-range,
.progress .echo-slider-thumb {
  background: var(--accent-text);
}
.expanded .progress {
  opacity: 1;
  pointer-events: auto;
}
@media (max-width: 260px) {
  .expanded .cover {
    display: none;
  }
  .controls {
    --control-size: min(calc(100vh - 16px), calc((100vw - 80px) / 4));
  }
  .expanded .details {
    min-width: 32px;
  }
  .song-info {
    display: none;
  }
}
@media (max-height: 44px) {
  .song-artist {
    display: none;
  }
  .details {
    --song-font-size: min(var(--font-size), max(11px, calc(100vh - 22px)));
  }
}
@media (max-height: 36px) {
  .secondary {
    display: none;
  }
  .primary {
    font-size: min(var(--font-size), max(11px, calc(100vh - 16px)));
  }
}
@media (max-height: 30px) {
  .song-info {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .content,
  .copy,
  .song-info,
  .controls,
  .controls button {
    transition: none;
  }
}
@media (forced-colors: active) {
  .taskbar {
    --fg: CanvasText !important;
    --muted: CanvasText !important;
    --bg: Canvas !important;
    --accent-text: Highlight !important;
  }
  .content {
    background: Canvas;
  }
  button:focus-visible {
    outline-color: Highlight;
  }
}
</style>
