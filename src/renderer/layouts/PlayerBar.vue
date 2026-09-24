<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type { SongArtist } from '@/models/song';
import type { IconifyIcon } from '@iconify/types';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import SleepTimerPopover from '@/components/player/SleepTimerPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import CastPopover from '@/components/player/CastPopover.vue';
import PlayerBarMoreMenu from './PlayerBarMoreMenu.vue';
import ProgressBusyOverlay from '@/components/player/ProgressBusyOverlay.vue';
import Cover from '@/components/ui/Cover.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { useDeferredSeek } from '@/composables/useDeferredSeek';
import { usePlaybackProgressStatus } from '@/composables/usePlaybackProgressStatus';
import Popover from '@/components/ui/Popover.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import AddToPlaylistDialog from '@/components/music/AddToPlaylistDialog.vue';
import {
  iconMusic,
  iconHeart,
  iconHeartFilled,
  iconCloud,
  iconTriangleAlert,
  iconMessageCircle,
  iconRepeat,
  iconShuffle,
  iconListRestart,
  iconRepeatOff,
  iconSkipBack,
  iconSkipForward,
  iconPlay,
  iconPause,
  iconList,
  iconPlaylistAdd,
  iconTypography,
  iconShare,
  iconMoon,
  iconVolume2,
  iconSpeedometer,
  iconPulse,
  iconSlidersHorizontal,
  iconCast,
} from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';
import {
  countPlayerBarActionSlots,
  partitionPlayerBarActions,
  resolvePlayerBarActions,
  type PlayerBarAction,
  type PlayerBarPlacementCapacity,
  type ResolvedPlayerBarAction,
} from './playerBarActions';
import { playerbarItems } from '@/plugins/playerbar';
import { useOutputStore } from '@/stores/output';

const router = useRouter();
const outputStore = useOutputStore();

const {
  player,
  settingStore,
  desktopLyricStore,
  currentTrack,
  isFavorite,
  toggleFavorite,
  playModeLabel,
  cyclePlayMode,
  toggleDesktopLyric,
  resolveNumericId,
  goToComments,
  hasCurrentTrackMv,
  goToMv,
  queueCount,
  isQueueDrawerOpen,
  openQueue,
  showAddToPlaylistDialog,
  isPlaylistLoading,
  canAddToPlaylist,
  createdPlaylists,
  addToPlaybackQueues,
  handleOpenAddToPlaylist,
  handleAddToQueue,
  handleSelectPlaylist,
  canShareCurrentTrack,
  handleShareCurrentTrack,
} = usePlayerControls();

const playbackNotice = computed(() => player.playbackNotice);
const isPlaybackLoading = computed(() => player.playbackIsLoading);
const { isBusy: isProgressBusy, ariaLabel: progressAriaLabel } = usePlaybackProgressStatus(
  () => player.playbackProgressBusyReason,
);

const artistList = computed(() => {
  if (!currentTrack.value) return [];
  if (currentTrack.value.artists && currentTrack.value.artists.length > 0)
    return currentTrack.value.artists;
  if (!currentTrack.value.artist) return [] as SongArtist[];
  return currentTrack.value.artist
    .split(/[,/，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
});

const formatTime = (seconds: number) => {
  if (!seconds || isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const navigateToLyric = () => {
  player.toggleLyricView(true);
};

const isArtistClickable = (artist: SongArtist) => {
  return resolveNumericId(artist.id) !== null;
};

const goToArtist = (artist: SongArtist) => {
  const artistId = resolveNumericId(artist.id);
  if (!artistId) return;
  router.push({ name: 'artist-detail', params: { id: String(artistId) } });
};

const currentAlbumName = computed(() =>
  String(currentTrack.value?.album ?? currentTrack.value?.albumName ?? '').trim(),
);

const currentAlbumId = computed(() => resolveNumericId(currentTrack.value?.albumId));

const isCurrentAlbumClickable = computed(() => {
  const albumId = currentAlbumId.value;
  return Boolean(albumId && currentAlbumName.value);
});

const goToCurrentAlbum = () => {
  const albumId = currentAlbumId.value;
  if (!albumId) return;
  router.push({ name: 'album-detail', params: { id: String(albumId) } });
};

const isHoveringProgress = ref(false);
const playerBarRef = ref<HTMLElement | null>(null);
const leftActionsRef = ref<HTMLElement | null>(null);
const centerAreaRef = ref<HTMLElement | null>(null);
const rightActionsRef = ref<HTMLElement | null>(null);
const actionCapacity = ref<PlayerBarPlacementCapacity>({
  left: 3,
  center: 7,
  right: 3,
});

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
  getCurrentTime: () => player.currentTime,
  seek: (time) => player.seek(time),
});

const toggleFavoritePB = (e: Event) => {
  e.stopPropagation();
  toggleFavorite();
};

const queueBadge = computed(() => {
  return queueCount.value > 99 ? '99+' : String(queueCount.value);
});
const isRemoteOutputActive = computed(
  () => outputStore.snapshot && outputStore.snapshot.protocol !== 'local',
);

const playModeIcon = computed(() => {
  if (player.playMode === 'sequential') return iconRepeatOff as IconifyIcon;
  if (player.playMode === 'list') return iconRepeat as IconifyIcon;
  if (player.playMode === 'random') return iconShuffle as IconifyIcon;
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
    onClick: player.prev,
  },
  {
    id: 'play-toggle',
    title: player.isPlaying ? '暂停' : '播放',
    icon: (player.isPlaying ? iconPause : iconPlay) as IconifyIcon,
    trigger: 'click',
    defaultPlacement: 'center',
    order: 4,
    visible: true,
    disabled: isPlaybackLoading.value,
    onClick: player.togglePlay,
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
    onClick: player.next,
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
    onClick: handleOpenAddToPlaylist,
  },
  {
    id: 'comments',
    title: '详情及评论',
    icon: iconMessageCircle as IconifyIcon,
    defaultPlacement: 'left',
    order: 20,
    visible: Boolean(currentTrack.value),
    disabled: !currentTrack.value,
    onClick: goToComments,
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
    onClick: openQueue,
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
  const barWidth = playerBarRef.value?.clientWidth ?? 0;
  const leftWidth = leftActionsRef.value?.parentElement?.clientWidth ?? 0;
  const measuredCenterWidth = centerAreaRef.value?.clientWidth ?? 0;
  const measuredRightWidth = rightActionsRef.value?.clientWidth ?? 0;
  const fallbackCenterWidth = Math.max(0, barWidth - leftWidth - measuredRightWidth - 64);
  const centerWidth =
    measuredCenterWidth >= 36 ? measuredCenterWidth : fallbackCenterWidth || measuredCenterWidth;
  const fallbackRightWidth = Math.max(0, barWidth - leftWidth - centerWidth - 64);
  const rightWidth = Math.max(measuredRightWidth, fallbackRightWidth);
  actionCapacity.value = {
    left: countPlayerBarActionSlots(leftWidth, 72, 28),
    center: countPlayerBarActionSlots(centerWidth, 0, 36),
    right: countPlayerBarActionSlots(rightWidth, 112, 36),
  };
};

useResizeObserver(
  [playerBarRef, leftActionsRef, centerAreaRef, rightActionsRef],
  updateActionCapacity,
);

const updateDrawerWidth = () => {
  const content = document.querySelector('.main-content') as HTMLElement | null;
  const target = content;
  if (target) {
    const rect = target.getBoundingClientRect();
    const width = Math.floor(target.clientWidth);
    const left = Math.floor(rect.left);
    const top = Math.floor(rect.top);
    const height = Math.floor(target.clientHeight);
    document.documentElement.style.setProperty('--drawer-content-width', `${width}px`);
    document.documentElement.style.setProperty('--drawer-content-left', `${left}px`);
    document.documentElement.style.setProperty('--drawer-content-top', `${top}px`);
    document.documentElement.style.setProperty('--drawer-content-height', `${height}px`);
  }
  const playerBar = document.querySelector('.player-bar-container') as HTMLElement | null;
  if (playerBar) {
    const offset = Math.floor(playerBar.offsetHeight + 8);
    document.documentElement.style.setProperty('--drawer-bottom-offset', `${offset}px`);
  }
};

// Marquee logic
const songInfoRef = ref<HTMLElement | null>(null);
const isMarqueeActive = ref(false);
const marqueeDistance = ref('0px');
const MARQUEE_MAX_SCROLL_PX = 180;
const MARQUEE_ITERATIONS = 2;
let marqueeStopTimer: number | null = null;

const stopMarquee = () => {
  isMarqueeActive.value = false;
  if (marqueeStopTimer) {
    window.clearTimeout(marqueeStopTimer);
    marqueeStopTimer = null;
  }
};

const startMarquee = () => {
  if (!songInfoRef.value) return;
  const container = songInfoRef.value.parentElement;
  if (!container) return;
  const overflow = Math.max(0, songInfoRef.value.scrollWidth - container.clientWidth);
  const travelDistance = Math.min(overflow, MARQUEE_MAX_SCROLL_PX);
  if (overflow <= 8 || travelDistance <= 8) {
    stopMarquee();
    return;
  }
  marqueeDistance.value = `${travelDistance}px`;
  isMarqueeActive.value = true;
  // 动画播放 N 次后自动停止（10s 一次循环）
  if (marqueeStopTimer) window.clearTimeout(marqueeStopTimer);
  marqueeStopTimer = window.setTimeout(() => {
    marqueeStopTimer = null;
    isMarqueeActive.value = false;
  }, 10000 * MARQUEE_ITERATIONS);
};

const checkMarquee = () => {
  startMarquee();
};

const handleSongInfoHover = () => {
  // hover 时如果动画已停止，重新启动
  if (!isMarqueeActive.value) {
    startMarquee();
  }
};

watch(
  () => [currentTrack.value?.id, currentTrack.value?.name, currentTrack.value?.artist],
  async () => {
    await nextTick();
    checkMarquee();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('resize', checkMarquee);
  window.addEventListener('resize', updateDrawerWidth);
  window.addEventListener('resize', updateActionCapacity);
  checkMarquee();
  updateDrawerWidth();
  updateActionCapacity();
  void nextTick(updateActionCapacity);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMarquee);
  window.removeEventListener('resize', updateDrawerWidth);
  window.removeEventListener('resize', updateActionCapacity);
  stopMarquee();
});
</script>

<template>
  <div
    class="player-bar-container w-full shrink-0 px-2 pb-1.25 z-1000"
    data-toast-anchor="main-player"
  >
    <footer
      ref="playerBarRef"
      class="player-bar w-full h-21 border rounded-xl flex items-center justify-between px-3 py-1 gap-3 select-none no-drag transition-all duration-300"
    >
      <!-- 1. 左侧：歌曲信息 - 弹性增长 -->
      <div class="flex-1 flex items-center gap-3 min-w-30 max-w-[320px] overflow-hidden">
        <div
          class="relative w-14 h-14 shrink-0 cursor-pointer group rounded-[10px] overflow-hidden bg-[var(--control-muted-bg)]"
          @click="navigateToLyric"
        >
          <Cover
            v-if="currentTrack"
            :url="currentTrack.coverUrl"
            :size="200"
            :width="56"
            :height="56"
            :borderRadius="10"
            class="transition-transform duration-500 group-hover:scale-110"
          />
          <div v-else class="w-full h-full flex items-center justify-center text-text-main/30">
            <Icon :icon="iconMusic" width="24" height="24" />
          </div>
        </div>

        <div class="flex flex-col min-w-0 flex-1 h-full py-1">
          <div class="relative w-full overflow-hidden h-6 flex items-center">
            <div
              ref="songInfoRef"
              class="player-song-info whitespace-nowrap transition-transform flex items-center gap-1 min-w-max"
              :class="{ 'marquee-animation': isMarqueeActive }"
              :style="{ '--marquee-distance': marqueeDistance }"
              @mouseenter="handleSongInfoHover"
            >
              <Tooltip :content="isCurrentAlbumClickable ? '查看专辑' : ''">
                <template #trigger>
                  <span
                    class="text-[14px] font-bold text-primary-text cursor-pointer transition-colors"
                    :class="{ 'hover:text-primary-text/80': isCurrentAlbumClickable }"
                    @click="goToCurrentAlbum"
                  >
                    {{ currentTrack ? currentTrack.name : '未在播放' }}
                  </span>
                </template>
              </Tooltip>
              <span v-if="currentTrack" class="text-[14px] text-primary-text/60 mx-0.5">-</span>
              <div v-if="currentTrack" class="flex items-center">
                <template v-for="(artist, index) in artistList" :key="index">
                  <span
                    class="text-[13px] transition-colors"
                    :class="
                      isArtistClickable(artist)
                        ? 'text-primary-text/70 hover:text-primary-text cursor-pointer'
                        : 'text-primary-text/70'
                    "
                    @click="isArtistClickable(artist) && goToArtist(artist)"
                  >
                    {{ artist.name }}
                  </span>
                  <span
                    v-if="index < artistList.length - 1"
                    class="text-[13px] text-text-main/50 mx-0.5"
                    >/</span
                  >
                </template>
              </div>
            </div>
          </div>

          <div
            ref="leftActionsRef"
            class="player-bar-left-actions flex items-center gap-1.5 mt-1 h-7"
          >
            <Button
              variant="unstyled"
              size="none"
              @click="toggleFavoritePB"
              class="p-0.5 text-red-500 transition-all hover:scale-110 active:scale-90"
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
                :show-badge="Boolean(item.visibleBadge)"
              />
              <div v-else class="playerbar-action-anchor playerbar-left-action-anchor">
                <Button
                  variant="unstyled"
                  size="none"
                  class="p-0.5 transition-all hover:scale-110 active:scale-90"
                  :class="
                    item.active ? 'text-primary-text' : 'text-text-main/25 hover:text-primary-text'
                  "
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
                  class="playerbar-action-badge"
                />
              </div>
            </template>

            <Tooltip v-if="currentTrack?.source === 'cloud'" content="云盘歌曲">
              <template #trigger>
                <div class="text-primary-text/60">
                  <Icon :icon="iconCloud" width="20" height="20" />
                </div>
              </template>
            </Tooltip>

            <Popover
              v-if="playbackNotice"
              trigger="hover"
              side="top"
              align="center"
              :side-offset="8"
              :show-arrow="true"
              content-class="player-error-popover"
            >
              <template #trigger>
                <div class="player-error-indicator">
                  <Icon :icon="iconTriangleAlert" width="20" height="20" />
                </div>
              </template>

              <div class="player-error-content">
                <div class="player-error-title">{{ playbackNotice.title }}</div>
                <div class="player-error-reason">{{ playbackNotice.reason }}</div>
                <div class="player-error-detail">{{ playbackNotice.detail }}</div>
              </div>
            </Popover>
          </div>
        </div>
      </div>

      <!-- 2. 中间：播放控制 & 进度条 - 核心弹性区域 -->
      <div
        ref="centerAreaRef"
        class="flex-[1.5] flex flex-col items-center justify-center gap-1 min-w-37.5"
      >
        <div class="player-bar-action-strip flex items-center justify-center gap-1.5 h-10">
          <template v-for="item in centerPlayerBarActions" :key="item.key">
            <SleepTimerPopover v-if="item.component === 'sleep-timer'" />
            <VolumePopover v-else-if="item.component === 'volume'" variant="bar" />
            <SpeedPopover v-else-if="item.component === 'speed'" />
            <QualityPopover v-else-if="item.component === 'quality'" />
            <EffectPopover v-else-if="item.component === 'effect'" />
            <CastPopover
              v-else-if="item.component === 'cast'"
              :show-badge="Boolean(item.visibleBadge)"
            />
            <div v-else class="playerbar-action-anchor">
              <Button
                variant="unstyled"
                size="none"
                :class="[
                  item.id === 'play-toggle'
                    ? 'player-toggle w-9.5 h-9.5 rounded-full flex items-center justify-center hover:scale-110 hover:text-primary-text active:scale-95 transition-all border'
                    : 'p-2 transition-all hover:scale-110 active:scale-90',
                  item.active ? 'text-primary-text' : 'text-text-main/50 hover:text-primary-text',
                  {
                    'player-step-busy': isPlaybackLoading && ['previous', 'next'].includes(item.id),
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
                  class="player-toggle-spinner"
                  aria-hidden="true"
                ></span>
                <MvIcon v-else-if="item.key === 'mv'" class="w-5 h-5" />
                <PluginIcon
                  v-else
                  :icon="item.icon"
                  :width="item.id === 'play-toggle' && !player.isPlaying ? 16 : 20"
                  :height="20"
                  :class="item.id === 'play-toggle' && !player.isPlaying ? 'ml-0.5' : undefined"
                />
              </Button>
              <Badge
                v-if="item.visibleBadge"
                :count="item.visibleBadge"
                class="playerbar-action-badge"
              />
            </div>
          </template>
        </div>

        <!-- 进度条系统 - 动态伸缩至最大值 -->
        <div class="w-full max-w-120 flex items-center gap-3 px-1 h-3.5 min-w-0">
          <span
            class="text-[10px] font-medium text-text-main/50 w-9 shrink-0 text-right tabular-nums"
            >{{
              formatTime(
                isDraggingSeek && pendingSeekTime !== null ? pendingSeekTime : player.currentTime,
              )
            }}</span
          >
          <SliderRoot
            :model-value="progressValue"
            :max="player.duration || 100"
            :step="0.1"
            :aria-busy="isProgressBusy"
            :aria-label="progressAriaLabel"
            class="relative flex items-center select-none touch-none flex-1 min-w-0 h-4 cursor-pointer group/progress"
            @update:model-value="handleSeek"
            @pointerdown.capture="handleSeekStart"
            @value-commit="handleSeekCommit"
            @pointerup="handleSeekEnd"
            @pointercancel="handleSeekCancel"
            @mouseenter="isHoveringProgress = true"
            @mouseleave="isHoveringProgress = false"
          >
            <SliderTrack class="player-progress-track relative grow rounded-full h-0.75">
              <div class="climax-mark-layer">
                <template
                  v-for="(mark, index) in player.climaxMarks"
                  :key="`${mark.start}-${index}`"
                >
                  <span
                    class="climax-tick"
                    :style="{ left: `calc(${(mark.start * 100).toFixed(3)}% - 1px)` }"
                  ></span>
                  <span
                    v-if="mark.end > mark.start"
                    class="climax-tick"
                    :style="{ left: `calc(${(mark.end * 100).toFixed(3)}% - 1px)` }"
                  ></span>
                </template>
              </div>
              <SliderRange class="absolute bg-primary rounded-full h-full">
                <ProgressBusyOverlay v-if="isProgressBusy" />
              </SliderRange>
            </SliderTrack>
            <SliderThumb
              class="player-progress-thumb block w-2.5 h-2.5 border rounded-full shadow-md focus-visible:outline-none transition-[opacity,transform] duration-200"
              :class="[isHoveringProgress ? 'opacity-100 scale-125' : 'opacity-0 scale-50']"
            />
          </SliderRoot>
          <span
            class="text-[10px] font-medium text-text-main/50 w-9 shrink-0 text-left tabular-nums"
            >{{ formatTime(player.duration) }}</span
          >
        </div>
      </div>

      <!-- 3. 右侧：功能选项 - 弹性增长 -->
      <div
        ref="rightActionsRef"
        class="player-actions player-bar-action-strip flex-1 flex justify-end items-center gap-1 min-w-30 max-w-[320px]"
      >
        <template v-for="item in rightPlayerBarActions" :key="item.key">
          <SleepTimerPopover v-if="item.component === 'sleep-timer'" />
          <VolumePopover v-else-if="item.component === 'volume'" variant="bar" />
          <SpeedPopover v-else-if="item.component === 'speed'" />
          <QualityPopover v-else-if="item.component === 'quality'" />
          <EffectPopover v-else-if="item.component === 'effect'" />
          <CastPopover
            v-else-if="item.component === 'cast'"
            :show-badge="Boolean(item.visibleBadge)"
          />
          <div v-else class="playerbar-action-anchor">
            <Button
              variant="unstyled"
              size="none"
              class="p-2 transition-all hover:scale-110 active:scale-90"
              :class="
                item.active ? 'text-primary-text' : 'text-text-main/50 hover:text-primary-text'
              "
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
              class="playerbar-action-badge"
            />
          </div>
        </template>
        <PlayerBarMoreMenu
          :items="resolvedPlayerBarActions"
          :menu-items="overflowPlayerBarActions"
          :badges="playerBarBadgeControls"
        />
      </div>
    </footer>
  </div>

  <PlayerQueueDrawer v-model:open="isQueueDrawerOpen" />

  <AddToPlaylistDialog
    v-model:open="showAddToPlaylistDialog"
    :playbackQueues="addToPlaybackQueues"
    :playlists="createdPlaylists"
    :loading="isPlaylistLoading"
    @selectQueue="handleAddToQueue"
    @selectPlaylist="handleSelectPlaylist"
  />
</template>

<style scoped>
.player-song-info {
  will-change: transform;
}

.marquee-animation {
  animation: marquee 10s linear infinite;
}

@keyframes marquee {
  0%,
  12% {
    transform: translateX(0);
  }
  88%,
  100% {
    transform: translateX(calc(var(--marquee-distance, 0px) * -1));
  }
}

.player-bar {
  background: var(--color-bg-player);
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-elevated);
  transition:
    background-color 0.3s ease,
    border-color 0.3s ease;
}

.climax-mark-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.climax-tick {
  position: absolute;
  top: calc(50% - 3px);
  width: 2px;
  height: 6px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--color-primary) 80%, transparent);
}

:global(.dark) .climax-tick {
  background: color-mix(in srgb, var(--color-primary) 65%, transparent);
}

.player-actions {
  padding-right: 6px;
}

.player-bar-action-strip {
  --player-bar-action-size: 36px;
}

.player-bar-left-actions {
  --player-bar-action-size: 28px;
}

.playerbar-action-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--player-bar-action-size);
  height: var(--player-bar-action-size);
  flex: 0 0 var(--player-bar-action-size);
}

.playerbar-action-anchor.playerbar-left-action-anchor {
  width: 28px;
  height: 28px;
  flex-basis: 28px;
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

.player-bar-action-strip :deep(.player-toggle) {
  width: 38px;
  height: 38px;
  flex-basis: 38px;
}

.player-error-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--state-danger);
  opacity: 0.92;
  cursor: help;
  animation: player-error-pulse 1.8s ease-in-out 2;
}

:global(.dark) .player-error-indicator {
  color: #f87171;
}

@keyframes player-error-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.88;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}

.player-toggle {
  background-color: var(--control-muted-bg);
  border-color: transparent;
}

.player-toggle.is-loading {
  color: var(--color-primary-text);
}

.player-toggle-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 999px;
  animation: player-toggle-spin 0.8s linear infinite;
}

.player-step-busy {
  opacity: 0.75;
}

@keyframes player-toggle-spin {
  to {
    transform: rotate(360deg);
  }
}

:global(.dark) .player-toggle {
  background-color: var(--control-hover-bg);
  border-color: transparent;
  box-shadow: none;
}

.player-progress-track {
  background-color: var(--control-track-bg);
}

.player-progress-thumb {
  background: var(--control-thumb-bg);
  border-color: var(--control-border);
  box-shadow: var(--shadow-control);
}

.player-progress-thumb:focus-visible {
  box-shadow: none;
}
</style>

<style>
.player-error-popover.echo-popover-content {
  width: 220px;
  padding: 12px 14px;
  border-color: var(--border-subtle);
}

.player-error-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.player-error-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--state-danger);
}

.dark .player-error-title {
  color: #f87171;
}

.player-error-reason {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  line-height: 1.5;
}

.player-error-detail {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  line-height: 1.45;
}
</style>
