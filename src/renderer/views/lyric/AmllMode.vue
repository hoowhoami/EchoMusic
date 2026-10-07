<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { OpeningLyricPlayer } from './amll/OpeningLyricPlayer';
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
import { afterPaint } from '@/utils/afterPaint';

const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const { currentTrack } = usePlayerControls();
const { settings } = useLyricSkin(HOST_SKIN_KEYS.amll, LYRIC_SKIN_AMLL_DEFAULTS);

// AMLL 要求传入数组内部信息不得修改：computed 每次重新构建全新数组，
// 始终保留译文和音译数据；显示开关只改变可见性，不重建时间轴和歌词组。
const lyricLines = computed(() =>
  buildAmllLyricLines(lyricStore.displayLines, 'both', lyricStore.showRomanizationAsRuby),
);

// 直接使用 AMLL core 实例：手动管理生命周期，命令式驱动时间轴，
// 避免 vue 绑定按帧触发响应式链路带来的额外开销。
// 引擎持有 DOM、动画和大量可变内部状态，不应进入 Vue 深度响应式系统。
const playerRef = shallowRef<OpeningLyricPlayer | null>(null);
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
let openingOverlay: HTMLElement | null = null;
let openingLayoutPending = true;
let openingFrames = 0;
let cancelInitialization: (() => void) | undefined;

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
    // Keep subsequent initial size/font/settings layouts instantaneous as well.
    // No extra layout pass is needed on each frame: the engine's existing calls
    // are forced while the host is entering. Restore springs after the opening.
    if (
      openingLayoutPending &&
      ++openingFrames >= 2 &&
      !openingOverlay?.hasAttribute('data-entering')
    ) {
      player.finishOpeningLayout();
      openingLayoutPending = false;
      openingOverlay = null;
    }
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

const initializePlayer = () => {
  const host = playerAreaRef.value;
  if (!host?.isConnected) return;
  const player = new OpeningLyricPlayer();
  host.appendChild(player.getElement());
  player.initializeViewport();
  // 缩减视口外预渲染行数，减少每帧需要更新样式的 DOM 元素数量。
  player.setOverscanPx(OVERSCAN_PX);
  // Apply initial settings while there are no words to rebuild or relayout.
  const skin = settings.value;
  player.setAlignAnchor('center');
  player.setAlignPosition(skin.alignPosition);
  player.setEnableSpring(skin.enableSpring);
  player.setEnableBlur(skin.enableBlur);
  player.setEnableScale(skin.enableScale);
  player.setHidePassedLines(skin.hidePassedLines);
  player.setWordFadeWidth(skin.wordFadeWidth);
  player.setSecondaryVisibility(lyricStore.showTranslation, lyricStore.showRomanization);
  // Start at the live position so opening does not animate from the song's beginning.
  const initialTimeMs = timeline.getTimelineMs(
    { clock: playerStore.playbackClock },
    lyricStore.currentTimeOffset,
    0,
  );
  player.setLyricLines(lyricLines.value, initialTimeMs);
  lastAppliedTimeMs = initialTimeMs;
  if (playerStore.isPlaying) player.resume();
  else player.pause();
  playerRef.value = player;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  lastFrameTime = performance.now();
  requestFrame();
};

onMounted(() => {
  openingOverlay = playerAreaRef.value?.closest<HTMLElement>('.lyric-overlay-host') ?? null;
  // Cover geometry is ready now. Do not make entry wait for all lyric word DOM:
  // first let the page/cover animation start and paint, then build the engine.
  if (openingOverlay?.hasAttribute('data-entering')) {
    cancelInitialization = afterPaint(initializePlayer);
  } else {
    initializePlayer();
  }
});

onUnmounted(() => {
  cancelInitialization?.();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  const player = playerRef.value;
  if (player) {
    player.dispose();
  }
  playerRef.value = null;
  openingOverlay = null;
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
  () => [lyricStore.showTranslation, lyricStore.showRomanization] as const,
  ([translation, romanization]) => {
    playerRef.value?.setSecondaryVisibility(translation, romanization);
    requestFrame();
  },
);

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

// Initial settings are applied before lyric construction; subsequent changes stay live.
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
    if (initial) return;
    if (position !== previous?.[1]) player.setAlignPosition(position);
    if (spring !== previous?.[2]) player.setEnableSpring(spring);
    if (blur !== previous?.[3]) player.setEnableBlur(blur);
    if (scale !== previous?.[4]) player.setEnableScale(scale);
    if (hide !== previous?.[5]) player.setHidePassedLines(hide);
    if (fade !== previous?.[6]) player.setWordFadeWidth(fade);
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
      <div class="amll-cover-wrapper" data-lyric-cover>
        <DynamicAlbumCover
          :enabled="settings.dynamicAlbumCover"
          :url="currentTrack?.coverUrl"
          :album-audio-id="currentTrack?.albumAudioId || currentTrack?.mixSongId"
          :album-id="currentTrack?.albumId"
          :active="playerStore.isPlaying"
          :size="800"
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
.amll-player-area :deep([class$='_romanWord']) {
  display: var(--echo-amll-roman-display, flex);
}

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
  border-radius: var(--radius-media);
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
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.amll-song-artist {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-secondary);
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
