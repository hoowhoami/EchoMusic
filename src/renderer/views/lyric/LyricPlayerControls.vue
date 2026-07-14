<script setup lang="ts">
/**
 * 歌词页底部播放控制栏
 * 复刻 PlayerBar 三栏布局：左侧歌曲信息+操作、中间播放控制+进度条、右侧功能按钮
 * 沉浸在页面底部，不浮动
 */
import { computed, ref } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useDeferredSeek } from '@/composables/useDeferredSeek';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import Badge from '@/components/ui/Badge.vue';
import Popover from '@/components/ui/Popover.vue';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import {
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconHeart,
  iconHeartFilled,
  iconList,
  iconPlaylistAdd,
  iconTypography,
  iconMessageCircle,
  iconTriangleAlert,
  iconRepeat,
  iconRepeatOff,
  iconShuffle,
  iconListRestart,
  iconShare,
} from '@/icons';

const emit = defineEmits<{
  (e: 'openQueue'): void;
  (e: 'openComment'): void;
  (e: 'openAddToPlaylist'): void;
}>();

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const toastStore = useToastStore();

const {
  player: playerStore,
  currentTrack,
  isFavorite,
  toggleFavorite,
  playModeLabel,
  cyclePlayMode,
  toggleDesktopLyric,
  queueCount,
  canAddToPlaylist,
  canShareCurrentTrack,
  handleShareCurrentTrack,
} = usePlayerControls();

const isHoveringProgress = ref(false);
const {
  pendingSeekTime,
  isDragging: isDraggingSeek,
  progressValue,
  handleStart: handleSeekStart,
  handleValueUpdate: handleSeek,
  handleCommit: handleSeekCommit,
  handleEnd: handleSeekEnd,
  handleCancel: handleSeekCancel,
} = useDeferredSeek({
  getCurrentTime: () => playerStore.currentTime,
  seek: (time) => playerStore.seek(time),
});

const progressTooltipPercent = computed(() => {
  const displayTime =
    isDraggingSeek.value && pendingSeekTime.value !== null
      ? pendingSeekTime.value
      : playerStore.currentTime;

  return (displayTime / Math.max(playerStore.duration, 1)) * 100;
});

const formatTime = (seconds: number) => {
  if (!seconds || isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const handleCopySongInfo = async () => {
  const track = currentTrack.value;
  if (!track) return;
  const title = track.name || '';
  const artist = track.artist || '';
  const text = artist ? `${title} - ${artist}` : title;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toastStore.success('已复制歌曲信息');
  } catch {
    toastStore.warning('复制失败');
  }
};
</script>

<template>
  <footer class="lyric-bar">
    <!-- 进度条：横跨控制栏顶部，左右贴边 -->
    <div class="bar-progress-top">
      <SliderRoot
        :model-value="progressValue"
        :max="playerStore.duration || 100"
        :step="0.1"
        class="bar-slider-top group/progress"
        @update:model-value="handleSeek"
        @pointerdown.capture="handleSeekStart"
        @value-commit="handleSeekCommit"
        @pointerup="handleSeekEnd"
        @pointercancel="handleSeekCancel"
        @mouseenter="isHoveringProgress = true"
        @mouseleave="isHoveringProgress = false"
      >
        <SliderTrack class="bar-slider-track-top">
          <div class="bar-climax-layer">
            <template
              v-for="(mark, index) in playerStore.climaxMarks"
              :key="`${mark.start}-${index}`"
            >
              <span
                class="bar-climax-tick"
                :style="{ left: `calc(${(mark.start * 100).toFixed(3)}% - 1px)` }"
              ></span>
              <span
                v-if="mark.end > mark.start"
                class="bar-climax-tick"
                :style="{ left: `calc(${(mark.end * 100).toFixed(3)}% - 1px)` }"
              ></span>
            </template>
          </div>
          <SliderRange class="bar-slider-range-top" />
        </SliderTrack>
        <SliderThumb
          class="bar-slider-thumb-top"
          :class="[isHoveringProgress ? 'opacity-100 scale-125' : 'opacity-0 scale-50']"
        />
      </SliderRoot>
      <!-- 时间 tooltip -->
      <div
        v-if="isHoveringProgress || isDraggingSeek"
        class="bar-progress-tooltip"
        :style="{
          left: `clamp(var(--bar-progress-tooltip-edge-gap), ${progressTooltipPercent}%, calc(100% - var(--bar-progress-tooltip-edge-gap)))`,
        }"
      >
        {{
          formatTime(
            isDraggingSeek && pendingSeekTime !== null ? pendingSeekTime : playerStore.currentTime,
          )
        }}
        / {{ formatTime(playerStore.duration) }}
      </div>
    </div>

    <!-- 主控制区域 -->
    <div class="bar-main">
      <!-- 1. 左侧：歌曲信息 + 操作按钮 -->
      <div class="bar-left">
        <!-- 歌曲信息 + 操作 -->
        <div class="bar-song-info">
          <div
            class="bar-song-text bar-song-clickable"
            title="点击复制歌曲信息"
            @click="handleCopySongInfo"
          >
            <span class="bar-song-title">{{ currentTrack?.name || '未在播放' }}</span>
            <span v-if="currentTrack" class="bar-song-sep">-</span>
            <span v-if="currentTrack" class="bar-song-artist">{{ currentTrack.artist }}</span>
          </div>
          <div class="bar-song-actions">
            <Button
              variant="unstyled"
              size="none"
              @click="toggleFavorite"
              class="bar-action-btn text-red-500"
              title="收藏"
            >
              <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" />
            </Button>
            <Button
              v-if="canAddToPlaylist"
              variant="unstyled"
              size="none"
              @click="emit('openAddToPlaylist')"
              class="bar-action-btn bar-action-muted"
              title="添加到"
            >
              <Icon :icon="iconPlaylistAdd" width="20" height="20" />
            </Button>
            <Button
              v-if="currentTrack"
              variant="unstyled"
              size="none"
              @click="emit('openComment')"
              class="bar-action-btn bar-action-muted"
              title="评论"
            >
              <Icon :icon="iconMessageCircle" width="20" height="20" />
            </Button>
            <Popover
              v-if="playerStore.playbackNotice"
              trigger="hover"
              side="top"
              align="center"
              :side-offset="8"
              :show-arrow="true"
              content-class="player-error-popover"
            >
              <template #trigger>
                <div class="bar-error-indicator">
                  <Icon :icon="iconTriangleAlert" width="20" height="20" />
                </div>
              </template>
              <div class="player-error-content">
                <div class="player-error-title">{{ playerStore.playbackNotice.title }}</div>
                <div class="player-error-reason">{{ playerStore.playbackNotice.reason }}</div>
                <div class="player-error-detail">{{ playerStore.playbackNotice.detail }}</div>
              </div>
            </Popover>
          </div>
        </div>
      </div>

      <!-- 2. 中间：播放控制 -->
      <div class="bar-center">
        <!-- 播放控制按钮 -->
        <div class="bar-controls">
          <Tooltip :content="playModeLabel" side="top">
            <template #trigger>
              <Button
                variant="unstyled"
                size="none"
                @click="cyclePlayMode"
                class="bar-ctrl-btn bar-ctrl-muted"
              >
                <Icon
                  v-if="playerStore.playMode === 'sequential'"
                  :icon="iconRepeatOff"
                  width="22"
                  height="22"
                />
                <Icon
                  v-else-if="playerStore.playMode === 'list'"
                  :icon="iconRepeat"
                  width="22"
                  height="22"
                />
                <Icon
                  v-else-if="playerStore.playMode === 'random'"
                  :icon="iconShuffle"
                  width="22"
                  height="22"
                />
                <Icon v-else :icon="iconListRestart" width="22" height="22" />
              </Button>
            </template>
          </Tooltip>

          <Button
            variant="unstyled"
            size="none"
            @click="playerStore.prev()"
            class="bar-ctrl-btn bar-ctrl-main"
          >
            <Icon :icon="iconSkipBack" width="22" height="22" />
          </Button>

          <Button
            variant="unstyled"
            size="none"
            @click="playerStore.togglePlay()"
            class="bar-play-btn"
          >
            <Icon
              v-if="!playerStore.isPlaying"
              :icon="iconPlay"
              width="16"
              height="16"
              class="ml-0.5"
            />
            <Icon v-else :icon="iconPause" width="20" height="20" />
          </Button>

          <Button
            variant="unstyled"
            size="none"
            @click="playerStore.next()"
            class="bar-ctrl-btn bar-ctrl-main"
          >
            <Icon :icon="iconSkipForward" width="22" height="22" />
          </Button>

          <VolumePopover variant="bar" />
        </div>
      </div>

      <!-- 3. 右侧：功能选项 -->
      <div class="bar-right">
        <Button
          v-if="canShareCurrentTrack"
          variant="unstyled"
          size="none"
          class="bar-func-btn bar-func-muted"
          title="分享"
          @click="handleShareCurrentTrack"
        >
          <Icon :icon="iconShare" width="20" height="20" />
        </Button>

        <SpeedPopover />
        <QualityPopover />
        <EffectPopover />

        <div class="relative">
          <Button
            variant="unstyled"
            size="none"
            class="bar-func-btn"
            :class="desktopLyricStore.settings.enabled ? 'bar-func-active' : 'bar-func-muted'"
            :title="desktopLyricStore.settings.enabled ? '关闭桌面歌词' : '开启桌面歌词'"
            @click="toggleDesktopLyric"
          >
            <Icon :icon="iconTypography" width="20" height="20" />
          </Button>
          <Badge
            v-if="settingStore.showDesktopLyricStatus"
            :count="desktopLyricStore.settings.enabled ? 'ON' : 'OFF'"
            class="-top-px"
            style="right: -5px"
          />
        </div>

        <div class="relative">
          <Button
            variant="unstyled"
            size="none"
            class="bar-func-btn bar-func-muted"
            title="播放列表"
            @click="emit('openQueue')"
          >
            <Icon :icon="iconList" width="20" height="20" />
          </Button>
          <Badge
            v-if="settingStore.showPlaylistCount"
            :count="queueCount > 99 ? '99+' : queueCount"
            class="-top-px"
            style="right: -5px"
          />
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.lyric-bar {
  width: 100%;
  display: flex;
  flex-direction: column;
  user-select: none;
  flex-shrink: 0;
  background: transparent;
  position: relative;
  z-index: 5;
}

/* 顶部进度条 */
.bar-progress-top {
  --bar-progress-tooltip-edge-gap: 46px;
  --control-track-bg: rgba(255, 255, 255, 0.18);
  --control-thumb-bg: #ffffff;
  --control-border: rgba(0, 0, 0, 0.14);
  --shadow-control: 0 2px 4px rgba(0, 0, 0, 0.18);
  width: 100%;
  position: relative;
  overflow: visible;
  z-index: 10;
}

.bar-progress-tooltip {
  position: absolute;
  bottom: 100%;
  transform: translateX(-50%);
  margin-bottom: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  z-index: 20;
}

.bar-slider-top {
  position: relative;
  display: flex;
  align-items: center;
  user-select: none;
  touch-action: none;
  width: 100%;
  height: 16px;
  cursor: pointer;
}

.bar-slider-track-top {
  background: var(--control-track-bg);
  position: relative;
  flex-grow: 1;
  border-radius: 9999px;
  height: 3px;
}

.bar-climax-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.bar-climax-tick {
  position: absolute;
  top: calc(50% - 3px);
  width: 2px;
  height: 6px;
  border-radius: 1px;
  background: var(--color-primary);
  opacity: 0.78;
}

.bar-slider-range-top {
  position: absolute;
  background: var(--color-primary);
  border-radius: 9999px;
  height: 100%;
}

.bar-slider-thumb-top {
  display: block;
  width: 10px;
  height: 10px;
  background: var(--control-thumb-bg);
  border: 1px solid var(--control-border);
  border-radius: 50%;
  box-shadow: var(--shadow-control);
  transition:
    opacity 0.2s,
    transform 0.2s;
}

/* 主控制区域 */
.bar-main {
  width: 100%;
  height: 72px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  padding: 0 16px;
  gap: 12px;
}

/* 1. 左侧 */
.bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
}

.bar-song-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 4px;
  padding: 4px 0;
}

.bar-song-text {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
  min-width: 0;
}

.bar-song-title {
  display: block;
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 16px);
  font-size: 14px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.95);
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-song-sep {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}

.bar-song-artist {
  display: block;
  flex: 1 10 auto;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
  min-width: 0;
  max-width: 52%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-song-clickable {
  cursor: pointer;
  transition: color 0.2s ease;
}

.bar-song-clickable:hover {
  color: white;
}

.bar-song-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bar-action-btn {
  padding: 2px;
  transition: all 0.2s ease;
}

.bar-action-btn:hover {
  transform: scale(1.1);
}

.bar-action-btn:active {
  transform: scale(0.9);
}

.bar-action-muted {
  color: rgba(255, 255, 255, 0.4);
}

.bar-action-muted:hover {
  color: rgba(255, 255, 255, 0.9);
}

.bar-error-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  color: #ef4444;
  opacity: 0.92;
  cursor: help;
}

:global(.dark) .bar-error-indicator {
  color: #f87171;
}

/* 2. 中间 */
.bar-center {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: max-content;
}

.bar-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  height: 40px;
}

.bar-ctrl-btn {
  padding: 8px;
  transition: all 0.2s ease;
}

.bar-ctrl-btn:hover {
  transform: scale(1.1);
}

.bar-ctrl-btn:active {
  transform: scale(0.9);
}

.bar-ctrl-muted {
  color: rgba(255, 255, 255, 0.5);
}

.bar-ctrl-muted:hover {
  color: rgba(255, 255, 255, 0.95);
}

.bar-ctrl-main {
  color: rgba(255, 255, 255, 0.7);
}

.bar-ctrl-main:hover {
  color: white;
}

.bar-play-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  transition: all 0.2s ease;
}

.bar-play-btn:hover {
  transform: scale(1.1);
  background: rgba(255, 255, 255, 0.25);
}

.bar-play-btn:active {
  transform: scale(0.95);
}

/* 3. 右侧 */
.bar-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding-right: 6px;
}

.bar-func-btn {
  padding: 8px;
  transition: all 0.2s ease;
}

.bar-func-btn:hover {
  transform: scale(1.1);
}

.bar-func-btn:active {
  transform: scale(0.9);
}

.bar-func-muted {
  color: rgba(255, 255, 255, 0.5);
}

.bar-func-muted:hover {
  color: white;
}

.bar-func-active {
  color: white;
}
</style>

<style>
/* 歌词页底部控制栏内的徽标颜色覆盖 */
.lyric-bar .badge,
.lyric-bar [class*='badge'] {
  background-color: rgba(255, 255, 255, 0.9) !important;
  color: #000 !important;
}

/* 写真模式下去掉控制栏分隔线 */
.is-portrait .lyric-bar {
  border-top-color: transparent;
}

/* 右侧 SpeedPopover / QualityPopover / EffectPopover / VolumePopover 按钮颜色 */
.lyric-bar .bar-right button,
.lyric-bar .bar-right [role='button'],
.lyric-bar .bar-controls button,
.lyric-bar .bar-controls [role='button'] {
  color: rgba(255, 255, 255, 0.5) !important;
}

.lyric-bar .bar-right button:hover,
.lyric-bar .bar-right [role='button']:hover,
.lyric-bar .bar-controls button:hover,
.lyric-bar .bar-controls [role='button']:hover {
  color: white !important;
}

/* 保留特定按钮的颜色不被覆盖 */
.lyric-bar .bar-play-btn,
.lyric-bar .bar-play-btn:hover {
  color: white !important;
}

.lyric-bar .text-red-500,
.lyric-bar .text-red-500:hover {
  color: #ef4444 !important;
}

.lyric-bar .bar-func-active,
.lyric-bar .bar-func-active:hover {
  color: white !important;
}

/* 确保弹出层在歌词页之上 */
body:has(.lyric-page) [data-radix-popper-content-wrapper] {
  z-index: 1500 !important;
}
</style>
