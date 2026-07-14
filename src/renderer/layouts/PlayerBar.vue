<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import type { SongArtist } from '@/models/song';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import Cover from '@/components/ui/Cover.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { useDeferredSeek } from '@/composables/useDeferredSeek';
import Popover from '@/components/ui/Popover.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
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
} from '@/icons';
import { usePlayerControls } from '@/composables/usePlayerControls';

const router = useRouter();

const {
  player,
  settingStore,
  desktopLyricStore,
  currentTrack,
  isFavorite,
  toggleFavorite,
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
  const artistId = resolveNumericId(artist.id);
  if (!artistId) return false;
  const routeId = Array.isArray(router.currentRoute.value.params.id)
    ? router.currentRoute.value.params.id[0]
    : router.currentRoute.value.params.id;
  return !(
    router.currentRoute.value.name === 'artist-detail' && String(routeId) === String(artistId)
  );
};

const goToArtist = (artist: SongArtist) => {
  const artistId = resolveNumericId(artist.id);
  if (!artistId || !isArtistClickable(artist)) return;
  router.push({ name: 'artist-detail', params: { id: String(artistId) } });
};

const currentAlbumName = computed(() =>
  String(currentTrack.value?.album ?? currentTrack.value?.albumName ?? '').trim(),
);

const currentAlbumId = computed(() => resolveNumericId(currentTrack.value?.albumId));

const isCurrentAlbumClickable = computed(() => {
  const albumId = currentAlbumId.value;
  if (!albumId || !currentAlbumName.value) return false;
  const routeId = Array.isArray(router.currentRoute.value.params.id)
    ? router.currentRoute.value.params.id[0]
    : router.currentRoute.value.params.id;
  return !(
    router.currentRoute.value.name === 'album-detail' && String(routeId) === String(albumId)
  );
});

const goToCurrentAlbum = () => {
  const albumId = currentAlbumId.value;
  if (!albumId || !isCurrentAlbumClickable.value) {
    navigateToLyric();
    return;
  }
  router.push({ name: 'album-detail', params: { id: String(albumId) } });
};

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
  getCurrentTime: () => player.currentTime,
  seek: (time) => player.seek(time),
});

const toggleFavoritePB = (e: Event) => {
  e.stopPropagation();
  toggleFavorite();
};

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
  checkMarquee();
  updateDrawerWidth();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMarquee);
  window.removeEventListener('resize', updateDrawerWidth);
  stopMarquee();
});
</script>

<template>
  <div class="player-bar-container w-full px-2 pb-1.25 z-1000">
    <footer
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
              <span
                class="text-[14px] font-bold text-primary cursor-pointer transition-colors"
                :class="{ 'hover:text-primary/80': isCurrentAlbumClickable }"
                :title="isCurrentAlbumClickable ? '查看专辑' : '打开歌词'"
                @click="goToCurrentAlbum"
              >
                {{ currentTrack ? currentTrack.name : '未在播放' }}
              </span>
              <span v-if="currentTrack" class="text-[14px] text-primary/60 mx-0.5">-</span>
              <div v-if="currentTrack" class="flex items-center">
                <template v-for="(artist, index) in artistList" :key="index">
                  <span
                    class="text-[13px] transition-colors"
                    :class="
                      isArtistClickable(artist)
                        ? 'text-primary/70 hover:text-primary cursor-pointer'
                        : 'text-primary/70'
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

          <div class="flex items-center gap-2.5 mt-1.5 h-6">
            <Button
              variant="unstyled"
              size="none"
              @click="toggleFavoritePB"
              class="p-0.5 text-red-500 transition-all hover:scale-110 active:scale-90"
              title="收藏"
            >
              <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" />
            </Button>

            <Button
              v-if="canAddToPlaylist"
              variant="unstyled"
              size="none"
              @click="handleOpenAddToPlaylist"
              class="p-0.5 text-text-main/25 hover:text-primary transition-all hover:scale-110"
              title="添加到"
            >
              <Icon :icon="iconPlaylistAdd" width="20" height="20" />
            </Button>

            <Button
              variant="unstyled"
              size="none"
              @click="goToComments"
              class="p-0.5 text-text-main/25 hover:text-primary transition-all hover:scale-110"
              title="详情及评论"
            >
              <Icon :icon="iconMessageCircle" width="20" height="20" />
            </Button>

            <Button
              v-if="hasCurrentTrackMv"
              variant="unstyled"
              size="none"
              @click="goToMv"
              class="p-0.5 text-text-main/25 hover:text-primary transition-all hover:scale-110"
              title="播放 MV"
            >
              <MvIcon class="w-5 h-5" />
            </Button>

            <div v-if="currentTrack?.source === 'cloud'" class="text-primary/60" title="云盘歌曲">
              <Icon :icon="iconCloud" width="20" height="20" />
            </div>

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
      <div class="flex-[1.5] flex flex-col items-center justify-center gap-1 min-w-37.5">
        <div class="flex items-center justify-center gap-4 h-10">
          <!-- 播放模式 -->
          <Tooltip
            :content="
              player.playMode === 'sequential'
                ? '顺序播放'
                : player.playMode === 'list'
                  ? '列表循环'
                  : player.playMode === 'random'
                    ? '随机播放'
                    : '单曲循环'
            "
            side="top"
          >
            <template #trigger>
              <Button
                variant="unstyled"
                size="none"
                @click="
                  player.setPlayMode(
                    player.playMode === 'sequential'
                      ? 'list'
                      : player.playMode === 'list'
                        ? 'random'
                        : player.playMode === 'random'
                          ? 'single'
                          : 'sequential',
                  )
                "
                class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
              >
                <Icon
                  v-if="player.playMode === 'sequential'"
                  :icon="iconRepeatOff"
                  width="22"
                  height="22"
                />
                <Icon
                  v-else-if="player.playMode === 'list'"
                  :icon="iconRepeat"
                  width="22"
                  height="22"
                />
                <Icon
                  v-else-if="player.playMode === 'random'"
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
            @click="player.prev"
            class="p-2 text-text-main/60 hover:text-primary transition-all hover:scale-110 active:scale-90"
          >
            <Icon :icon="iconSkipBack" width="22" height="22" />
          </Button>

          <Button
            variant="unstyled"
            size="none"
            @click="player.togglePlay"
            class="player-toggle w-9.5 h-9.5 rounded-full flex items-center justify-center hover:scale-110 hover:text-primary active:scale-95 transition-all border"
          >
            <Icon v-if="!player.isPlaying" :icon="iconPlay" width="16" height="16" class="ml-0.5" />
            <Icon v-else :icon="iconPause" width="20" height="20" />
          </Button>

          <Button
            variant="unstyled"
            size="none"
            @click="player.next"
            class="p-2 text-text-main/60 hover:text-primary transition-all hover:scale-110 active:scale-90"
          >
            <Icon :icon="iconSkipForward" width="22" height="22" />
          </Button>

          <!-- 音量控制 -->
          <VolumePopover variant="bar" />
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
              <SliderRange class="absolute bg-primary rounded-full h-full" />
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
      <div class="player-actions flex-1 flex justify-end items-center gap-1 min-w-30 max-w-[320px]">
        <Button
          v-if="canShareCurrentTrack"
          variant="unstyled"
          size="none"
          class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
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
            class="p-2 transition-all hover:scale-110 active:scale-90"
            :class="
              desktopLyricStore.settings.enabled
                ? 'text-primary'
                : 'text-text-main/50 hover:text-primary'
            "
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
            class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
            title="播放队列"
            @click="openQueue"
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

:global(.player-error-tooltip) {
  max-width: 280px;
  z-index: 1400 !important;
}

.player-error-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.player-error-tooltip-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--state-danger);
}

:global(.dark) .player-error-tooltip-title {
  color: #f87171;
}

.player-error-tooltip-reason {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  line-height: 1.5;
}

.player-error-tooltip-detail {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  line-height: 1.45;
}

.player-toggle {
  background-color: var(--control-muted-bg);
  border-color: transparent;
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
  background: var(--color-bg-elevated);
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
