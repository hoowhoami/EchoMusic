<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import type { SongArtist } from '@/models/song';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import Cover from '@/components/ui/Cover.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
import DesktopLyricIcon from '@/components/ui/DesktopLyricIcon.vue';
import Dialog from '@/components/ui/Dialog.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
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
} from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';

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

const isHoveringProgress = ref(false);

const pendingSeekTime = ref<number | null>(null);
const isDraggingSeek = ref(false);

const progressValue = computed(() => {
  if (isDraggingSeek.value && pendingSeekTime.value !== null) {
    return [pendingSeekTime.value];
  }
  return [player.currentTime];
});

const handleSeek = (value: number[] | undefined) => {
  if (!value || value.length === 0) return;
  if (isDraggingSeek.value) {
    // 拖动中只更新视觉，不 seek
    pendingSeekTime.value = value[0];
  } else {
    // 点击直接 seek
    player.seek(value[0]);
  }
};

const handleSeekStart = () => {
  isDraggingSeek.value = true;
  player.notifySeekStart();
};

const handleSeekEnd = () => {
  if (pendingSeekTime.value !== null) {
    player.seek(pendingSeekTime.value);
    pendingSeekTime.value = null;
  }
  isDraggingSeek.value = false;
  player.notifySeekEnd();
};

const toggleFavoritePB = (e: Event) => {
  e.stopPropagation();
  toggleFavorite();
};

const updateDrawerWidth = () => {
  const content = document.querySelector('.view-port') as HTMLElement | null;
  const fallback = document.querySelector('.main-content') as HTMLElement | null;
  const target = content ?? fallback;
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

const checkMarquee = () => {
  if (!songInfoRef.value) return;
  const container = songInfoRef.value.parentElement;
  if (!container) return;
  const overflow = Math.max(0, songInfoRef.value.scrollWidth - container.clientWidth);
  const travelDistance = Math.min(overflow, MARQUEE_MAX_SCROLL_PX);
  isMarqueeActive.value = overflow > 8 && travelDistance > 8;
  marqueeDistance.value = `${travelDistance}px`;
};

watch(
  () => [currentTrack.value?.id, currentTrack.value?.title, currentTrack.value?.artist],
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
});
</script>

<template>
  <div class="player-bar-container w-full px-2 pb-[5px] z-[1000]">
    <footer
      class="player-bar w-full h-[84px] bg-bg-card border border-border-light/40 rounded-[12px] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] flex items-center justify-between px-3 py-1 gap-3 select-none no-drag transition-all duration-300"
    >
      <!-- 1. 左侧：歌曲信息 - 弹性增长 -->
      <div class="flex-1 flex items-center gap-3 min-w-[120px] max-w-[320px] overflow-hidden">
        <div
          class="relative w-[56px] h-[56px] shrink-0 cursor-pointer group rounded-[10px] overflow-hidden bg-black/[0.04] dark:bg-white/[0.04]"
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
              @mouseenter="checkMarquee"
            >
              <span
                class="text-[14px] font-bold text-text-main hover:text-primary cursor-pointer transition-colors"
                @click="navigateToLyric"
              >
                {{ currentTrack ? currentTrack.title : '未在播放' }}
              </span>
              <span v-if="currentTrack" class="text-[14px] text-text-main/60 mx-0.5">-</span>
              <div v-if="currentTrack" class="flex items-center">
                <template v-for="(artist, index) in artistList" :key="index">
                  <span
                    class="text-[13px] transition-colors"
                    :class="
                      isArtistClickable(artist)
                        ? 'text-text-main/60 hover:text-primary cursor-pointer'
                        : 'text-text-main/60'
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
              v-if="currentTrack?.mvHash"
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

            <Tooltip
              v-if="playbackNotice"
              side="top"
              align="start"
              :side-offset="10"
              contentClass="player-error-tooltip"
            >
              <template #trigger>
                <div class="player-error-indicator">
                  <Icon :icon="iconTriangleAlert" width="20" height="20" />
                </div>
              </template>
              <div class="player-error-tooltip-content">
                <div class="player-error-tooltip-title">{{ playbackNotice.title }}</div>
                <div class="player-error-tooltip-reason">{{ playbackNotice.reason }}</div>
                <div class="player-error-tooltip-detail">{{ playbackNotice.detail }}</div>
              </div>
            </Tooltip>
          </div>
        </div>
      </div>

      <!-- 2. 中间：播放控制 & 进度条 - 核心弹性区域 -->
      <div class="flex-[1.5] flex flex-col items-center justify-center gap-1 min-w-[150px]">
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
            class="player-toggle w-[38px] h-[38px] rounded-full bg-black/[0.04] flex items-center justify-center hover:scale-110 active:scale-95 transition-all border border-black/5"
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
        <div class="w-full max-w-[480px] flex items-center gap-3 px-1 h-[14px] min-w-0">
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
            class="relative flex items-center select-none touch-none flex-1 min-w-0 h-4 group/progress"
            @update:model-value="handleSeek"
            @pointerdown="handleSeekStart"
            @pointerup="handleSeekEnd"
            @pointercancel="handleSeekEnd"
            @mouseenter="isHoveringProgress = true"
            @mouseleave="isHoveringProgress = false"
          >
            <SliderTrack
              class="player-progress-track bg-black/[0.08] relative grow rounded-full h-[3px]"
            >
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
              class="player-progress-thumb block w-2.5 h-2.5 bg-white border border-black/10 rounded-full shadow-md focus-visible:outline-none transition-all duration-200"
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
        class="player-actions flex-1 flex justify-end items-center gap-1 min-w-[120px] max-w-[320px]"
      >
        <SpeedPopover />
        <QualityPopover />

        <Button
          variant="unstyled"
          size="none"
          class="p-2 transition-colors"
          :class="
            desktopLyricStore.settings.enabled
              ? 'text-primary'
              : 'text-text-main/50 hover:text-primary'
          "
          :title="desktopLyricStore.settings.enabled ? '关闭桌面歌词' : '开启桌面歌词'"
          @click="toggleDesktopLyric"
        >
          <DesktopLyricIcon :size="20" />
        </Button>

        <div class="relative">
          <Button
            variant="unstyled"
            size="none"
            class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
            title="播放队列"
            @click="openQueue"
          >
            <Icon :icon="iconList" width="22" height="22" />
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

  <Dialog
    v-model:open="showAddToPlaylistDialog"
    title="添加到"
    contentClass="max-w-[420px]"
    showClose
  >
    <div class="add-to-playlist-body">
      <div class="add-to-playlist-divider"><span>播放队列</span></div>
      <div v-if="addToPlaybackQueues.length === 0" class="add-to-playlist-status">暂无播放队列</div>
      <Button
        v-for="queue in addToPlaybackQueues"
        :key="queue.id"
        type="button"
        class="add-to-playlist-item add-to-playlist-queue"
        variant="ghost"
        size="sm"
        @click="handleAddToQueue(queue.id)"
      >
        <span class="add-to-playlist-name">
          <Icon :icon="iconList" width="16" height="16" />
          {{ queue.title || '播放队列' }}
        </span>
        <span class="add-to-playlist-count">{{ queue.songs.length }} 首</span>
      </Button>
      <div class="add-to-playlist-divider"><span>歌单</span></div>
      <div v-if="isPlaylistLoading" class="add-to-playlist-status">加载歌单中...</div>
      <div v-else-if="createdPlaylists.length === 0" class="add-to-playlist-status">
        暂无可用歌单
      </div>
      <Button
        v-for="entry in createdPlaylists"
        :key="entry.listid ?? entry.id"
        type="button"
        class="add-to-playlist-item"
        variant="ghost"
        size="sm"
        @click="handleSelectPlaylist(entry.listid ?? entry.id)"
      >
        <span class="add-to-playlist-name">{{ entry.name }}</span>
        <span class="add-to-playlist-count">{{ entry.count ?? 0 }} 首</span>
      </Button>
    </div>
  </Dialog>
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
  transition: background-color 0.3s ease;
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
  background: rgba(0, 113, 227, 0.8);
}

.dark .climax-tick {
  background: rgba(0, 113, 227, 0.65);
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
  color: #ef4444;
  opacity: 0.92;
  cursor: help;
  animation: player-error-pulse 1.8s ease-in-out 2;
}

.dark .player-error-indicator {
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
  color: #ef4444;
}

.dark .player-error-tooltip-title {
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
  background-color: rgba(0, 0, 0, 0.04);
  border-color: transparent;
}

.dark .player-toggle {
  background-color: rgba(245, 245, 247, 0.22);
  border-color: transparent;
  box-shadow: none;
}

.dark .player-progress-track {
  background-color: rgba(245, 245, 247, 0.4);
}

.player-progress-thumb:focus-visible {
  box-shadow: none;
}

.add-to-playlist-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-to-playlist-status {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-to-playlist-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
}

.add-to-playlist-count {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.add-to-playlist-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-main);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.add-to-playlist-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.add-to-playlist-queue {
  border-style: dashed;
}

.add-to-playlist-queue .add-to-playlist-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.add-to-playlist-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
</style>
