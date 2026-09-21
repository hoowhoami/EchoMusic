<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import type { NowPlayingCommand, NowPlayingSnapshot } from '../../shared/nowPlaying';
import { useTaskbarSeek } from './useTaskbarSeek';

const snapshot = ref<NowPlayingSnapshot | null>(null);
const dark = ref(false);
const coverFailed = ref('');
const error = ref('');
const playback = computed(() => snapshot.value?.playback);
const lyric = computed(() => {
  const l = snapshot.value?.lyric;
  if (!l || l.trackId !== (playback.value?.lyricHash || playback.value?.trackId)) return '';
  return l.lines[l.currentIndex]?.text || '';
});
const title = computed(() =>
  playback.value ? `${playback.value.title} - ${playback.value.artist}` : '未在播放',
);
const seek = useTaskbarSeek(
  () => playback.value,
  (value) => window.electron?.nowPlaying.command({ type: 'seek', value }),
);
const { progressValue, duration } = seek;
const command = (value: NowPlayingCommand) => {
  if (playback.value) window.electron?.nowPlaying.command(value);
};
const showMain = () => window.electron?.ipcRenderer.send('taskbar-player:show-main');
let disposeSnapshot: (() => void) | undefined;
let alive = true;
let received = false;
const stateListener = (state: unknown) => {
  if (state && typeof state === 'object' && 'isDark' in state) dark.value = Boolean(state.isDark);
};
onMounted(async () => {
  const api = window.electron;
  if (!api) {
    error.value = '连接不可用，请重新打开快捷播控';
    return;
  }
  disposeSnapshot = api.nowPlaying.onSnapshot((value) => {
    received = true;
    snapshot.value = value;
    error.value = '';
  });
  api.ipcRenderer.on('taskbar-player:state', stateListener);
  try {
    const value = await api.nowPlaying.getSnapshot();
    if (alive && !received) snapshot.value = value;
    const state = await api.ipcRenderer.invoke('taskbar-player:get-state');
    if (alive) stateListener(state);
  } catch {
    if (alive) error.value = '连接失败，请重新打开快捷播控';
  }
});
onUnmounted(() => {
  alive = false;
  disposeSnapshot?.();
  window.electron?.ipcRenderer.off('taskbar-player:state', stateListener);
});
</script>

<template>
  <section class="bar" :class="{ dark }" aria-label="任务栏快捷播控">
    <div
      class="metadata"
      :aria-label="`${title}（拖动可移出任务栏，双击打开主窗口）`"
      @dblclick="showMain"
    >
      <img
        v-if="playback?.coverUrl && coverFailed !== playback.coverUrl"
        class="cover"
        :src="playback.coverUrl"
        alt=""
        @error="coverFailed = playback?.coverUrl || ''"
      />
      <span v-else class="cover empty" aria-hidden="true">♫</span>
      <div class="copy">
        <div class="title">{{ title }}</div>
        <div class="lyric">
          {{ error || lyric || playback?.artist || '打开主窗口，选择一首歌' }}
        </div>
      </div>
    </div>
    <div class="controls">
      <button aria-label="上一曲" :disabled="!playback" @click="command('previousTrack')">
        <svg viewBox="0 0 24 24"><path d="M5 5h3v14H5zM20 5v14L9 12z" /></svg>
      </button>
      <button
        class="play"
        :aria-label="playback?.isPlaying ? '暂停' : '播放'"
        :disabled="!playback"
        @click="command('togglePlayback')"
      >
        <svg viewBox="0 0 24 24">
          <path v-if="playback?.isPlaying" d="M6 4h4v16H6zM14 4h4v16h-4z" />
          <path v-else d="M7 3v18l15-9z" />
        </svg>
      </button>
      <button aria-label="下一曲" :disabled="!playback" @click="command('nextTrack')">
        <svg viewBox="0 0 24 24"><path d="M16 5h3v14h-3zM4 5v14l11-7z" /></svg>
      </button>
      <button
        class="favorite"
        :class="{ active: playback?.isFavorite }"
        :aria-label="playback?.isFavorite ? '取消收藏' : '收藏'"
        :aria-pressed="Boolean(playback?.isFavorite)"
        :disabled="!playback"
        @click="command('toggleFavorite')"
      >
        <svg viewBox="0 0 24 24">
          <path d="M12 21C7 17 2 13 2 8a5 5 0 0 1 10-1A5 5 0 0 1 22 8c0 5-5 9-10 13Z" />
        </svg>
      </button>
    </div>
    <SliderRoot
      class="progress"
      :min="0"
      :max="duration || 1"
      :model-value="progressValue"
      :step="0.1"
      :disabled="!duration"
      @pointerdown.capture="seek.handleStart"
      @keydown.capture="seek.handleKeydown"
      @keyup="seek.handleEnd"
      @update:model-value="seek.handleValueUpdate"
      @value-commit="seek.handleCommit"
      @pointerup="seek.handleEnd"
      @pointercancel="seek.handleCancel"
      @blur.capture="seek.handleCancel"
    >
      <SliderTrack class="progress-track"><SliderRange class="progress-range" /></SliderTrack>
      <SliderThumb class="progress-thumb" aria-label="播放进度" />
    </SliderRoot>
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
.bar {
  --fg: #383838;
  --muted: #777;
  --bg: #eeeeee;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 4px 10px 6px;
  background: var(--bg);
  color: var(--fg);
  font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
  user-select: none;
}
.bar.dark {
  --fg: #eee;
  --muted: #aaa;
  --bg: #252525;
}
.metadata {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  height: 100%;
}
.cover {
  width: clamp(18px, calc(100vh - 14px), 42px);
  height: clamp(18px, calc(100vh - 14px), 42px);
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 4px;
}
.cover.empty {
  display: grid;
  place-items: center;
  background: #8882;
}
.copy {
  min-width: 0;
  font-size: clamp(10px, 24vh, 13px);
  line-height: 1.35;
}
.title,
.lyric {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyric {
  color: var(--muted);
}
.controls {
  display: flex;
  align-items: center;
  gap: clamp(3px, 1.6vw, 13px);
  flex-shrink: 0;
}
button {
  -webkit-app-region: no-drag;
  border: 0;
  padding: 4px;
  display: grid;
  place-items: center;
  width: clamp(22px, 65vh, 32px);
  height: clamp(22px, 65vh, 32px);
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button:hover {
  background: #8883;
}
button:focus-visible {
  outline: 2px solid #e82b5b;
  outline-offset: -2px;
}
button:disabled {
  opacity: 0.35;
  cursor: default;
}
button svg {
  width: 21px;
  height: 21px;
  fill: currentColor;
}
button.play {
  width: clamp(30px, 100vh, 50px);
  background: #8882;
}
.favorite svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
}
.favorite.active {
  color: #e82b5b;
}
.favorite.active svg {
  fill: currentColor;
}
.progress {
  -webkit-app-region: no-drag;
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 8px;
  display: flex;
  align-items: flex-end;
  touch-action: none;
  margin: 0;
  accent-color: #e82b5b;
  opacity: 0;
  cursor: pointer;
}
.bar:hover .progress,
.progress:focus-within {
  opacity: 1;
}
.progress-track {
  position: relative;
  flex: 1;
  height: 3px;
  background: #8885;
}
.progress-range {
  position: absolute;
  height: 100%;
  background: #e82b5b;
}
.progress-thumb {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e82b5b;
}
.progress-thumb:focus-visible {
  outline: 1px solid var(--fg);
  outline-offset: -1px;
}
@media (max-width: 260px) {
  .cover {
    display: none;
  }
  .bar {
    gap: 4px;
    padding-left: 5px;
    padding-right: 5px;
  }
  .controls {
    gap: 3px;
  }
}
@media (max-height: 34px) {
  .bar {
    padding-top: 1px;
    padding-bottom: 3px;
  }
  .lyric {
    display: none;
  }
  button {
    height: clamp(16px, calc(100vh - 6px), 26px);
    padding: 2px;
  }
  button svg {
    width: 100%;
    height: 100%;
    max-width: 17px;
    max-height: 17px;
  }
}
@media (forced-colors: active) {
  .bar,
  .bar.dark {
    --fg: CanvasText;
    --muted: CanvasText;
    --bg: Canvas;
  }
  button.play {
    background: ButtonFace;
    color: ButtonText;
  }
  .favorite.active {
    color: Highlight;
  }
  button:focus-visible {
    outline-color: Highlight;
  }
  .progress-track {
    background: GrayText;
  }
  .progress-range,
  .progress-thumb {
    background: Highlight;
  }
}
</style>
