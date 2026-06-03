<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Cover from '@/components/ui/Cover.vue';
import {
  iconHeart,
  iconHeartFilled,
  iconMusic,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconList,
  iconTypography,
  iconVolume1,
  iconVolume2,
  iconVolume3,
  iconX,
} from '@/icons';
import type {
  MiniPlayerAppearancePayload,
  MiniPlayerCommand,
  MiniPlayerPlaybackPayload,
  MiniPlayerQueuePayload,
  MiniPlayerSnapshot,
} from '../../shared/mini-player';
import { MINI_PLAYER_DIMENSIONS } from '../../shared/mini-player';

// 卡片折叠/展开高度，源自共享尺寸常量，保证与主进程窗口尺寸一致、不漂移
const cardCollapsedHeight = `${MINI_PLAYER_DIMENSIONS.controlsHeight}px`;
const cardExpandedHeight = `${
  MINI_PLAYER_DIMENSIONS.expandedHeight - MINI_PLAYER_DIMENSIONS.shellPadding * 2
}px`;

const playback = ref<MiniPlayerPlaybackPayload | null>(null);
const appearance = ref<MiniPlayerAppearancePayload | null>(null);
const queue = ref<MiniPlayerQueuePayload | null>(null);
const isQueueOpen = ref(false);
const isDraggingSeek = ref(false);
const pendingSeekRatio = ref<number | null>(null);
let disposeSnapshot: (() => void) | null = null;

const isMac = navigator.platform.toLowerCase().includes('mac');

const progressPercent = computed(() => {
  const duration = playback.value?.duration ?? 0;
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, ((playback.value?.currentTime ?? 0) / duration) * 100));
});

// 拖动 seek 时优先显示拖动位置，避免 120ms 回传造成的跳动
const displayPercent = computed(() => {
  if (isDraggingSeek.value && pendingSeekRatio.value !== null) {
    return Math.min(100, Math.max(0, pendingSeekRatio.value * 100));
  }
  return progressPercent.value;
});

const volumeIcon = computed(() => {
  const value = playback.value?.volume ?? 0;
  if (value <= 0) return iconVolume3;
  if (value <= 0.5) return iconVolume1;
  return iconVolume2;
});

const currentQueueTrackId = computed(
  () => queue.value?.currentTrackId ?? playback.value?.trackId ?? null,
);

const command = (value: MiniPlayerCommand) => {
  window.electron?.miniPlayer?.command(value);
};

const applySnapshot = (snapshot: MiniPlayerSnapshot | null | undefined) => {
  playback.value = snapshot?.playback ?? null;
  appearance.value = snapshot?.appearance ?? appearance.value;
  queue.value = snapshot?.queue ?? null;
  window.electron?.log?.info(
    '[mini] applySnapshot incoming=',
    JSON.stringify(snapshot?.appearance),
    'resolved=',
    JSON.stringify(appearance.value),
  );
  if (appearance.value) {
    document.documentElement.classList.toggle('dark', appearance.value.isDark);
    document.documentElement.style.setProperty('--color-primary', appearance.value.accentColor);
    document.documentElement.style.fontFamily = appearance.value.fontFamily || '';
  }
};

// 滚轮调节音量：仿 VolumePopover 的步进与方向，本地乐观更新 + 下发命令
const handleWheel = (event: WheelEvent) => {
  if (!playback.value) return;
  event.preventDefault();
  const normalized = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 120);
  const step = (normalized / 120) * 0.05;
  const direction = isMac ? 1 : -1;
  const next = Math.max(0, Math.min(1, (playback.value.volume ?? 0) + step * direction));
  playback.value.volume = next;
  command({ type: 'setVolume', value: next });
};

const ratioFromEvent = (event: PointerEvent, el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
};

const handleSeekPointerDown = (event: PointerEvent) => {
  if (!playback.value) return;
  const el = event.currentTarget as HTMLElement;
  isDraggingSeek.value = true;
  pendingSeekRatio.value = ratioFromEvent(event, el);
  el.setPointerCapture(event.pointerId);
};

const handleSeekPointerMove = (event: PointerEvent) => {
  if (!isDraggingSeek.value) return;
  pendingSeekRatio.value = ratioFromEvent(event, event.currentTarget as HTMLElement);
};

const handleSeekPointerUp = (event: PointerEvent) => {
  if (!isDraggingSeek.value) return;
  const el = event.currentTarget as HTMLElement;
  const ratio = ratioFromEvent(event, el);
  isDraggingSeek.value = false;
  pendingSeekRatio.value = null;
  if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  const duration = playback.value?.duration ?? 0;
  if (duration > 0) {
    // 乐观更新本地进度，避免等待 ~120ms 回传时进度条回跳
    if (playback.value) playback.value.currentTime = ratio * duration;
    command({ type: 'seek', value: ratio * duration });
  }
};

let expandFrameTimer: ReturnType<typeof setTimeout> | null = null;

const cancelExpandFrame = () => {
  if (expandFrameTimer) {
    clearTimeout(expandFrameTimer);
    expandFrameTimer = null;
  }
};

const setQueueOpen = (open: boolean) => {
  if (isQueueOpen.value === open) return;
  cancelExpandFrame();
  if (open) {
    // 展开：先让主进程把窗口放大，下一帧再触发卡片高度过渡，避免卡片在窗口变高前被裁切
    window.electron?.miniPlayer?.setExpanded(true);
    expandFrameTimer = setTimeout(() => {
      expandFrameTimer = null;
      isQueueOpen.value = true;
    }, 60);
    return;
  }
  // 收起：先收卡片（CSS 过渡），主进程延迟缩小窗口，等待过渡播完
  isQueueOpen.value = false;
  window.electron?.miniPlayer?.setExpanded(false);
};

const toggleQueue = () => setQueueOpen(!isQueueOpen.value);

const playQueueTrack = (trackId: string) => {
  command({ type: 'playQueueTrack', trackId });
};

// 窗口被隐藏（关闭 mini / 回主窗口）时，主进程已折叠窗口，这里同步收起队列状态
const handleVisibility = () => {
  if (document.visibilityState === 'hidden' && isQueueOpen.value) {
    cancelExpandFrame();
    isQueueOpen.value = false;
  }
};

const requestShowMain = () => {
  cancelExpandFrame();
  isQueueOpen.value = false;
  command('showMainWindow');
};

const requestClose = () => {
  cancelExpandFrame();
  isQueueOpen.value = false;
  command('closeMiniPlayer');
};

onMounted(async () => {
  document.documentElement.classList.add('mini-player-window');
  try {
    applySnapshot(await window.electron?.miniPlayer?.getSnapshot?.());
  } catch {
    applySnapshot(null);
  }
  disposeSnapshot = window.electron?.miniPlayer?.onSnapshot(applySnapshot) ?? null;
  document.addEventListener('visibilitychange', handleVisibility);
});

onUnmounted(() => {
  document.documentElement.classList.remove('mini-player-window');
  document.documentElement.classList.remove('dark');
  document.removeEventListener('visibilitychange', handleVisibility);
  cancelExpandFrame();
  if (isQueueOpen.value) window.electron?.miniPlayer?.setExpanded(false);
  disposeSnapshot?.();
  disposeSnapshot = null;
});
</script>

<template>
  <main class="mini-shell" :class="{ 'is-expanded': isQueueOpen }">
    <section class="mini-card">
      <div class="mini-controls" @wheel="handleWheel">
        <div class="mini-left-actions">
          <button
            type="button"
            class="mini-window-btn no-drag"
            title="关闭 mini 播放器"
            @click="requestClose"
          >
            <Icon :icon="iconX" width="15" height="15" />
          </button>
          <button
            type="button"
            class="mini-window-btn no-drag"
            title="回到主窗口"
            @click="requestShowMain"
          >
            <span class="mini-restore-icon"></span>
          </button>
        </div>

        <div class="mini-cover">
          <Cover
            v-if="playback"
            :url="playback.coverUrl"
            :size="160"
            width="44px"
            height="44px"
            :borderRadius="6"
          />
          <div v-else class="mini-cover-placeholder">
            <Icon :icon="iconMusic" width="22" height="22" />
          </div>
        </div>

        <div class="mini-center">
          <div class="mini-info">
            <div class="mini-title">{{ playback?.title || '未在播放' }}</div>
            <div class="mini-artist">{{ playback?.artist || 'EchoMusic' }}</div>
          </div>
          <div class="mini-hover-controls">
            <button
              type="button"
              class="mini-center-btn no-drag"
              :disabled="!playback"
              title="上一首"
              @click="command('previousTrack')"
            >
              <Icon :icon="iconSkipBack" width="17" height="17" />
            </button>
            <button
              type="button"
              class="mini-center-btn mini-center-play no-drag"
              :disabled="!playback"
              :title="playback?.isPlaying ? '暂停' : '播放'"
              @click="command('togglePlayback')"
            >
              <Icon
                :icon="playback?.isPlaying ? iconPause : iconPlay"
                :width="playback?.isPlaying ? 18 : 16"
                :height="playback?.isPlaying ? 18 : 16"
                :class="{ 'play-offset': !playback?.isPlaying }"
              />
            </button>
            <button
              type="button"
              :disabled="!playback"
              class="mini-center-btn no-drag"
              title="下一首"
              @click="command('nextTrack')"
            >
              <Icon :icon="iconSkipForward" width="17" height="17" />
            </button>
          </div>
        </div>

        <div class="mini-right-actions">
          <button
            type="button"
            class="mini-action-btn no-drag"
            :class="{ active: playback?.isFavorite }"
            :disabled="!playback"
            title="收藏当前歌曲"
            @click="command('toggleFavorite')"
          >
            <Icon
              :icon="playback?.isFavorite ? iconHeartFilled : iconHeart"
              width="19"
              height="19"
            />
          </button>
          <button
            type="button"
            class="mini-action-btn no-drag"
            :class="{ active: isQueueOpen }"
            title="播放队列"
            @click="toggleQueue"
          >
            <Icon :icon="iconList" width="18" height="18" />
          </button>
          <button
            type="button"
            class="mini-action-btn no-drag"
            :disabled="!playback"
            :title="`歌词模式：${playback?.lyricsLabel || '原词'}`"
            @click="command('toggleLyricsMode')"
          >
            <Icon :icon="iconTypography" width="19" height="19" />
          </button>
          <button
            type="button"
            class="mini-action-btn no-drag"
            :class="{ active: (playback?.volume ?? 0) <= 0 }"
            :disabled="!playback"
            :title="(playback?.volume ?? 0) <= 0 ? '取消静音' : '静音（滚轮调节音量）'"
            @click="command('toggleMute')"
          >
            <Icon :icon="volumeIcon" width="19" height="19" />
          </button>
        </div>

        <div
          class="mini-progress no-drag"
          @pointerdown="handleSeekPointerDown"
          @pointermove="handleSeekPointerMove"
          @pointerup="handleSeekPointerUp"
          @pointercancel="handleSeekPointerUp"
        >
          <div class="mini-progress-value" :style="{ width: `${displayPercent}%` }"></div>
        </div>
      </div>

      <div class="mini-queue no-drag" :aria-hidden="!isQueueOpen">
        <div class="mini-queue-list">
          <button
            v-for="track in queue?.tracks ?? []"
            :key="track.trackId"
            type="button"
            class="mini-queue-item no-drag"
            :class="{ active: track.trackId === currentQueueTrackId }"
            :tabindex="isQueueOpen ? 0 : -1"
            :title="`${track.title} - ${track.artist}`"
            @click="playQueueTrack(track.trackId)"
          >
            <div class="mini-queue-cover">
              <Cover
                :url="track.coverUrl"
                :size="80"
                width="30px"
                height="30px"
                :borderRadius="4"
              />
              <span v-if="track.trackId === currentQueueTrackId" class="mini-queue-playing">
                <Icon :icon="playback?.isPlaying ? iconPause : iconPlay" width="12" height="12" />
              </span>
            </div>
            <div class="mini-queue-meta">
              <div class="mini-queue-song">{{ track.title }}</div>
              <div class="mini-queue-artist">{{ track.artist }}</div>
            </div>
          </button>
          <div v-if="!queue?.tracks.length" class="mini-queue-empty">队列为空</div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.mini-shell {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  background: transparent;
  -webkit-app-region: drag;
  display: flex;
  /* 卡片锚定在顶部，向下增高：控制条固定在上方，队列在其下方向下弹出 */
  align-items: flex-start;
  min-height: 0;
}

.mini-card {
  width: 100%;
  /* 折叠态仅控制条高度；展开时 CSS 过渡到「控制条 + 队列」高度，窗口已由主进程一次性放大，
     卡片在窗口内平滑下展，避免逐帧 setBounds 造成的闪烁 */
  height: v-bind(cardCollapsedHeight);
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  /* 无投影，仅描边 + 圆角，铺满窗口，风格与主窗口一致（只是小窗） */
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #f5f5f5;
  color: #1d1d1f;
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: height;
}

.mini-shell.is-expanded .mini-card {
  height: v-bind(cardExpandedHeight);
}

.mini-controls {
  position: relative;
  flex: 0 0 64px;
  height: 64px;
  display: grid;
  grid-template-columns: 18px 44px minmax(96px, 1fr) auto;
  align-items: center;
  gap: 10px;
  /* 内容在控制条内垂直居中；进度条为绝对定位贴底，仅占中/右列，不与居中内容冲突 */
  padding: 0 16px 0 9px;
  box-sizing: border-box;
}

.mini-left-actions {
  width: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: rgba(138, 138, 138, 0.76);
}

.mini-window-btn,
.mini-action-btn,
.mini-center-btn {
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}

.mini-window-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mini-window-btn:hover,
.mini-action-btn:hover,
.mini-center-btn:hover {
  color: #222;
  opacity: 1;
}

.mini-restore-icon {
  width: 10px;
  height: 10px;
  display: block;
  border: 2px solid currentColor;
  border-radius: 3px;
}

.mini-window-btn:active,
.mini-action-btn:active,
.mini-center-btn:active {
  transform: scale(0.96);
}

button:disabled {
  opacity: 0.35;
  cursor: default;
  transform: none;
}

.mini-cover,
.mini-cover-placeholder {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
}

/* Cover 组件默认用 -webkit-mask 径向渐变做圆角，在透明窗口 + 高度过渡的合成下会渲染出黑色条纹；
   这里关闭该 mask，圆角已由外层 border-radius + overflow:hidden 实现 */
.mini-cover :deep(.cover-container) {
  -webkit-mask-image: none;
  mask-image: none;
}

.mini-cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.06);
  color: rgba(29, 29, 31, 0.28);
}

.mini-center {
  min-width: 0;
  position: relative;
  height: 44px;
  display: flex;
  align-items: center;
}

.mini-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
  font-weight: 700;
  letter-spacing: 0;
}

.mini-artist {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
  font-size: 11px;
  line-height: 15px;
  font-weight: 600;
  color: rgba(29, 29, 31, 0.58);
}

.mini-info,
.mini-hover-controls {
  min-width: 0;
  position: absolute;
  inset: 0;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.mini-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.mini-hover-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  opacity: 0;
  transform: translateY(-2px);
  pointer-events: none;
  color: rgba(76, 76, 76, 0.9);
}

.mini-shell:hover .mini-info,
.mini-shell.is-expanded .mini-info {
  opacity: 0;
  transform: translateY(-2px);
}

.mini-shell:hover .mini-hover-controls,
.mini-shell.is-expanded .mini-hover-controls {
  opacity: 1;
  transform: translateY(-2px);
  pointer-events: auto;
}

.mini-center-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--color-primary);
}

.mini-center-btn:hover {
  transform: translateY(-1px);
}

.mini-center-play {
  width: 30px;
  height: 30px;
  background: var(--color-primary);
  color: #fff;
}

.mini-center-play:hover {
  color: #fff;
  transform: scale(1.04);
}

.play-offset {
  margin-left: 2px;
}

.mini-right-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgba(84, 84, 88, 0.78);
  opacity: 0;
  transform: translateY(2px);
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.mini-shell:hover .mini-right-actions,
.mini-shell.is-expanded .mini-right-actions {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.mini-action-btn {
  width: 20px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mini-action-btn.active {
  color: var(--color-primary);
}

.mini-progress {
  position: absolute;
  left: 91px;
  right: 16px;
  bottom: 9px;
  height: 8px;
  border-radius: 999px;
  background: transparent;
  overflow: visible;
  cursor: pointer;
}

.mini-progress-value {
  position: relative;
  top: 50%;
  height: 3px;
  width: 0;
  border-radius: inherit;
  background: var(--color-primary);
  min-width: 0;
  transform: translateY(-50%);
  transition: width 0.12s linear;
}

.mini-progress::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 3px;
  border-radius: 999px;
  background: rgba(210, 210, 210, 0.86);
  transform: translateY(-50%);
}

.mini-progress-value::after {
  content: '';
  position: absolute;
  top: 50%;
  right: -6px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--color-primary);
  opacity: 0;
  transform: translateY(-50%);
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}

.mini-progress:hover .mini-progress-value::after {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}

.mini-queue {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid transparent;
}

.mini-shell.is-expanded .mini-queue {
  border-top-color: rgba(0, 0, 0, 0.08);
}

.mini-queue-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.mini-queue-list::-webkit-scrollbar {
  width: 6px;
}

.mini-queue-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.18);
}

.mini-queue-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.14s ease;
}

.mini-queue-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.mini-queue-item.active {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.mini-queue-cover {
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 4px;
  overflow: hidden;
}

.mini-queue-cover :deep(.cover-container) {
  -webkit-mask-image: none;
  mask-image: none;
}

.mini-queue-playing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
}

.mini-queue-meta {
  min-width: 0;
  flex: 1 1 auto;
}

.mini-queue-song {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}

.mini-queue-item.active .mini-queue-song {
  color: var(--color-primary);
}

.mini-queue-artist {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 14px;
  color: rgba(29, 29, 31, 0.55);
}

.mini-queue-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: rgba(29, 29, 31, 0.45);
}

:global(.dark) .mini-card {
  background: #2c2c30;
  color: #f5f5f7;
  border-color: rgba(255, 255, 255, 0.14);
}

:global(.dark) .mini-cover-placeholder {
  background: rgba(255, 255, 255, 0.06);
}

:global(.dark) .mini-artist {
  color: rgba(245, 245, 247, 0.58);
}

:global(.dark) .mini-left-actions,
:global(.dark) .mini-right-actions,
:global(.dark) .mini-hover-controls {
  color: rgba(245, 245, 247, 0.72);
}

:global(.dark) .mini-window-btn:hover,
:global(.dark) .mini-action-btn:hover,
:global(.dark) .mini-center-btn:hover {
  color: #fff;
}

:global(.dark) .mini-progress::before {
  background: rgba(255, 255, 255, 0.18);
}

:global(.dark) .mini-shell.is-expanded .mini-queue {
  border-top-color: rgba(255, 255, 255, 0.08);
}

:global(.dark) .mini-queue-artist {
  color: rgba(245, 245, 247, 0.55);
}

:global(.dark) .mini-queue-empty {
  color: rgba(245, 245, 247, 0.45);
}

:global(.dark) .mini-queue-item:hover {
  background: rgba(255, 255, 255, 0.07);
}

:global(.dark) .mini-queue-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
}
</style>
