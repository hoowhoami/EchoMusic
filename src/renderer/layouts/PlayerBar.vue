<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { usePlayerStore, type AudioEffectValue, type AudioQualityValue } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { usePlaylistStore } from '@/stores/playlist';
import type { Song, SongArtist } from '@/models/song';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Cover from '@/components/ui/Cover.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Tag from '@/components/ui/Tag.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import AudioWaveIcon from '@/components/ui/AudioWaveIcon.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
} from 'reka-ui';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import {
  iconMusic,
  iconHeart,
  iconHeartFilled,
  iconCloud,
  iconTriangleAlert,
  iconMessageCircle,  iconRepeat,
  iconShuffle,
  iconListRestart,
  iconSkipBack,
  iconSkipForward,
  iconPlay,
  iconPause,
  iconVolume2,
  iconVolume1,
  iconVolumeX,
  iconList,
  iconSpeedometer,
  iconTypography,
} from '@/icons';
import { hasSongQuality, isSameSong, resolveEffectiveSongQuality } from '@/utils/song';

const router = useRouter();
const player = usePlayerStore();
const playlist = usePlaylistStore();
const settingStore = useSettingStore();

const currentTrack = computed(() => {
  return (
    player.currentTrackSnapshot ||
    playlist.defaultList.find((s: Song) => s.id === player.currentTrackId) ||
    playlist.favorites.find((s: Song) => s.id === player.currentTrackId)
  );
});

const isFavorite = computed(() => {
  return currentTrack.value
    ? playlist.favorites.some(
        (s) => isSameSong(s, currentTrack.value as Song) || s.id === currentTrack.value?.id,
      )
    : false;
});

const queueCount = computed(() => playlist.defaultList.length);
const playbackNotice = computed(() => player.playbackNotice);

const playbackRates = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

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
  const currentPath = router.currentRoute.value.fullPath;
  router.push({
    name: 'lyric',
    query: { from: currentPath },
  });
};

const resolveNumericId = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
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

const goToComments = () => {
  if (!currentTrack.value) return;
  const track = currentTrack.value;
  router.push({
    name: 'comment',
    params: { id: track.mixSongId ? String(track.mixSongId) : String(track.id) },
    query: {
      mainTab: 'detail',
      type: 'music',
      title: track.title,
      artist: track.artist,
      artistId: track.artists?.[0]?.id ?? '',
      album: track.album ?? '',
      cover: track.coverUrl ?? '',
      albumId: track.albumId ?? '',
      hash: track.hash ?? '',
      mixSongId: track.mixSongId ?? '',
    },
  });
};

const goToMv = async () => {
  const track = currentTrack.value;
  const mvHash = String(track?.mvHash ?? '').trim();
  if (!track || !mvHash) return;
  if (player.isPlaying) {
    await player.togglePlay();
  }
  router.push({
    name: 'mv-detail',
    params: { id: mvHash },
    query: {
      hash: mvHash,
      albumAudioId: track.mixSongId ?? track.id,
      title: track.title,
      artist: track.artist,
      cover: track.coverUrl ?? '',
      album: track.album ?? '',
      songId: track.id,
      mixSongId: track.mixSongId ?? '',
      from: router.currentRoute.value.fullPath,
    },
  });
};

const setPlaybackRate = (rate: number) => {
  if (player.playbackRate === rate) return;
  player.setPlaybackRate(rate);
};

const requestedAudioQuality = computed(() => player.getEffectiveAudioQuality(settingStore));
const effectiveAudioQuality = computed(() => {
  if (player.currentResolvedAudioQuality) return player.currentResolvedAudioQuality;
  if (!currentTrack.value) return requestedAudioQuality.value;
  return resolveEffectiveSongQuality(
    currentTrack.value,
    requestedAudioQuality.value,
    settingStore.compatibilityMode ?? true,
  );
});
const isAudioQualityDisabled = (quality: AudioQualityValue) => {
  if (quality === effectiveAudioQuality.value) return false;
  if (!currentTrack.value) return quality !== '128';
  return !hasSongQuality(currentTrack.value, quality);
};
const audioQualityButtonBadge = computed(() => {
  if (player.currentResolvedAudioEffect !== 'none') return 'FX';
  if (effectiveAudioQuality.value === '128') return 'SD';
  if (effectiveAudioQuality.value === '320') return 'HQ';
  if (effectiveAudioQuality.value === 'flac') return 'SQ';
  return 'HR';
});
const currentAudioQualityBadgeColor = computed(() =>
  player.currentResolvedAudioEffect !== 'none'
    ? '#10B981'
    : getAudioQualityTagColor(effectiveAudioQuality.value),
);

const getAudioQualityTagColor = (quality: AudioQualityValue) => {
  if (quality === '128') return '#64748B';
  if (quality === '320') return '#8B5CF6';
  if (quality === 'flac') return '#2563EB';
  return '#F59E0B';
};

const setAudioQuality = (quality: AudioQualityValue) => {
  if (player.currentAudioQualityOverride === null && effectiveAudioQuality.value === quality)
    return;
  if (player.currentAudioQualityOverride === quality) return;
  player.setCurrentAudioQualityOverride(quality);
};

const setAudioEffect = (effect: AudioEffectValue) => {
  if (player.audioEffect === effect) return;
  player.setAudioEffect(effect);
};

const openQueue = () => {
  isQueueDrawerOpen.value = true;
};

const toggleDesktopLyric = async () => {
  await settingStore.setDesktopLyricEnabled(!settingStore.desktopLyric.enabled);
};

const lastVolume = ref(0.8);
const isHoveringProgress = ref(false);
const isVolumeVisible = ref(false);
const volumeContainerRef = ref<HTMLElement | null>(null);
const isQueueDrawerOpen = ref(false);
const isQualityMenuOpen = ref(false);

watch(isQualityMenuOpen, (open) => {
  if (!open) return;
  if (!currentTrack.value) return;
  if ((currentTrack.value.relateGoods?.length ?? 0) > 0) return;
  void player.ensureTrackRelateGoods(currentTrack.value);
});

const handleSeek = (value: number[] | undefined) => {
  if (value && value.length > 0) {
    player.seek(value[0]);
  }
};

const handleSeekStart = () => {
  player.notifySeekStart();
};

const handleSeekEnd = () => {
  player.notifySeekEnd();
};

const toggleVolume = (e: Event) => {
  e.stopPropagation();
  isVolumeVisible.value = !isVolumeVisible.value;
};

const handleVolumeChange = (value: number[] | undefined) => {
  if (value && value.length > 0) {
    player.setVolume(value[0] / 100);
  }
};

const toggleMute = (e: Event) => {
  e.stopPropagation();
  if (player.volume > 0) {
    lastVolume.value = player.volume;
    player.setVolume(0);
  } else {
    player.setVolume(lastVolume.value || 0.8);
  }
};

const handleClickOutside = (e: MouseEvent) => {
  if (
    isVolumeVisible.value &&
    volumeContainerRef.value &&
    !volumeContainerRef.value.contains(e.target as Node)
  ) {
    isVolumeVisible.value = false;
  }
};

const toggleFavorite = (e: Event) => {
  e.stopPropagation();
  if (!currentTrack.value) return;
  if (isFavorite.value) {
    playlist.removeFavoriteSong(currentTrack.value);
  } else {
    playlist.addToFavorites(currentTrack.value);
  }
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
  window.addEventListener('click', handleClickOutside);
  window.addEventListener('resize', updateDrawerWidth);
  checkMarquee();
  updateDrawerWidth();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMarquee);
  window.removeEventListener('click', handleClickOutside);
  window.removeEventListener('resize', updateDrawerWidth);
});
</script>

<template>
  <div class="player-bar-container w-full px-2 pb-[5px] z-[1000]">
    <footer
      class="player-bar w-full h-[84px] bg-bg-card/80 backdrop-blur-md border border-border-light/40 rounded-[12px] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] flex items-center justify-between px-4 py-1 gap-8 select-none no-drag transition-all duration-300"
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
              @click="toggleFavorite"
              class="p-0.5 text-red-500 transition-all hover:scale-110 active:scale-90"
              title="收藏"
            >
              <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" />
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
          <Button
            variant="unstyled"
            size="none"
            @click="
              player.setPlayMode(
                player.playMode === 'list'
                  ? 'random'
                  : player.playMode === 'random'
                    ? 'single'
                    : 'list',
              )
            "
            class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
          >
            <Icon v-if="player.playMode === 'list'" :icon="iconRepeat" width="22" height="22" />
            <Icon
              v-else-if="player.playMode === 'random'"
              :icon="iconShuffle"
              width="22"
              height="22"
            />
            <Icon v-else :icon="iconListRestart" width="22" height="22" />
          </Button>

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

          <!-- 音量控制 - 点击弹出 -->
          <div ref="volumeContainerRef" class="relative flex items-center group/vol">
            <Button
              variant="unstyled"
              size="none"
              @click="toggleVolume"
              class="p-2 text-text-main/50 hover:text-primary transition-all hover:scale-110 active:scale-90"
              :class="{ 'text-primary': isVolumeVisible }"
            >
              <Icon v-if="player.volume > 0.5" :icon="iconVolume2" width="22" height="22" />
              <Icon v-else-if="player.volume > 0" :icon="iconVolume1" width="22" height="22" />
              <Icon v-else :icon="iconVolumeX" width="22" height="22" />
            </Button>

            <Transition name="volume-pop">
              <div
                v-show="isVolumeVisible"
                class="absolute bottom-[100%] left-1/2 -translate-x-1/2 pb-2"
                @click.stop
              >
                <div
                  class="relative bg-bg-card/95 backdrop-blur-md border border-border-light/40 p-3 rounded-2xl shadow-xl h-40 flex flex-col items-center"
                >
                  <SliderRoot
                    :model-value="[player.volume * 100]"
                    :max="100"
                    orientation="vertical"
                    class="relative flex flex-col items-center select-none touch-none w-5 h-full"
                    @update:model-value="handleVolumeChange"
                  >
                    <SliderTrack class="player-volume-track relative grow rounded-full w-[3px]">
                      <SliderRange class="absolute bg-primary rounded-full w-full" />
                    </SliderTrack>
                    <SliderThumb
                      class="player-volume-thumb block w-3 h-3 bg-white border border-black/10 rounded-full shadow-sm focus-visible:outline-none"
                    />
                  </SliderRoot>

                  <Button
                    variant="unstyled"
                    size="none"
                    @click="toggleMute"
                    class="mt-2 p-1 text-text-main/60 hover:text-primary transition-colors"
                  >
                    <Icon v-if="player.volume > 0.5" :icon="iconVolume2" width="20" height="20" />
                    <Icon
                      v-else-if="player.volume > 0"
                      :icon="iconVolume1"
                      width="20"
                      height="20"
                    />
                    <Icon v-else :icon="iconVolumeX" width="20" height="20" />
                  </Button>

                  <span class="mt-1 text-[10px] font-bold text-text-main/60 tabular-nums">{{
                    Math.round(player.volume * 100)
                  }}</span>

                  <!-- 三角箭头 -->
                  <div
                    class="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-bg-card/95 rotate-45 border-r border-b border-border-light/40"
                  ></div>
                </div>
              </div>
            </Transition>
          </div>
        </div>

        <!-- 进度条系统 - 动态伸缩至最大值 -->
        <div class="w-full max-w-[480px] flex items-center gap-3 px-1 h-[14px] min-w-0">
          <span
            class="text-[10px] font-medium text-text-main/50 w-9 shrink-0 text-right tabular-nums"
            >{{ formatTime(player.currentTime) }}</span
          >
          <SliderRoot
            :model-value="[player.currentTime]"
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
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <Button
              variant="unstyled"
              size="none"
              class="p-2 transition-colors"
              :class="
                player.playbackRate !== 1 ? 'text-primary' : 'text-text-main/50 hover:text-primary'
              "
              title="播放倍速"
            >
              <Icon :icon="iconSpeedometer" width="20" height="20" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              class="player-dropdown player-dropdown--narrow"
              align="center"
              side="top"
              :side-offset="4"
              :align-offset="0"
            >
              <div class="player-dropdown-title">播放倍速</div>
              <DropdownMenuItem
                v-for="rate in playbackRates"
                :key="rate"
                class="player-dropdown-item"
                :class="{ 'is-active': player.playbackRate === rate }"
                @select="setPlaybackRate(rate)"
              >
                <span>{{ rate.toFixed(2).replace(/\.00$/, '') }}x</span>
                <span
                  class="player-dropdown-check"
                  :class="{ 'is-visible': player.playbackRate === rate }"
                  >✓</span
                >
              </DropdownMenuItem>
              <div class="player-dropdown-arrow"></div>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <DropdownMenuRoot v-model:open="isQualityMenuOpen">
          <DropdownMenuTrigger as-child>
            <Button
              variant="unstyled"
              size="none"
              class="p-2 transition-colors"
              :class="
                player.currentAudioQualityOverride !== null || player.audioEffect !== 'none'
                  ? 'text-primary'
                  : 'text-text-main/50 hover:text-primary'
              "
              title="音质选项"
            >
              <span class="player-quality-button-inner">
                <AudioWaveIcon class="player-quality-icon" />
                <Badge
                  v-if="currentTrack"
                  :count="audioQualityButtonBadge"
                  class="player-quality-badge"
                  :style="{
                    right: '-12px',
                    color: '#FFFFFF',
                    backgroundColor: currentAudioQualityBadgeColor,
                  }"
                />
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              class="player-dropdown player-dropdown--narrow"
              align="center"
              side="top"
              :side-offset="4"
              :align-offset="0"
            >
              <div class="player-dropdown-title">音质选择</div>
              <DropdownMenuItem
                class="player-dropdown-item"
                :class="{
                  'is-active': effectiveAudioQuality === '128',
                  'is-disabled': isAudioQualityDisabled('128'),
                }"
                :disabled="isAudioQualityDisabled('128')"
                @select="setAudioQuality('128')"
              >
                <span class="player-dropdown-label">标准</span>
                <Tag class="player-dropdown-tag" :color="getAudioQualityTagColor('128')">SD</Tag>
                <span
                  class="player-dropdown-check"
                  :class="{ 'is-visible': effectiveAudioQuality === '128' }"
                  >✓</span
                >
              </DropdownMenuItem>
              <DropdownMenuItem
                class="player-dropdown-item"
                :class="{
                  'is-active': effectiveAudioQuality === '320',
                  'is-disabled': isAudioQualityDisabled('320'),
                }"
                :disabled="isAudioQualityDisabled('320')"
                @select="setAudioQuality('320')"
              >
                <span class="player-dropdown-label">高品质</span>
                <Tag class="player-dropdown-tag" :color="getAudioQualityTagColor('320')">HQ</Tag>
                <span
                  class="player-dropdown-check"
                  :class="{ 'is-visible': effectiveAudioQuality === '320' }"
                  >✓</span
                >
              </DropdownMenuItem>
              <DropdownMenuItem
                class="player-dropdown-item"
                :class="{
                  'is-active': effectiveAudioQuality === 'flac',
                  'is-disabled': isAudioQualityDisabled('flac'),
                }"
                :disabled="isAudioQualityDisabled('flac')"
                @select="setAudioQuality('flac')"
              >
                <span class="player-dropdown-label">无损</span>
                <Tag class="player-dropdown-tag" :color="getAudioQualityTagColor('flac')">SQ</Tag>
                <span
                  class="player-dropdown-check"
                  :class="{ 'is-visible': effectiveAudioQuality === 'flac' }"
                  >✓</span
                >
              </DropdownMenuItem>
              <DropdownMenuItem
                class="player-dropdown-item"
                :class="{
                  'is-active': effectiveAudioQuality === 'high',
                  'is-disabled': isAudioQualityDisabled('high'),
                }"
                :disabled="isAudioQualityDisabled('high')"
                @select="setAudioQuality('high')"
              >
                <span class="player-dropdown-label">Hi-Res</span>
                <Tag class="player-dropdown-tag" :color="getAudioQualityTagColor('high')">HR</Tag>
                <span
                  class="player-dropdown-check"
                  :class="{ 'is-visible': effectiveAudioQuality === 'high' }"
                  >✓</span
                >
              </DropdownMenuItem>
              <div class="player-dropdown-divider"></div>
              <div class="player-dropdown-title">音效</div>
              <div class="player-dropdown-scroll">
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'none' }"
                  @select="setAudioEffect('none')"
                >
                  <span>原声</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'none' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'piano' }"
                  @select="setAudioEffect('piano')"
                >
                  <span>钢琴</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'piano' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'acappella' }"
                  @select="setAudioEffect('acappella')"
                >
                  <span>清唱</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'acappella' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'subwoofer' }"
                  @select="setAudioEffect('subwoofer')"
                >
                  <span>重低音</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'subwoofer' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'ancient' }"
                  @select="setAudioEffect('ancient')"
                >
                  <span>古风</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'ancient' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'surnay' }"
                  @select="setAudioEffect('surnay')"
                >
                  <span>唢呐</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'surnay' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'dj' }"
                  @select="setAudioEffect('dj')"
                >
                  <span>DJ</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'dj' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'viper_tape' }"
                  @select="setAudioEffect('viper_tape')"
                >
                  <span>蝰蛇母带</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'viper_tape' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'viper_atmos' }"
                  @select="setAudioEffect('viper_atmos')"
                >
                  <span>蝰蛇全景声</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'viper_atmos' }"
                    >✓</span
                  >
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="player-dropdown-item"
                  :class="{ 'is-active': player.audioEffect === 'viper_clear' }"
                  @select="setAudioEffect('viper_clear')"
                >
                  <span>蝰蛇超清</span>
                  <span
                    class="player-dropdown-check"
                    :class="{ 'is-visible': player.audioEffect === 'viper_clear' }"
                    >✓</span
                  >
                </DropdownMenuItem>
              </div>
              <div class="player-dropdown-arrow"></div>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <Button
          variant="unstyled"
          size="none"
          class="p-2 transition-colors"
          :class="
            settingStore.desktopLyric.enabled
              ? 'text-primary'
              : 'text-text-main/50 hover:text-primary'
          "
          :title="settingStore.desktopLyric.enabled ? '关闭桌面歌词' : '开启桌面歌词'"
          @click="toggleDesktopLyric"
        >
          <Icon :icon="iconTypography" width="20" height="20" />
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

.volume-pop-enter-active,
.volume-pop-leave-active {
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.volume-pop-enter-from,
.volume-pop-leave-to {
  opacity: 0;
  transform: translateY(14px) scale(0.92);
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

.player-volume-track {
  background-color: rgba(29, 29, 31, 0.2);
}

.dark .player-volume-track {
  background-color: rgba(245, 245, 247, 0.08);
}

.player-volume-thumb:focus-visible,
.player-progress-thumb:focus-visible {
  box-shadow: none;
}

:deep(.player-dropdown) {
  min-width: 168px;
  padding: 8px 0 8px 8px;
  will-change: transform, opacity;
  border-radius: 12px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-light);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 1200;
  position: relative;
}

:deep(.player-dropdown--narrow) {
  min-width: 136px;
}

:deep(.player-dropdown-title) {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary);
  padding: 2px 8px 6px 6px;
}

:deep(.player-dropdown-subtitle) {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding: 0 8px 6px 6px;
}

.player-quality-button-inner {
  position: relative;
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
}

.player-quality-icon {
  display: block;
  width: 20px;
  height: 20px;
  transform: translateY(3px);
}

.player-quality-badge {
  top: -0.5rem;
}

:deep(.player-dropdown-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  margin-right: 8px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    opacity 0.18s ease;
}

:deep(.player-dropdown-item.is-disabled),
:deep(.player-dropdown-item[data-disabled]) {
  opacity: 0.42;
  cursor: not-allowed;
  color: var(--color-text-secondary);
}

:deep(.player-dropdown-item.is-disabled:hover),
:deep(.player-dropdown-item[data-disabled]:hover) {
  background-color: transparent;
  color: var(--color-text-secondary);
}

:deep(.player-dropdown-meta) {
  margin-left: auto;
  margin-right: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

:deep(.player-dropdown-label) {
  min-width: 0;
  flex: 1;
}

:deep(.player-dropdown-tag) {
  margin-left: 4px;
  margin-right: 6px;
  min-width: 22px;
  justify-content: center;
}

.dark :deep(.player-dropdown-tag) {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

:deep(.player-dropdown-item.is-disabled) .player-dropdown-tag,
:deep(.player-dropdown-item[data-disabled]) .player-dropdown-tag {
  color: var(--color-text-secondary);
  border-color: color-mix(in srgb, var(--color-text-secondary) 26%, transparent);
  background-color: color-mix(in srgb, var(--color-text-secondary) 10%, transparent);
  box-shadow: none;
}

.dark :deep(.player-dropdown-item.is-disabled .player-dropdown-tag),
.dark :deep(.player-dropdown-item[data-disabled] .player-dropdown-tag) {
  color: color-mix(in srgb, var(--color-text-secondary) 88%, white 12%);
  border-color: color-mix(in srgb, var(--color-text-secondary) 30%, transparent);
  background-color: color-mix(in srgb, var(--color-text-secondary) 14%, transparent);
}

:deep(.player-dropdown-scroll .player-dropdown-item) {
  margin-right: 4px;
}

:deep(.player-dropdown-item.is-active) {
  background-color: rgba(0, 113, 227, 0.12);
  color: var(--color-primary);
}

.dark :deep(.player-dropdown-item.is-active) {
  background-color: rgba(0, 113, 227, 0.2);
}

:deep(.player-dropdown-item:hover) {
  background-color: rgba(0, 0, 0, 0.05);
  color: var(--color-primary);
}

.dark :deep(.player-dropdown-item:hover) {
  background-color: rgba(255, 255, 255, 0.08);
}

:deep(.player-dropdown-check) {
  width: 14px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  color: var(--color-primary);
  opacity: 0;
}

:deep(.player-dropdown-check.is-visible) {
  opacity: 1;
}

:deep(.player-dropdown-divider) {
  height: 1px;
  margin: 4px 8px 4px 6px;
  background-color: var(--color-border-light);
}

:deep(.player-dropdown-scroll) {
  max-height: 168px;
  overflow-y: auto;
  padding-right: 1px;
}

:deep(.player-dropdown-arrow) {
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 10px;
  height: 10px;
  background: var(--color-bg-card);
  border-right: 1px solid var(--color-border-light);
  border-bottom: 1px solid var(--color-border-light);
  transform: translateX(-50%) rotate(45deg);
  pointer-events: none;
  z-index: -1;
}
</style>
