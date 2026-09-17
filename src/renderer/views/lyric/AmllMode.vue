<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { LyricPlayer as CoreLyricPlayer } from '@applemusic-like-lyrics/core';
import '@applemusic-like-lyrics/core/style.css';
import { useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { createLyricTimeline } from '@/composables/useLyricTimeline';
import { usePlayerControls } from '@/composables/usePlayerControls';
import DynamicAlbumCover from '@/components/music/DynamicAlbumCover.vue';
import { useLyricSkin } from './composables/useLyricSkin';
import {
  AMLL_TEXT_COLOR_FALLBACK,
  HOST_SKIN_KEYS,
  LYRIC_SKIN_AMLL_DEFAULTS,
  resolveLyricSkinColor,
} from './skins/config';
import { buildAmllLyricLines } from './amll/convertLyrics';

const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const { currentTrack } = usePlayerControls();
const { settings } = useLyricSkin(HOST_SKIN_KEYS.amll, LYRIC_SKIN_AMLL_DEFAULTS);

// AMLL 要求传入数组内部信息不得修改：computed 每次重新构建全新数组，
// 依赖 store.lines 引用、当前歌词模式与「注音」偏好，切歌 / 译音切换时才会重建。
const lyricLines = computed(() =>
  buildAmllLyricLines(lyricStore.lines, lyricStore.lyricsMode, lyricStore.showRomanizationAsRuby),
);

// 直接使用 AMLL core 实例：手动管理生命周期，命令式驱动时间轴，
// 避免 vue 绑定按帧触发响应式链路带来的额外开销。
// 引擎持有 DOM、动画和大量可变内部状态，不应进入 Vue 深度响应式系统。
const playerRef = shallowRef<CoreLyricPlayer | null>(null);
const playerAreaRef = ref<HTMLElement | null>(null);

const timeline = createLyricTimeline();

// 帧率与时间轴节流配置：
// - AMLL 的 setCurrentTime 会遍历全部歌词组（O(n)）并分配多个 Set，逐帧调用
//   在高刷屏（120/144Hz）上会造成显著的 CPU 与 GC 压力。
// - update() 驱动弹簧动画，需要保持 60fps 流畅度；setCurrentTime 仅更新时间线
//   与热行检测，节流到 ~30fps 即可（行切换延迟 ≤33ms，人眼不可感知）。
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
const SET_TIME_INTERVAL = 1000 / 30; // setCurrentTime 节流到 ~30fps
const OVERSCAN_PX = 200; // 视口上下预渲染距离，默认 300 偏大

let rafId: number | null = null;
let lastFrameTime = 0;
let lastSetTimeAt = 0;
let settleUntil = 0;
let lastAppliedTimeMs = Number.NaN;

const rafLoop = (timestamp: number) => {
  rafId = null;
  if (document.hidden) {
    lastFrameTime = 0;
    return;
  }

  // 帧率上限：高刷屏跳过多余帧，dt 按真实间隔累计，弹簧动画不会丢步。
  const elapsed = lastFrameTime > 0 ? timestamp - lastFrameTime : FRAME_INTERVAL;
  if (elapsed < FRAME_INTERVAL) {
    rafId = requestAnimationFrame(rafLoop);
    return;
  }

  const dt = Math.min(elapsed, 50);
  lastFrameTime = timestamp;
  const player = playerRef.value;
  if (player) {
    const timelineMs = timeline.getTimelineMs(
      { clock: playerStore.playbackClock },
      lyricStore.currentTimeOffset,
      0,
    );
    // setCurrentTime 节流到 ~30fps：它会遍历全部歌词组（O(n)）并分配多个 Set，
    // 逐帧调用在高刷屏上造成显著 CPU 与 GC 压力。update() 仍按 60fps 推进弹簧动画。
    // 首次调用 lastSetTimeAt=0 会立即执行；seek/切歌时时间跳变最多延迟 ~33ms。
    if (
      Number.isFinite(timelineMs) &&
      lastAppliedTimeMs !== timelineMs &&
      timestamp - lastSetTimeAt >= SET_TIME_INTERVAL
    ) {
      player.setCurrentTime(timelineMs);
      lastAppliedTimeMs = timelineMs;
      lastSetTimeAt = timestamp;
    }
    player.update(dt);
  }
  // 暂停后留出有限时间让布局弹簧收敛，随后停止更新。
  if (playerStore.isPlaying || timestamp < settleUntil) {
    rafId = requestAnimationFrame(rafLoop);
  } else {
    lastFrameTime = 0;
  }
};

const requestFrame = () => {
  if (!playerRef.value || document.hidden) return;
  settleUntil = performance.now() + 1000;
  if (rafId !== null) return;
  lastFrameTime = 0;
  rafId = requestAnimationFrame(rafLoop);
};

const handleVisibilityChange = () => {
  if (document.hidden) {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    lastFrameTime = 0;
    playerRef.value?.pause();
  } else {
    if (playerStore.isPlaying) playerRef.value?.resume();
    requestFrame();
  }
};

onMounted(() => {
  const host = playerAreaRef.value;
  if (!host) return;
  const player = new CoreLyricPlayer();
  host.appendChild(player.getElement());
  // 缩减视口外预渲染行数，减少每帧需要更新样式的 DOM 元素数量。
  player.setOverscanPx(OVERSCAN_PX);
  player.setLyricLines(lyricLines.value);
  if (playerStore.isPlaying) player.resume();
  else player.pause();
  playerRef.value = player;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  lastFrameTime = performance.now();
  requestFrame();
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  const player = playerRef.value;
  if (player) {
    player.dispose();
    // AMLL 的 LyricPlayerBase.dispose() 只移除了 element 和 pageshow/pagehide 监听，
    // 但没有断开内部的 resizeObserver。该 observer 的回调以箭头函数捕获了 player
    // 实例（this），持续持有 element / interludeDots / bottomLine 的引用，
    // 连带 attachPlayerScrollHandlers 挂载的滚动事件监听器和全部歌词 DOM 节点
    // 都无法被 GC，导致关闭歌词页后内存不下降。这里手动断开 observer。
    const ro = (player as unknown as { resizeObserver?: ResizeObserver }).resizeObserver;
    ro?.disconnect();
  }
  playerRef.value = null;
  const host = playerAreaRef.value;
  if (host) host.replaceChildren();
});

// 歌词行变化时重建（引用不同才会触发）
watch(lyricLines, (lines) => {
  playerRef.value?.setLyricLines(
    lines,
    timeline.getTimelineMs({ clock: playerStore.playbackClock }, lyricStore.currentTimeOffset, 0),
  );
  if (!playerStore.isPlaying || document.hidden) playerRef.value?.pause();
  requestFrame();
});

watch(
  () => playerStore.isPlaying,
  (playing) => {
    const player = playerRef.value;
    if (playing && !document.hidden) player?.resume();
    else player?.pause();
    requestFrame();
  },
);

// 暂停状态不需要常驻 rAF，但拖动进度/歌词偏移仍需刷新一次。
watch(
  () => [playerStore.currentTime, lyricStore.currentTimeOffset],
  () => requestFrame(),
);

// 皮肤设置：playerRef 置位后立即生效，之后每次改动实时应用
watch(
  () =>
    [
      playerRef.value,
      settings.value.alignPosition,
      settings.value.enableSpring,
      settings.value.enableBlur,
      settings.value.enableScale,
      settings.value.hidePassedLines,
      settings.value.wordFadeWidth,
    ] as const,
  ([player, position, spring, blur, scale, hide, fade], previous) => {
    if (!player) return;
    const initial = player !== previous?.[0];
    if (initial) player.setAlignAnchor('center');
    if (initial || position !== previous?.[1]) player.setAlignPosition(position);
    if (initial || spring !== previous?.[2]) player.setEnableSpring(spring);
    if (initial || blur !== previous?.[3]) player.setEnableBlur(blur);
    if (initial || scale !== previous?.[4]) player.setEnableScale(scale);
    if (initial || hide !== previous?.[5]) player.setHidePassedLines(hide);
    if (initial || fade !== previous?.[6]) player.setWordFadeWidth(fade);
    requestFrame();
  },
);

const resolvedTextColor = computed(() =>
  resolveLyricSkinColor(settings.value.textColor, AMLL_TEXT_COLOR_FALLBACK),
);
// 歌词颜色作用于 AMLL 内部 CSS 变量（--amll-lp-color），直接挂在宿主容器上继承
const playerAreaStyle = computed(() =>
  settings.value.textColor ? { '--amll-lp-color': resolvedTextColor.value } : undefined,
);
</script>

<template>
  <div class="amll-mode">
    <!-- 左侧：封面 + 歌曲信息（复刻 Apple Music 歌词页结构） -->
    <section class="amll-side">
      <div class="amll-cover-wrapper">
        <DynamicAlbumCover
          :enabled="settings.dynamicAlbumCover"
          :url="currentTrack?.coverUrl"
          :album-audio-id="currentTrack?.albumAudioId || currentTrack?.mixSongId"
          :album-id="currentTrack?.albumId"
          :active="playerStore.isPlaying"
          :size="800"
          :border-radius="24"
          :alt="currentTrack?.albumName || currentTrack?.name || '专辑封面'"
          class="amll-cover-img"
        />
      </div>
      <div class="amll-song-info">
        <h1 class="amll-song-title">{{ currentTrack?.name || '未在播放' }}</h1>
        <p class="amll-song-artist">{{ currentTrack?.artist || '' }}</p>
      </div>
    </section>

    <!-- 右侧：AMLL 歌词引擎 -->
    <section ref="playerAreaRef" class="amll-player-area" :style="playerAreaStyle"></section>
  </div>
</template>

<style scoped>
.amll-mode {
  display: flex;
  gap: 32px;
  height: 100%;
  padding: 0 32px;
  max-width: 1400px;
  margin: 0 auto;
  width: 100%;
}

.amll-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: clamp(280px, 35%, 420px);
  padding: 24px 0;
}

.amll-cover-wrapper {
  width: clamp(220px, 80%, 380px);
  aspect-ratio: 1;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
}

.amll-cover-img {
  width: 100%;
  height: 100%;
}

.amll-song-info {
  margin-top: 24px;
  text-align: center;
  width: 100%;
  max-width: 380px;
  padding: 0 16px;
}

.amll-song-title {
  font-size: 22px;
  font-weight: 700;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.amll-song-artist {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.amll-player-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}

@media (max-width: 768px) {
  .amll-mode {
    flex-direction: column;
    gap: 16px;
  }

  .amll-side {
    width: 100%;
    flex: 0 0 auto;
    padding: 16px 0 0;
  }

  .amll-cover-wrapper {
    width: 160px;
  }

  .amll-player-area {
    flex: 1;
  }
}
</style>
