<script setup lang="ts">
/**
 * 歌词页底部播放控制栏
 * 复刻 PlayerBar 三栏布局：左侧歌曲信息+操作、中间播放控制+进度条、右侧功能按钮
 * 沉浸在页面底部，不浮动
 */
import { computed, ref } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type { IconifyIcon } from '@iconify/types';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useDeferredSeek } from '@/composables/useDeferredSeek';
import { usePlaybackProgressStatus } from '@/composables/usePlaybackProgressStatus';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import Badge from '@/components/ui/Badge.vue';
import Popover from '@/components/ui/Popover.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import SleepTimerPopover from '@/components/player/SleepTimerPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import CastPopover from '@/components/player/CastPopover.vue';
import ProgressBusyOverlay from '@/components/player/ProgressBusyOverlay.vue';
import PlayerBarMoreMenu from '@/layouts/PlayerBarMoreMenu.vue';
import {
  countPlayerBarActionSlots,
  partitionPlayerBarActions,
  resolvePlayerBarActions,
  type PlayerBarAction,
  type PlayerBarPlacementCapacity,
  type ResolvedPlayerBarAction,
} from '@/layouts/playerBarActions';
import { playerbarItems } from '@/plugins/playerbar';
import { useOutputStore } from '@/stores/output';
import {
  iconMusic,
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
  iconShirt,
  iconMoon,
  iconVolume2,
  iconSpeedometer,
  iconPulse,
  iconSlidersHorizontal,
  iconCast,
} from '@/icons';

const emit = defineEmits<{
  (e: 'openQueue'): void;
  (e: 'openComment'): void;
  (e: 'openAddToPlaylist'): void;
  (e: 'openSkins'): void;
}>();

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const toastStore = useToastStore();
const outputStore = useOutputStore();

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
  hasCurrentTrackMv,
  goToMv,
  canShareCurrentTrack,
  handleShareCurrentTrack,
} = usePlayerControls();

const isHoveringProgress = ref(false);
const lyricBarRef = ref<HTMLElement | null>(null);
const leftActionsRef = ref<HTMLElement | null>(null);
const centerAreaRef = ref<HTMLElement | null>(null);
const rightActionsRef = ref<HTMLElement | null>(null);
const actionCapacity = ref<PlayerBarPlacementCapacity>({
  left: 3,
  center: 7,
  right: 4,
});
const isPlaybackLoading = computed(() => playerStore.playbackIsLoading);
const { isBusy: isProgressBusy, ariaLabel: progressAriaLabel } = usePlaybackProgressStatus(
  () => playerStore.playbackProgressBusyReason,
);
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

const queueBadge = computed(() => {
  return queueCount.value > 99 ? '99+' : String(queueCount.value);
});
const isRemoteOutputActive = computed(
  () => outputStore.snapshot && outputStore.snapshot.protocol !== 'local',
);

const playModeIcon = computed(() => {
  if (playerStore.playMode === 'sequential') return iconRepeatOff as IconifyIcon;
  if (playerStore.playMode === 'list') return iconRepeat as IconifyIcon;
  if (playerStore.playMode === 'random') return iconShuffle as IconifyIcon;
  return iconListRestart as IconifyIcon;
});

const playerBarBadgeControls = computed(() => [
  {
    key: 'audio-quality',
    actionKeys: ['quality'],
    label: '音质',
    active: settingStore.showAudioQualityBadge,
    toggle: () => {
      settingStore.showAudioQualityBadge = !settingStore.showAudioQualityBadge;
    },
  },
  {
    key: 'audio-effect',
    actionKeys: ['effect'],
    label: '音效',
    active: settingStore.showAudioEffectBadge,
    toggle: () => {
      settingStore.showAudioEffectBadge = !settingStore.showAudioEffectBadge;
    },
  },
]);

const pluginPlayerBarActions = computed<PlayerBarAction[]>(() =>
  playerbarItems.value.map((item) => ({
    key: item.key,
    id: item.id,
    title: item.title,
    icon: item.icon,
    tooltip: item.tooltip,
    badge: item.badge(),
    badgeTitle: item.badgeTitle,
    badgeDefaultVisible: item.badgeDefaultVisible,
    trigger: item.trigger,
    defaultPlacement: item.defaultPlacement,
    order: item.order,
    visible: item.visible(),
    disabled: item.disabled(),
    onClick: item.onClick,
  })),
);

const playerBarActions = computed<PlayerBarAction[]>(() => [
  {
    id: 'sleep-timer',
    title: '定时关闭',
    icon: iconMoon as IconifyIcon,
    component: 'sleep-timer',
    trigger: 'hover',
    defaultPlacement: 'center',
    order: 1,
    visible: true,
    onClick: () => {},
  },
  {
    id: 'play-mode',
    title: '播放模式',
    icon: playModeIcon.value,
    tooltip: playModeLabel.value,
    trigger: 'click',
    defaultPlacement: 'center',
    order: 2,
    visible: true,
    onClick: cyclePlayMode,
  },
  {
    id: 'previous',
    title: '上一首',
    icon: iconSkipBack as IconifyIcon,
    trigger: 'click',
    defaultPlacement: 'center',
    order: 3,
    visible: true,
    disabled: isPlaybackLoading.value,
    onClick: playerStore.prev,
  },
  {
    id: 'play-toggle',
    title: playerStore.isPlaying ? '暂停' : '播放',
    icon: (playerStore.isPlaying ? iconPause : iconPlay) as IconifyIcon,
    trigger: 'click',
    defaultPlacement: 'center',
    order: 4,
    visible: true,
    disabled: isPlaybackLoading.value,
    onClick: playerStore.togglePlay,
  },
  {
    id: 'next',
    title: '下一首',
    icon: iconSkipForward as IconifyIcon,
    trigger: 'click',
    defaultPlacement: 'center',
    order: 5,
    visible: true,
    disabled: isPlaybackLoading.value,
    onClick: playerStore.next,
  },
  {
    id: 'volume',
    title: '音量',
    icon: iconVolume2 as IconifyIcon,
    component: 'volume',
    trigger: 'hover',
    defaultPlacement: 'center',
    order: 6,
    visible: true,
    onClick: () => {},
  },
  {
    id: 'speed',
    title: '倍速',
    icon: iconSpeedometer as IconifyIcon,
    component: 'speed',
    trigger: 'hover',
    defaultPlacement: 'center',
    order: 7,
    visible: true,
    onClick: () => {},
  },
  {
    id: 'add-to-playlist',
    title: '添加到',
    icon: iconPlaylistAdd as IconifyIcon,
    defaultPlacement: 'left',
    order: 10,
    visible: canAddToPlaylist.value,
    disabled: !canAddToPlaylist.value,
    onClick: () => emit('openAddToPlaylist'),
  },
  {
    id: 'comments',
    title: '评论',
    icon: iconMessageCircle as IconifyIcon,
    defaultPlacement: 'left',
    order: 20,
    visible: Boolean(currentTrack.value),
    disabled: !currentTrack.value,
    onClick: () => emit('openComment'),
  },
  {
    id: 'mv',
    title: '播放 MV',
    icon: iconMusic as IconifyIcon,
    defaultPlacement: 'left',
    order: 30,
    visible: hasCurrentTrackMv.value,
    disabled: !hasCurrentTrackMv.value,
    onClick: goToMv,
  },
  {
    id: 'lyric-skins',
    title: '换肤',
    icon: iconShirt as IconifyIcon,
    defaultPlacement: 'right',
    order: 35,
    visible: true,
    onClick: () => emit('openSkins'),
  },
  {
    id: 'share',
    title: '分享',
    icon: iconShare as IconifyIcon,
    defaultPlacement: 'more',
    order: 40,
    visible: canShareCurrentTrack.value,
    disabled: !canShareCurrentTrack.value,
    onClick: handleShareCurrentTrack,
  },
  {
    id: 'quality',
    title: '音质',
    icon: iconPulse as IconifyIcon,
    component: 'quality',
    trigger: 'hover',
    defaultPlacement: 'right',
    order: 42,
    visible: true,
    onClick: () => {},
  },
  {
    id: 'effect',
    title: '音效',
    icon: iconSlidersHorizontal as IconifyIcon,
    component: 'effect',
    trigger: 'hover',
    defaultPlacement: 'right',
    order: 44,
    visible: true,
    onClick: () => {},
  },
  {
    id: 'desktop-lyric',
    title: '桌面歌词',
    icon: iconTypography as IconifyIcon,
    tooltip: desktopLyricStore.settings.enabled ? '关闭桌面歌词' : '开启桌面歌词',
    defaultPlacement: 'right',
    order: 50,
    visible: true,
    active: desktopLyricStore.settings.enabled,
    badge: settingStore.showDesktopLyricStatus
      ? desktopLyricStore.settings.enabled
        ? 'ON'
        : 'OFF'
      : desktopLyricStore.settings.enabled
        ? 'ON'
        : 'OFF',
    badgeTitle: '桌面歌词',
    badgeDefaultVisible: settingStore.showDesktopLyricStatus,
    onClick: toggleDesktopLyric,
  },
  {
    id: 'cast',
    title: '投放',
    icon: iconCast as IconifyIcon,
    component: 'cast',
    trigger: 'hover',
    defaultPlacement: 'more',
    order: 55,
    visible: true,
    active: Boolean(isRemoteOutputActive.value),
    badge: isRemoteOutputActive.value ? 'ON' : null,
    badgeTitle: '投放状态',
    badgeDefaultVisible: true,
    onClick: () => {},
  },
  {
    id: 'queue',
    title: '播放队列',
    icon: iconList as IconifyIcon,
    defaultPlacement: 'right',
    order: 60,
    visible: true,
    badge: queueBadge.value,
    badgeTitle: '队列计数',
    badgeDefaultVisible: settingStore.showPlaylistCount,
    onClick: () => emit('openQueue'),
  },
  ...pluginPlayerBarActions.value,
]);

const resolvedPlayerBarActions = computed(() =>
  resolvePlayerBarActions(playerBarActions.value, settingStore.playerBarLayout),
);

const renderedPlayerBarActions = computed(() =>
  partitionPlayerBarActions(resolvedPlayerBarActions.value, actionCapacity.value),
);

const leftPlayerBarActions = computed(() => renderedPlayerBarActions.value.left);

const centerPlayerBarActions = computed(() => renderedPlayerBarActions.value.center);

const rightPlayerBarActions = computed(() => renderedPlayerBarActions.value.right);

const overflowPlayerBarActions = computed(() => renderedPlayerBarActions.value.overflow);

const activatePlayerBarAction = (item: ResolvedPlayerBarAction) => {
  if (item.disabled) return;
  void item.onClick();
};

const updateActionCapacity = () => {
  const barWidth = lyricBarRef.value?.clientWidth ?? 0;
  const leftWidth = leftActionsRef.value?.parentElement?.clientWidth ?? 0;
  const measuredCenterWidth = centerAreaRef.value?.clientWidth ?? 0;
  const measuredRightWidth = rightActionsRef.value?.clientWidth ?? 0;
  const fallbackCenterWidth = Math.max(0, barWidth - leftWidth - measuredRightWidth - 56);
  const centerWidth =
    measuredCenterWidth >= 36 ? measuredCenterWidth : fallbackCenterWidth || measuredCenterWidth;
  const fallbackRightWidth = Math.max(0, barWidth - leftWidth - centerWidth - 56);
  const rightWidth = Math.max(measuredRightWidth, fallbackRightWidth);
  actionCapacity.value = {
    left: countPlayerBarActionSlots(leftWidth, 64, 28),
    center: countPlayerBarActionSlots(centerWidth, 0, 36),
    right: countPlayerBarActionSlots(rightWidth, 112, 36),
  };
};

useResizeObserver(
  [lyricBarRef, leftActionsRef, centerAreaRef, rightActionsRef],
  updateActionCapacity,
);
</script>

<template>
  <footer ref="lyricBarRef" class="lyric-bar" data-toast-anchor="lyric-player">
    <!-- 进度条：横跨控制栏顶部，左右贴边 -->
    <div class="bar-progress-top">
      <SliderRoot
        :model-value="progressValue"
        :max="playerStore.duration || 100"
        :step="0.1"
        :aria-busy="isProgressBusy"
        :aria-label="progressAriaLabel"
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
          <SliderRange class="bar-slider-range-top">
            <ProgressBusyOverlay v-if="isProgressBusy" />
          </SliderRange>
        </SliderTrack>
        <SliderThumb
          class="bar-slider-thumb-top"
          :class="[isHoveringProgress ? 'opacity-100 scale-125' : 'opacity-0 scale-50']"
        />
      </SliderRoot>
      <!-- 时间 tooltip -->
      <div
        v-if="isHoveringProgress || isDraggingSeek"
        class="bar-progress-tooltip app-tooltip-surface"
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
          <Tooltip content="点击复制歌曲信息">
            <template #trigger>
              <div class="bar-song-text bar-song-clickable" @click="handleCopySongInfo">
                <span class="bar-song-title">{{ currentTrack?.name || '未在播放' }}</span>
                <span v-if="currentTrack" class="bar-song-sep">-</span>
                <span v-if="currentTrack" class="bar-song-artist">{{ currentTrack.artist }}</span>
              </div>
            </template>
          </Tooltip>
          <div ref="leftActionsRef" class="bar-song-actions">
            <Button
              variant="unstyled"
              size="none"
              @click="toggleFavorite"
              class="bar-action-btn text-red-500"
              tooltip="收藏"
            >
              <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" />
            </Button>
            <template v-for="item in leftPlayerBarActions" :key="item.key">
              <SleepTimerPopover v-if="item.component === 'sleep-timer'" />
              <VolumePopover v-else-if="item.component === 'volume'" variant="bar" />
              <SpeedPopover v-else-if="item.component === 'speed'" />
              <QualityPopover v-else-if="item.component === 'quality'" />
              <EffectPopover v-else-if="item.component === 'effect'" />
              <CastPopover
                v-else-if="item.component === 'cast'"
                variant="lyric"
                :show-badge="Boolean(item.visibleBadge)"
              />
              <div v-else class="bar-action-anchor">
                <Button
                  variant="unstyled"
                  size="none"
                  class="bar-action-btn"
                  :class="item.active ? 'bar-func-active' : 'bar-action-muted'"
                  :disabled="item.disabled"
                  :tooltip="item.tooltip || item.title"
                  @click="activatePlayerBarAction(item)"
                >
                  <MvIcon v-if="item.key === 'mv'" class="w-5 h-5" />
                  <PluginIcon v-else :icon="item.icon" :width="20" :height="20" />
                </Button>
                <Badge
                  v-if="item.visibleBadge"
                  :count="item.visibleBadge"
                  class="-top-px"
                  style="right: -5px"
                />
              </div>
            </template>
            <slot name="song-actions" />
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
      <div ref="centerAreaRef" class="bar-center">
        <!-- 播放控制按钮 -->
        <div class="bar-controls player-bar-action-strip">
          <template v-for="item in centerPlayerBarActions" :key="item.key">
            <SleepTimerPopover v-if="item.component === 'sleep-timer'" />
            <VolumePopover v-else-if="item.component === 'volume'" variant="bar" />
            <SpeedPopover v-else-if="item.component === 'speed'" />
            <QualityPopover v-else-if="item.component === 'quality'" />
            <EffectPopover v-else-if="item.component === 'effect'" />
            <CastPopover
              v-else-if="item.component === 'cast'"
              variant="lyric"
              :show-badge="Boolean(item.visibleBadge)"
            />
            <div v-else class="bar-action-anchor">
              <Button
                variant="unstyled"
                size="none"
                :class="[
                  item.id === 'play-toggle' ? 'bar-play-btn' : 'bar-ctrl-btn',
                  item.active ? 'bar-func-active' : 'bar-ctrl-muted',
                  {
                    'bar-ctrl-main': ['previous', 'next'].includes(item.id),
                    'is-busy': isPlaybackLoading && ['previous', 'next'].includes(item.id),
                    'is-loading': isPlaybackLoading && item.id === 'play-toggle',
                  },
                ]"
                :disabled="item.disabled && item.id !== 'play-toggle'"
                :tooltip="item.tooltip || item.title"
                :aria-busy="item.id === 'play-toggle' ? isPlaybackLoading : undefined"
                @click="activatePlayerBarAction(item)"
              >
                <span
                  v-if="item.id === 'play-toggle' && isPlaybackLoading"
                  class="bar-play-spinner"
                  aria-hidden="true"
                ></span>
                <MvIcon v-else-if="item.key === 'mv'" class="w-5 h-5" />
                <PluginIcon
                  v-else
                  :icon="item.icon"
                  :width="item.id === 'play-toggle' && !playerStore.isPlaying ? 16 : 20"
                  :height="20"
                  :class="
                    item.id === 'play-toggle' && !playerStore.isPlaying ? 'ml-0.5' : undefined
                  "
                />
              </Button>
              <Badge
                v-if="item.visibleBadge"
                :count="item.visibleBadge"
                class="-top-px"
                style="right: -5px"
              />
            </div>
          </template>
        </div>
      </div>

      <!-- 3. 右侧：功能选项 -->
      <div ref="rightActionsRef" class="bar-right player-bar-action-strip">
        <template v-for="item in rightPlayerBarActions" :key="item.key">
          <SleepTimerPopover v-if="item.component === 'sleep-timer'" />
          <VolumePopover v-else-if="item.component === 'volume'" variant="bar" />
          <SpeedPopover v-else-if="item.component === 'speed'" />
          <QualityPopover v-else-if="item.component === 'quality'" />
          <EffectPopover v-else-if="item.component === 'effect'" />
          <CastPopover
            v-else-if="item.component === 'cast'"
            variant="lyric"
            :show-badge="Boolean(item.visibleBadge)"
          />
          <div v-else class="bar-action-anchor">
            <Button
              variant="unstyled"
              size="none"
              class="bar-func-btn"
              :class="item.active ? 'bar-func-active' : 'bar-func-muted'"
              :disabled="item.disabled"
              :tooltip="item.tooltip || item.title"
              @click="activatePlayerBarAction(item)"
            >
              <MvIcon v-if="item.key === 'mv'" class="w-5 h-5" />
              <PluginIcon v-else :icon="item.icon" :width="20" :height="20" />
            </Button>
            <Badge
              v-if="item.visibleBadge"
              :count="item.visibleBadge"
              class="-top-px"
              style="right: -5px"
            />
          </div>
        </template>
        <PlayerBarMoreMenu
          :items="resolvedPlayerBarActions"
          :menu-items="overflowPlayerBarActions"
          :badges="playerBarBadgeControls"
        />
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

:deep(.bar-action-btn) {
  padding: 2px;
  transition: all 0.2s ease;
}

:deep(.bar-action-btn:hover) {
  transform: scale(1.1);
}

:deep(.bar-action-btn:active) {
  transform: scale(0.9);
}

:deep(.bar-action-muted) {
  color: rgba(255, 255, 255, 0.4);
}

:deep(.bar-action-muted:hover) {
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
  gap: 6px;
  height: 40px;
}

.player-bar-action-strip {
  --player-bar-action-size: 36px;
}

.player-bar-action-strip :deep(button) {
  display: inline-flex;
  width: var(--player-bar-action-size);
  height: var(--player-bar-action-size);
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--player-bar-action-size);
  line-height: 1;
}

.player-bar-action-strip :deep(svg),
.player-bar-action-strip :deep(.plugin-icon) {
  display: block;
}

.player-bar-action-strip :deep(button > span.relative > svg[style]) {
  transform: none !important;
}

.player-bar-action-strip :deep(.bar-play-btn) {
  width: 38px;
  height: 38px;
  flex-basis: 38px;
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

.bar-ctrl-btn.is-busy {
  opacity: 0.75;
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

.bar-play-btn.is-loading {
  background: rgba(255, 255, 255, 0.22);
}

.bar-play-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 999px;
  animation: bar-play-spin 0.8s linear infinite;
}

@keyframes bar-play-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 3. 右侧 */
.bar-action-anchor {
  position: relative;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
}

.bar-song-actions .bar-action-anchor {
  flex: 0 0 auto;
  width: auto;
  height: auto;
  display: inline-flex;
}

.bar-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding-right: 6px;
}

:deep(.bar-func-btn) {
  padding: 8px;
  transition: all 0.2s ease;
}

:deep(.bar-func-btn:hover) {
  transform: scale(1.1);
}

:deep(.bar-func-btn:active) {
  transform: scale(0.9);
}

:deep(.bar-func-muted) {
  color: rgba(255, 255, 255, 0.5);
}

:deep(.bar-func-muted:hover) {
  color: white;
}

:deep(.bar-func-active) {
  color: white;
}
</style>

<style>
/* 歌词页底部控制栏内的徽标颜色覆盖 */
.lyric-bar .badge {
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
