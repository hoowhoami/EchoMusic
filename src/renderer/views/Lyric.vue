<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRafFn, useClipboard, useThrottleFn } from '@vueuse/core';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Popover from '@/components/ui/Popover.vue';
import Cover from '@/components/ui/Cover.vue';
import Slider from '@/components/ui/Slider.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import CommentDrawer from '@/components/music/CommentDrawer.vue';
import { formatDuration } from '@/utils/format';
import { getCoverUrl } from '@/utils/cover';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import Badge from '@/components/ui/Badge.vue';
import Switch from '@/components/ui/Switch.vue';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import {
  iconChevronDown,
  iconChevronLeft,
  iconChevronRight,
  iconCopy,
  iconImage,
  iconLanguage,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconHeart,
  iconHeartFilled,
  iconList,
  iconPlaylistAdd,
  iconTriangleAlert,
  iconTypography,
  iconMessageCircle,
} from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';
import { useLyricColorPicker } from '@/utils/useLyricColorPicker';
import { useLyricPortrait } from '@/utils/useLyricPortrait';
import { useLyricLuminance } from '@/utils/useLyricLuminance';
import { useLyricCollapse } from '@/utils/useLyricCollapse';
import FontIcon from '@/components/ui/FontIcon.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';

const lyricStore = useLyricStore();
const toastStore = useToastStore();
const { copy } = useClipboard();

const {
  player: playerStore,
  settingStore,
  desktopLyricStore,
  currentTrack,
  isFavorite,
  toggleFavorite,
  playModeLabel,
  playModeIcon,
  cyclePlayMode,
  toggleDesktopLyric,
  queueCount,
  isQueueDrawerOpen,
  showAddToPlaylistDialog,
  isPlaylistLoading,
  canAddToPlaylist,
  createdPlaylists,
  addToPlaybackQueues,
  handleOpenAddToPlaylist,
  handleAddToQueue,
  handleSelectPlaylist,
} = usePlayerControls();

const currentTrackLyricHash = computed(() =>
  String(currentTrack.value?.hash ?? currentTrack.value?.id ?? '').trim(),
);

// 写真模式
const {
  artistPortraitUrls,
  activePortraitUrl,
  hasPortraitGallery,
  portraitCounterLabel,
  showPreviousPortrait,
  showNextPortrait,
  ensureArtistBackdropForCurrentTrack,
  startPortraitCarousel,
  stopPortraitCarousel,
  dispose: disposePortrait,
} = useLyricPortrait({ currentTrack, currentTrackLyricHash, settingStore });

const lyricListRef = ref<HTMLElement | null>(null);
const progressValue = ref(0);
const isProgressDragging = ref(false);
const isHoveringProgress = ref(false);
const isUserScrollingLyrics = ref(false);
const isCommentDrawerOpen = ref(false);
let userScrollResumeTimer: number | null = null;

const coverBackgroundUrl = computed(() => getCoverUrl(currentTrack.value?.coverUrl, 900));
const backdropOpacityStyle = computed(() => ({
  opacity: settingStore.lyricBackdropOpacity / 100,
}));
const backdropOpacityLabel = computed(() => `${settingStore.lyricBackdropOpacity}%`);
const currentIndex = computed(() => lyricStore.currentIndex);
const hasLyrics = computed(() => lyricStore.lines.length > 0);
const hasActiveTrack = computed(() => Boolean(currentTrack.value));
const displayLabel = computed(() => {
  return lyricStore.currentDisplayLabel;
});
const emptyStateTitle = computed(() => {
  if (!hasActiveTrack.value) return '未在播放';
  if (lyricStore.isLoading) return '歌词加载中…';
  return '暂无歌词';
});
const titleFontSize = computed(() => `${1.5 * lyricStore.fontScale}rem !important`);
const secondaryFontSize = computed(() => `${1.2 * lyricStore.fontScale}rem !important`);
const romanizationFontSize = computed(() => `${1.2 * lyricStore.fontScale}rem !important`);
const fontWeightLabel = computed(() => `W${lyricStore.fontWeightValue}`);
const fontSizeLabel = computed(() => `${Math.round(lyricStore.fontScale * 100)}%`);
const lyricFontFamily = computed(() => settingStore.buildLyricFontFamily());

const lyricColorPicker = useLyricColorPicker();

const effectivePlayedColor = computed(() => lyricStore.effectivePlayedColor);
const effectiveUnplayedColor = computed(() => lyricStore.effectiveUnplayedColor);

const clearUserScrollResumeTimer = () => {
  if (userScrollResumeTimer === null) return;
  window.clearTimeout(userScrollResumeTimer);
  userScrollResumeTimer = null;
};

const scheduleResumeFollowScroll = () => {
  clearUserScrollResumeTimer();
  userScrollResumeTimer = window.setTimeout(() => {
    userScrollResumeTimer = null;
    isUserScrollingLyrics.value = false;
    scrollToCurrentLine(true);
  }, 5000);
};

const handleLyricWheel = () => {
  if (!hasLyrics.value) return;
  isUserScrollingLyrics.value = true;
  scheduleResumeFollowScroll();
};

const scrollToCurrentLine = (smooth: boolean) => {
  const container = lyricListRef.value;
  let index = lyricStore.currentIndex;
  // 收缩状态下即使未播放（index < 0），也需要滚动到下方位置，使用第一行作为锚点
  if (index < 0 && isLyricCollapsed.value) index = 0;
  if (!container || index < 0 || isUserScrollingLyrics.value) return;

  const target = container.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
  if (!target) return;

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  if (isLyricCollapsed.value) {
    // 收缩时：将当前行和下一行都显示在容器底部
    const nextTarget = container.querySelector<HTMLElement>(`[data-lyric-index="${index + 1}"]`);
    // 计算两行的总高度（如果有下一行的话）
    const twoLineHeight = nextTarget
      ? nextTarget.getBoundingClientRect().bottom - targetRect.top
      : targetRect.height;
    const bottomMargin = 24;
    const offset =
      targetRect.top -
      containerRect.top +
      container.scrollTop -
      container.clientHeight +
      twoLineHeight +
      bottomMargin;
    container.scrollTo({ top: Math.max(0, offset), behavior: smooth ? 'smooth' : 'auto' });
    return;
  }

  const anchorRatio = 0.5;
  const offset =
    targetRect.top -
    containerRect.top +
    container.scrollTop -
    container.clientHeight * anchorRatio +
    targetRect.height / 2;
  container.scrollTo({ top: Math.max(0, offset), behavior: smooth ? 'smooth' : 'auto' });
};

const handleProgressInput = (value: number[] | undefined) => {
  if (!value?.length) return;
  if (!isProgressDragging.value) {
    isProgressDragging.value = true;
    playerStore.notifySeekStart();
  }
  progressValue.value = value[0];
};

const handleProgressCommit = (value: number[] | undefined) => {
  if (!value?.length) return;
  playerStore.notifySeekEnd();
  isProgressDragging.value = false;
  playerStore.seek(value[0]);
};

const handleProgressPointerDown = () => {
  isProgressDragging.value = true;
  playerStore.notifySeekStart();
};

const copyLyrics = async () => {
  const text = lyricStore.copyableText.trim();
  if (!text) return;

  await copy(text);
  toastStore.success('歌词已复制');
};

const copySongInfo = async () => {
  const track = currentTrack.value;
  if (!track) return;
  const parts = [track.title, track.artist, track.album].filter(Boolean);
  const text = parts.join(' - ');
  if (!text) return;

  await copy(text);
  toastStore.success('歌曲信息已复制');
};

const handleLyricLineClick = (time: number) => {
  playerStore.seek(time);
};

const handleTranslationToggle = (enabled: boolean) => {
  lyricStore.wantTranslation = enabled;
};

const handleRomanizationToggle = (enabled: boolean) => {
  lyricStore.wantRomanization = enabled;
};

const ensureLyricsForCurrentTrack = () => {
  const track = currentTrack.value;
  if (!track) return;

  const lyricHash = currentTrackLyricHash.value;
  if (!lyricHash) {
    if (!hasLyrics.value) lyricStore.clear('', '暂无歌词');
    return;
  }

  if (lyricStore.loadedHash !== lyricHash) {
    if (track.lyric) {
      lyricStore.setLyric(track.lyric, lyricHash);
    } else if (!hasLyrics.value) {
      lyricStore.clear(lyricHash, '歌词加载中...');
    }
  }

  void lyricStore.fetchLyrics(lyricHash, {
    preserveCurrent: Boolean(track.lyric),
  });
};

// 亮度检测
const { portraitImgRef, onPortraitImageLoad } = useLyricLuminance({
  hasPortraitGallery,
  settingStore,
});

watch(
  () => lyricStore.currentIndex,
  async (index, previous) => {
    if (index === previous) return;
    await nextTick();
    scrollToCurrentLine(previous !== -1);
  },
);

watch(
  () => playerStore.currentTime,
  (value) => {
    if (isProgressDragging.value) return;
    progressValue.value = value;
    // 歌词行索引更新已移至 RAF 中驱动，这里只同步进度条
  },
  { immediate: true },
);

watch(
  () => [currentTrack.value?.id, playerStore.isPlaying],
  async ([id]) => {
    ensureLyricsForCurrentTrack();
    void ensureArtistBackdropForCurrentTrack();
    if (id) {
      isUserScrollingLyrics.value = false;
      clearUserScrollResumeTimer();
      await nextTick();
      scrollToCurrentLine(false);
    }
  },
  { immediate: true },
);

watch(
  () => settingStore.lyricArtistBackdrop,
  (enabled) => {
    void ensureArtistBackdropForCurrentTrack();
    if (!enabled) stopPortraitCarousel();
  },
  { immediate: true },
);

watch(
  () => [settingStore.lyricCarouselEnabled, settingStore.lyricCarouselInterval],
  () => {
    if (settingStore.lyricCarouselEnabled && hasPortraitGallery.value) {
      startPortraitCarousel();
    } else {
      stopPortraitCarousel();
    }
  },
);

watch(
  () => lyricStore.lyricsMode,
  async () => {
    await nextTick();
    scrollToCurrentLine(false);
  },
);

// 歌词自动收起
const {
  isLyricCollapsed,
  wasCollapsed,
  scheduleCollapse,
  handleUserActivity,
  dispose: disposeCollapse,
} = useLyricCollapse({ hasPortraitGallery, settingStore, scrollToCurrentLine });

const handleLyricViewMouseMove = useThrottleFn(() => {
  handleUserActivity();
}, 200);

const closeLyricPage = () => {
  playerStore.toggleLyricView(false);
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void closeLyricPage();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
    if (!hasLyrics.value) return;
    event.preventDefault();
    void copyLyrics();
  }
};

// ── 逐字歌词实时进度（毫秒） ──
const LYRIC_LOOKAHEAD = 150;
const playSeekMs = ref(0);
let seekBaseMs = 0;
let seekAnchorTick = 0;

const { pause: pauseSeekRaf, resume: resumeSeekRaf } = useRafFn(
  () => {
    if (playerStore.isPlaying) {
      playSeekMs.value = seekBaseMs + (performance.now() - seekAnchorTick);
    }
    // 用 RAF 插值时间驱动歌词行索引更新
    if (!isProgressDragging.value) {
      lyricStore.updateCurrentIndex(playSeekMs.value / 1000, true);
    }
  },
  { immediate: false },
);

const syncSeekAnchor = () => {
  seekBaseMs = Math.round((playerStore.currentTime || 0) * 1000);
  seekAnchorTick = performance.now();
  playSeekMs.value = seekBaseMs;
};

// 已播/未播颜色（用于逐字渐变）
const yrcPlayedColor = computed(() => effectivePlayedColor.value);
const yrcUnplayedColor = computed(() => effectiveUnplayedColor.value);

const getYrcStyle = (char: { startTime: number; endTime: number }, lineIndex: number) => {
  const line = lyricStore.lines[lineIndex];
  if (!line?.characters?.length) return { backgroundPositionX: '100%' };
  const seekMs = playSeekMs.value + LYRIC_LOOKAHEAD;
  const lineStart = line.characters[0].startTime;
  const lineEnd = line.characters[line.characters.length - 1].endTime;
  const isLineActive =
    (seekMs >= lineStart && seekMs < lineEnd) || currentIndex.value === lineIndex;
  if (!isLineActive) {
    return { backgroundPositionX: seekMs >= (char.endTime || 0) ? '0%' : '100%' };
  }
  const duration = Math.max((char.endTime || 0) - (char.startTime || 0), 0.001);
  const progress = Math.max(Math.min((seekMs - (char.startTime || 0)) / duration, 1), 0);
  return { backgroundPositionX: `${100 - progress * 100}%` };
};

const isYrcLine = (line: { characters: unknown[] }) => (line.characters?.length ?? 0) > 1;

watch(
  () => playerStore.currentTime,
  () => syncSeekAnchor(),
);

watch(
  () => playerStore.isPlaying,
  (playing) => {
    syncSeekAnchor();
    if (playing) resumeSeekRaf();
    else pauseSeekRaf();
  },
);

onMounted(() => {
  syncSeekAnchor();
  if (playerStore.isPlaying) resumeSeekRaf();
  else pauseSeekRaf();
  ensureLyricsForCurrentTrack();
  void ensureArtistBackdropForCurrentTrack();
  void nextTick(() => scrollToCurrentLine(false));
  window.addEventListener('keydown', handleKeydown);
  if (hasPortraitGallery.value) scheduleCollapse();
});

onUnmounted(() => {
  pauseSeekRaf();
  disposePortrait();
  disposeCollapse();
  clearUserScrollResumeTimer();
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div
    class="lyric-view fixed inset-0 z-2000 h-screen w-screen overflow-hidden bg-[#eef2f7] text-black select-none transition-colors duration-500 dark:bg-[#030406] dark:text-white"
    :class="{
      'portrait-mode': hasPortraitGallery,
    }"
    @mousemove="handleLyricViewMouseMove"
    @click="handleUserActivity"
    @wheel.passive="handleUserActivity"
  >
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        v-if="hasPortraitGallery"
        class="lyric-portrait-backdrop-wrap absolute inset-0"
        :style="backdropOpacityStyle"
      >
        <img
          ref="portraitImgRef"
          :src="activePortraitUrl"
          :alt="`${currentTrack?.artist || '歌手'}写真`"
          class="lyric-portrait-backdrop"
          @load="onPortraitImageLoad"
        />
      </div>
      <div
        v-else
        class="lyric-ambient-photo absolute inset-[-20px] bg-cover bg-center transition-all duration-500"
        :style="{ backgroundImage: coverBackgroundUrl ? `url(${coverBackgroundUrl})` : undefined }"
      ></div>
      <div v-if="!hasPortraitGallery" class="lyric-atmosphere absolute inset-0"></div>
      <div
        v-if="hasPortraitGallery"
        class="lyric-portrait-overlay absolute inset-0 transition-colors duration-500"
      ></div>
      <div
        v-if="!hasPortraitGallery"
        class="absolute inset-0 bg-[#04070b]/40 transition-colors duration-500 dark:bg-[#04070b]/50"
      ></div>
    </div>

    <OverlayHeader />

    <div class="absolute inset-x-0 bottom-0 top-14 z-10 flex flex-col overflow-hidden">
      <div
        class="px-6 pb-3 no-drag transition-opacity duration-500"
        :style="{
          opacity: isLyricCollapsed ? 0 : 1,
          pointerEvents: isLyricCollapsed ? 'none' : undefined,
        }"
      >
        <div class="flex h-12 items-center">
          <Button
            variant="unstyled"
            size="none"
            type="button"
            class="lyric-icon-btn"
            title="返回"
            @click="closeLyricPage"
          >
            <Icon :icon="iconChevronDown" width="22" height="22" />
          </Button>

          <div class="ml-auto flex items-center gap-2">
            <div
              v-if="hasPortraitGallery && artistPortraitUrls.length > 1"
              class="lyric-tool-group"
              title="切换歌手写真"
            >
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="lyric-tool-chip-main"
                @click="showPreviousPortrait"
              >
                <Icon :icon="iconChevronLeft" width="14" height="14" />
              </Button>
              <div class="lyric-photo-chip">
                <span>{{ portraitCounterLabel }}</span>
              </div>
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="lyric-tool-chip-main"
                @click="showNextPortrait"
              >
                <Icon :icon="iconChevronRight" width="14" height="14" />
              </Button>
            </div>
            <Popover
              v-if="hasPortraitGallery"
              trigger="hover"
              align="end"
              :side-offset="8"
              content-class="lyric-popover w-[240px] p-4"
            >
              <template #trigger>
                <Button
                  variant="unstyled"
                  size="none"
                  type="button"
                  class="lyric-tool-chip"
                  title="背景透明度"
                >
                  <Icon :icon="iconImage" width="14" height="14" />
                  <span>{{ backdropOpacityLabel }}</span>
                </Button>
              </template>
              <div class="flex flex-col gap-2 text-black dark:text-white">
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">背景透明度</span>
                  <span class="font-mono">{{ backdropOpacityLabel }}</span>
                </div>
                <Slider
                  :model-value="settingStore.lyricBackdropOpacity"
                  :min="10"
                  :max="100"
                  :step="5"
                  @update:model-value="(v) => (settingStore.lyricBackdropOpacity = v)"
                  class="lyric-popover-slider h-1 w-full"
                  track-class="bg-black/15 dark:bg-white/30"
                  range-class="bg-black dark:bg-white"
                  thumb-class="h-3 w-3 bg-black dark:bg-white shadow-md"
                />
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">自动轮播</span>
                  <Switch v-model="settingStore.lyricCarouselEnabled" />
                </div>
                <template v-if="settingStore.lyricCarouselEnabled">
                  <div class="flex items-center justify-between text-[13px] font-semibold">
                    <span class="text-black/60 dark:text-white/60">轮播间隔</span>
                    <span class="font-mono">{{ settingStore.lyricCarouselInterval }}s</span>
                  </div>
                  <Slider
                    :model-value="settingStore.lyricCarouselInterval"
                    :min="5"
                    :max="60"
                    :step="5"
                    @update:model-value="(v) => (settingStore.lyricCarouselInterval = v)"
                    class="lyric-popover-slider h-1 w-full"
                    track-class="bg-black/15 dark:bg-white/30"
                    range-class="bg-black dark:bg-white"
                    thumb-class="h-3 w-3 bg-black dark:bg-white shadow-md"
                  />
                </template>
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">歌词自动收起</span>
                  <Switch v-model="settingStore.lyricAutoCollapseEnabled" />
                </div>
                <template v-if="settingStore.lyricAutoCollapseEnabled">
                  <div class="flex items-center justify-between text-[13px] font-semibold">
                    <span class="text-black/60 dark:text-white/60">收起延迟</span>
                    <span class="font-mono">{{ settingStore.lyricAutoCollapseDelay }}s</span>
                  </div>
                  <Slider
                    :model-value="settingStore.lyricAutoCollapseDelay"
                    :min="5"
                    :max="60"
                    :step="1"
                    @update:model-value="(v) => (settingStore.lyricAutoCollapseDelay = v)"
                    class="lyric-popover-slider h-1 w-full"
                    track-class="bg-black/15 dark:bg-white/30"
                    range-class="bg-black dark:bg-white"
                    thumb-class="h-3 w-3 bg-black dark:bg-white shadow-md"
                  />
                </template>
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">颜色自适应</span>
                  <Switch v-model="settingStore.lyricAdaptiveColor" />
                </div>
              </div>
            </Popover>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="lyric-tool-chip"
              :class="{ 'is-active': settingStore.lyricArtistBackdrop }"
              title="写真模式"
              @click="settingStore.lyricArtistBackdrop = !settingStore.lyricArtistBackdrop"
            >
              <Icon :icon="iconImage" width="14" height="14" />
              <span>{{ settingStore.lyricArtistBackdrop ? '封面' : '写真' }}</span>
            </Button>
            <Popover
              trigger="hover"
              align="end"
              :side-offset="8"
              content-class="lyric-popover w-[260px] p-4"
            >
              <template #trigger>
                <Button variant="unstyled" size="none" type="button" class="lyric-tool-chip">
                  <FontIcon :size="14" />
                  <span>字体</span>
                </Button>
              </template>
              <div class="space-y-4 text-black dark:text-white">
                <div>
                  <div class="mb-2 flex items-center justify-between text-[13px] font-semibold">
                    <span class="text-black/60 dark:text-white/60">字体大小</span>
                    <span class="font-mono">{{ fontSizeLabel }}</span>
                  </div>
                  <Slider
                    :model-value="lyricStore.fontScale"
                    :min="0.7"
                    :max="1.4"
                    :step="0.1"
                    @update:model-value="(v) => lyricStore.updateFontScale(v)"
                    class="h-1 w-full"
                    track-class="bg-black/15 dark:bg-white/30"
                    range-class="bg-black dark:bg-white"
                    thumb-class="h-3.5 w-3.5 bg-black dark:bg-white shadow-md"
                  />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between text-[13px] font-semibold">
                    <span class="text-black/60 dark:text-white/60">字体字重</span>
                    <span class="font-mono">{{ fontWeightLabel }}</span>
                  </div>
                  <Slider
                    :model-value="lyricStore.fontWeightIndex"
                    :min="0"
                    :max="8"
                    :step="1"
                    @update:model-value="(v) => lyricStore.updateFontWeight(v)"
                    class="h-1 w-full"
                    track-class="bg-black/15 dark:bg-white/30"
                    range-class="bg-black dark:bg-white"
                    thumb-class="h-3.5 w-3.5 bg-black dark:bg-white shadow-md"
                  />
                </div>
                <div>
                  <div class="mb-3 flex items-center justify-between text-[13px] font-semibold">
                    <span class="text-black/60 dark:text-white/60">歌词颜色</span>
                    <button
                      v-if="lyricStore.playedColor || lyricStore.unplayedColor"
                      type="button"
                      class="text-[11px] font-semibold text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white transition-colors"
                      @click="lyricColorPicker.reset"
                    >
                      重置
                    </button>
                  </div>
                  <div class="flex items-center gap-4">
                    <div class="flex items-center gap-2">
                      <span class="text-[12px] font-semibold text-black/50 dark:text-white/50"
                        >已播</span
                      >
                      <button
                        type="button"
                        class="lyric-color-swatch"
                        :style="{ backgroundColor: effectivePlayedColor }"
                        @click="lyricColorPicker.open('playedColor')"
                      ></button>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-[12px] font-semibold text-black/50 dark:text-white/50"
                        >未播</span
                      >
                      <button
                        type="button"
                        class="lyric-color-swatch"
                        :style="{
                          backgroundColor: effectiveUnplayedColor,
                        }"
                        @click="lyricColorPicker.open('unplayedColor')"
                      ></button>
                    </div>
                  </div>
                </div>
              </div>
            </Popover>
            <Popover
              trigger="hover"
              align="end"
              :side-offset="8"
              content-class="lyric-popover w-[220px] p-4"
            >
              <template #trigger>
                <Button variant="unstyled" size="none" type="button" class="lyric-tool-chip">
                  <Icon :icon="iconLanguage" width="14" height="14" />
                  <span class="lyric-tool-chip-label" v-text="displayLabel"></span>
                </Button>
              </template>
              <div class="space-y-3 text-black dark:text-white">
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">翻译</span>
                  <Switch
                    :model-value="lyricStore.wantTranslation"
                    :disabled="!lyricStore.hasTranslation"
                    @update:model-value="handleTranslationToggle"
                  />
                </div>
                <div class="flex items-center justify-between text-[13px] font-semibold">
                  <span class="text-black/60 dark:text-white/60">音译</span>
                  <Switch
                    :model-value="lyricStore.wantRomanization"
                    :disabled="!lyricStore.hasRomanization"
                    @update:model-value="handleRomanizationToggle"
                  />
                </div>
              </div>
            </Popover>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="lyric-tool-chip"
              :disabled="!hasLyrics"
              @click="copyLyrics"
            >
              <Icon :icon="iconCopy" width="14" height="14" />
              <span>复制</span>
            </Button>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 px-6 pb-2 no-drag">
        <div class="mx-auto flex h-full max-w-[1560px] gap-7">
          <section
            v-if="!hasPortraitGallery"
            class="hidden min-w-[250px] max-w-[420px] flex-5 items-center justify-center md:flex"
          >
            <div class="lyric-info-card lyric-info-panel cursor-pointer" @click.stop="copySongInfo">
              <div class="lyric-cover-shell">
                <div class="lyric-cover-frame">
                  <Cover
                    :url="currentTrack?.coverUrl"
                    :size="800"
                    :borderRadius="28"
                    class="h-full w-full"
                  />
                </div>
              </div>
              <div class="mt-7 w-full max-w-[420px] space-y-2 text-center">
                <h1
                  class="truncate text-[26px] font-semibold tracking-[0.02em] text-black/95 dark:text-white/95"
                >
                  {{ currentTrack?.title || '未在播放' }}
                </h1>
                <p class="truncate text-[14px] font-semibold text-black/60 dark:text-white/60">
                  {{ currentTrack?.artist || '点击播放开始同步歌词' }}
                </p>
                <p
                  v-if="lyricStore.lyricSyncWarning"
                  class="inline-block rounded-full bg-yellow-600/15 dark:bg-yellow-400/10 px-2 py-1 text-[11px] text-yellow-700 dark:text-yellow-400 pointer-events-none"
                >
                  播放时长与原曲存在差异，歌词可能不同步，可能不是完整的音效/歌曲
                </p>
              </div>
            </div>
          </section>

          <section
            class="lyric-panel-surface relative flex min-w-0 flex-col justify-center self-stretch"
            :class="[hasPortraitGallery ? 'flex-1' : 'flex-7']"
          >
            <!-- 写真模式：歌曲信息 + 警告 -->
            <div
              v-if="hasPortraitGallery && currentTrack"
              class="absolute left-6 bottom-2 z-30 flex flex-col items-start gap-1.5 transition-opacity duration-500"
              :style="{
                opacity: isLyricCollapsed ? 0 : 1,
                pointerEvents: isLyricCollapsed ? 'none' : undefined,
              }"
            >
              <div class="lyric-photo-song-info cursor-pointer" @click.stop="copySongInfo">
                <div class="lyric-photo-song-cover">
                  <Cover
                    :url="currentTrack?.coverUrl"
                    :size="120"
                    :borderRadius="10"
                    class="h-full w-full"
                  />
                </div>
                <div class="lyric-photo-song-meta">
                  <span class="lyric-photo-song-title">{{
                    currentTrack?.title || '未在播放'
                  }}</span>
                  <span class="lyric-photo-song-artist">{{ currentTrack?.artist || '' }}</span>
                </div>
              </div>
              <div
                v-if="lyricStore.lyricSyncWarning"
                class="rounded-full bg-black/40 backdrop-blur-md px-2 py-1 text-[11px] text-yellow-300 pointer-events-none"
              >
                播放时长与原曲存在差异，歌词可能不同步，可能不是完整的音效/歌曲
              </div>
            </div>

            <div
              class="lyric-stage absolute inset-0"
              :style="{
                bottom: isLyricCollapsed ? '-120px' : '0',
                transition: 'bottom 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
              }"
            >
              <div
                ref="lyricListRef"
                class="lyric-scroll absolute inset-0"
                :style="{ fontFamily: lyricFontFamily }"
                @wheel.passive="handleLyricWheel"
              >
                <template v-if="hasLyrics">
                  <div
                    :style="{
                      paddingTop: isLyricCollapsed && currentIndex < 0 ? '85vh' : '40vh',
                      paddingBottom: '40vh',
                    }"
                  >
                    <div
                      v-for="(line, index) in lyricStore.lines"
                      :key="line.time"
                      class="lyric-row"
                      :data-lyric-index="index"
                      :style="{
                        minHeight:
                          (lyricStore.lyricsMode === 'both'
                            ? 72
                            : lyricStore.lyricsMode === 'translation' ||
                                lyricStore.lyricsMode === 'romanization'
                              ? 56
                              : 36) *
                            lyricStore.fontScale +
                          'px',
                        paddingTop: isLyricCollapsed ? '2px' : '16px',
                        paddingBottom: isLyricCollapsed ? '2px' : '16px',
                        opacity: isLyricCollapsed
                          ? index === currentIndex ||
                            index === currentIndex + 1 ||
                            (currentIndex < 0 && index <= 1)
                            ? 1
                            : 0
                          : undefined,
                        transition:
                          isLyricCollapsed || wasCollapsed
                            ? 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1)'
                            : undefined,
                      }"
                    >
                      <div
                        :class="['lyric-line', currentIndex === index ? 'is-current' : 'is-idle']"
                        @dblclick.prevent.stop="handleLyricLineClick(line.time)"
                      >
                        <span
                          class="block leading-[1.24] tracking-[0.01em]"
                          :style="{
                            fontSize: titleFontSize,
                            fontWeight: String(lyricStore.fontWeightValue),
                          }"
                        >
                          <template v-if="currentIndex === index && isYrcLine(line)">
                            <span
                              v-for="(char, ci) in line.characters"
                              :key="ci"
                              class="lyric-yrc-char"
                              :style="[
                                {
                                  backgroundImage: `linear-gradient(to right, ${yrcPlayedColor} 50%, ${yrcUnplayedColor} 50%)`,
                                },
                                getYrcStyle(char, index),
                              ]"
                              >{{ char.text }}</span
                            >
                          </template>
                          <template v-else>
                            <span
                              :style="{
                                color:
                                  currentIndex === index
                                    ? effectivePlayedColor
                                    : effectiveUnplayedColor,
                              }"
                              >{{ line.text }}</span
                            >
                          </template>
                        </span>
                        <!-- both 模式：翻译和音译分行显示 -->
                        <template
                          v-if="lyricStore.lyricsMode === 'both' && lyricStore.secondaryEnabled"
                        >
                          <span
                            v-if="line.translated?.trim()"
                            class="lyric-subline mt-1 block max-w-full truncate"
                            :style="{
                              fontSize: secondaryFontSize,
                              fontWeight: String(
                                currentIndex === index
                                  ? Math.max(500, lyricStore.fontWeightValue - 200)
                                  : 400,
                              ),
                              color: effectiveUnplayedColor ? effectiveUnplayedColor : undefined,
                              opacity: effectiveUnplayedColor ? 0.7 : undefined,
                            }"
                          >
                            {{ line.translated.trim() }}
                          </span>
                          <span
                            v-if="line.romanized?.trim()"
                            class="lyric-subline mt-1 block max-w-full truncate"
                            :style="{
                              fontSize: romanizationFontSize,
                              fontWeight: String(
                                currentIndex === index
                                  ? Math.max(500, lyricStore.fontWeightValue - 200)
                                  : 400,
                              ),
                              color: effectiveUnplayedColor ? effectiveUnplayedColor : undefined,
                              opacity: effectiveUnplayedColor ? 0.55 : 0.72,
                            }"
                          >
                            {{ line.romanized.trim() }}
                          </span>
                        </template>
                        <!-- 单一翻译/音译模式 -->
                        <template v-else>
                          <span
                            v-if="lyricStore.lineSecondaryText(line)"
                            class="lyric-subline mt-1 block max-w-full truncate"
                            :style="{
                              fontSize: secondaryFontSize,
                              fontWeight: String(
                                currentIndex === index
                                  ? Math.max(500, lyricStore.fontWeightValue - 200)
                                  : 400,
                              ),
                              color: effectiveUnplayedColor ? effectiveUnplayedColor : undefined,
                              opacity: effectiveUnplayedColor ? 0.7 : undefined,
                            }"
                          >
                            {{ lyricStore.lineSecondaryText(line) }}
                          </span>
                        </template>
                      </div>
                    </div>
                  </div>
                </template>

                <div v-else class="flex h-full items-center justify-center text-center">
                  <div class="space-y-3">
                    <p class="text-[28px] font-semibold text-black/88 dark:text-white/88">
                      {{ emptyStateTitle }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div
        class="px-6 pb-1 pt-0 no-drag transition-opacity duration-500"
        :style="{
          opacity: isLyricCollapsed ? 0 : 1,
          pointerEvents: isLyricCollapsed ? 'none' : undefined,
        }"
      >
        <div class="lyric-controls-surface mx-auto flex w-full max-w-[820px] flex-col gap-0.5">
          <!-- 核心播放控制行 -->
          <div class="lyric-controls-row flex items-center justify-center gap-5 self-center">
            <Tooltip :content="playModeLabel" side="top">
              <template #trigger>
                <Button
                  variant="unstyled"
                  size="none"
                  type="button"
                  class="flex h-9 w-9 items-center justify-center rounded-full transition-all hover:scale-110 active:scale-90"
                  @click="cyclePlayMode"
                >
                  <Icon
                    :icon="playModeIcon"
                    width="22"
                    height="22"
                    class="text-black/55 dark:text-white/55"
                  />
                </Button>
              </template>
            </Tooltip>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-full transition-all hover:scale-110 active:scale-90"
              title="上一曲"
              @click="playerStore.prev()"
            >
              <Icon
                :icon="iconSkipBack"
                width="22"
                height="22"
                class="text-black/80 dark:text-white/80"
              />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="lyric-main-play-btn flex h-12 w-12 items-center justify-center rounded-full"
              :title="playerStore.isPlaying ? '暂停' : '播放'"
              @click="playerStore.togglePlay()"
            >
              <Icon
                :icon="playerStore.isPlaying ? iconPause : iconPlay"
                width="24"
                height="24"
                class="text-black dark:text-white"
              />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-full transition-all hover:scale-110 active:scale-90"
              title="下一曲"
              @click="playerStore.next()"
            >
              <Icon
                :icon="iconSkipForward"
                width="22"
                height="22"
                class="text-black/80 dark:text-white/80"
              />
            </Button>
            <!-- 音量 -->
            <VolumePopover variant="lyric" />
          </div>

          <!-- 进度条行 -->
          <div
            class="mt-0 w-full"
            style="
              display: grid;
              grid-template-columns: 1fr minmax(0, 420px) 1fr;
              align-items: center;
              gap: 4px;
            "
          >
            <!-- 左列 -->
            <div class="flex items-center justify-start">
              <Tooltip :content="isFavorite ? '取消收藏' : '收藏'" side="top">
                <template #trigger>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="p-1.5 transition-all hover:scale-110 active:scale-90"
                    @click="toggleFavorite"
                  >
                    <Icon
                      :icon="isFavorite ? iconHeartFilled : iconHeart"
                      width="20"
                      height="20"
                      :class="isFavorite ? 'text-red-500' : 'text-black/40 dark:text-white/40'"
                    />
                  </Button>
                </template>
              </Tooltip>
              <Tooltip v-if="canAddToPlaylist" content="添加到" side="top">
                <template #trigger>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="p-1.5 transition-all hover:scale-110 active:scale-90 text-black/40 dark:text-white/40"
                    @click="handleOpenAddToPlaylist"
                  >
                    <Icon :icon="iconPlaylistAdd" width="20" height="20" />
                  </Button>
                </template>
              </Tooltip>
              <Tooltip v-if="currentTrack" content="评论" side="top">
                <template #trigger>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="p-1.5 transition-all hover:scale-110 active:scale-90 text-black/40 dark:text-white/40"
                    @click="isCommentDrawerOpen = true"
                  >
                    <Icon :icon="iconMessageCircle" width="20" height="20" />
                  </Button>
                </template>
              </Tooltip>
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
                  <div class="lyric-error-indicator">
                    <Icon :icon="iconTriangleAlert" width="18" height="18" />
                  </div>
                </template>
                <div class="player-error-content">
                  <div class="player-error-title">{{ playerStore.playbackNotice.title }}</div>
                  <div class="player-error-reason">{{ playerStore.playbackNotice.reason }}</div>
                  <div class="player-error-detail">{{ playerStore.playbackNotice.detail }}</div>
                </div>
              </Popover>
            </div>

            <!-- 中列：进度条 -->
            <div class="min-w-0 flex items-center gap-2">
              <span
                class="w-[38px] text-right font-mono text-[11px] font-semibold text-black/40 dark:text-white/40 shrink-0"
              >
                {{ formatDuration(isProgressDragging ? progressValue : playerStore.currentTime) }}
              </span>
              <SliderRoot
                :model-value="[isProgressDragging ? progressValue : playerStore.currentTime]"
                :min="0"
                :max="Math.max(playerStore.duration, 1)"
                :step="1"
                class="relative flex items-center select-none touch-none flex-1 min-w-0 h-4 group/progress"
                @update:model-value="handleProgressInput"
                @value-commit="handleProgressCommit"
                @pointerdown="handleProgressPointerDown"
                @mouseenter="isHoveringProgress = true"
                @mouseleave="isHoveringProgress = false"
              >
                <SliderTrack
                  class="bg-black/10 dark:bg-white/10 relative grow rounded-full h-[3px]"
                >
                  <div class="climax-mark-layer">
                    <template
                      v-for="(mark, index) in playerStore.climaxMarks"
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
                  <SliderRange class="absolute bg-black dark:bg-white rounded-full h-full" />
                </SliderTrack>
                <SliderThumb
                  class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none transition-[opacity,transform] duration-200"
                  :class="[isHoveringProgress ? 'opacity-100 scale-110' : 'opacity-0 scale-50']"
                />
              </SliderRoot>
              <span
                class="w-[38px] text-left font-mono text-[11px] font-semibold text-black/40 dark:text-white/40 shrink-0"
              >
                {{ formatDuration(playerStore.duration) }}
              </span>
            </div>

            <!-- 右列 -->
            <div class="flex items-center justify-end gap-1 select-none">
              <!-- 倍速 -->
              <SpeedPopover variant="lyric" />
              <!-- 音质 -->
              <QualityPopover variant="lyric" />
              <EffectPopover variant="lyric" />
              <!-- 桌面歌词 -->
              <Tooltip
                :content="desktopLyricStore.settings.enabled ? '关闭桌面歌词' : '开启桌面歌词'"
                side="top"
              >
                <template #trigger>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="p-2 transition-all hover:scale-110 active:scale-90"
                    :class="
                      desktopLyricStore.settings.enabled
                        ? 'text-black dark:text-white'
                        : 'text-black/40 dark:text-white/40'
                    "
                    @click="toggleDesktopLyric"
                  >
                    <Icon :icon="iconTypography" width="20" height="20" />
                  </Button>
                </template>
              </Tooltip>
              <!-- 播放列表 -->
              <Tooltip content="播放列表" side="top">
                <template #trigger>
                  <Button
                    variant="unstyled"
                    size="none"
                    type="button"
                    class="p-2 transition-all hover:scale-110 active:scale-90 text-black/40 dark:text-white/40 relative"
                    @click="isQueueDrawerOpen = true"
                  >
                    <Icon :icon="iconList" width="20" height="20" />
                    <Badge
                      v-if="settingStore.showPlaylistCount"
                      :count="queueCount > 99 ? '99+' : queueCount"
                      class="absolute top-0 right-[-3px]"
                    />
                  </Button>
                </template>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>

    <PlayerQueueDrawer v-model:open="isQueueDrawerOpen" />

    <CommentDrawer
      v-if="currentTrack"
      v-model:open="isCommentDrawerOpen"
      :resourceId="
        currentTrack.mixSongId ? String(currentTrack.mixSongId) : String(currentTrack.id)
      "
      resourceType="music"
      :mixSongId="currentTrack.mixSongId ? String(currentTrack.mixSongId) : String(currentTrack.id)"
      title="评论"
    />

    <Dialog
      v-model:open="showAddToPlaylistDialog"
      title="添加到"
      contentClass="max-w-[420px]"
      showClose
    >
      <div class="lyric-add-playlist-body">
        <div class="lyric-add-playlist-divider"><span>播放队列</span></div>
        <div v-if="addToPlaybackQueues.length === 0" class="lyric-add-playlist-status">
          暂无播放队列
        </div>
        <Button
          v-for="queue in addToPlaybackQueues"
          :key="queue.id"
          type="button"
          class="lyric-add-playlist-item lyric-add-playlist-queue"
          variant="ghost"
          size="sm"
          @click="handleAddToQueue(queue.id)"
        >
          <span class="lyric-add-playlist-name">
            <Icon :icon="iconList" width="16" height="16" />
            {{ queue.title || '播放队列' }}
          </span>
          <span class="lyric-add-playlist-count">{{ queue.songs.length }} 首</span>
        </Button>
        <div class="lyric-add-playlist-divider"><span>歌单</span></div>
        <div v-if="isPlaylistLoading" class="lyric-add-playlist-status">加载歌单中...</div>
        <div v-else-if="createdPlaylists.length === 0" class="lyric-add-playlist-status">
          暂无可用歌单
        </div>
        <Button
          v-for="entry in createdPlaylists"
          :key="entry.listid ?? entry.id"
          type="button"
          class="lyric-add-playlist-item"
          variant="ghost"
          size="sm"
          @click="handleSelectPlaylist(entry.listid ?? entry.id)"
        >
          <span class="lyric-add-playlist-name">{{ entry.name }}</span>
          <span class="lyric-add-playlist-count">{{ entry.count ?? 0 }} 首</span>
        </Button>
      </div>
    </Dialog>

    <ColorPickerDialog
      :open="lyricColorPicker.isOpen.value"
      :title="lyricColorPicker.activeTitle.value"
      :value="lyricColorPicker.activeValue.value"
      :presets="lyricColorPicker.presets"
      @update:open="(open: boolean) => !open && lyricColorPicker.close()"
      @confirm="lyricColorPicker.apply"
    />
  </div>
</template>

<style>
/* 歌词页面打开时，提升所有弹出层的 z-index */
body:has(.lyric-view) .dialog-overlay {
  z-index: 2200 !important;
}

body:has(.lyric-view) .dialog-content {
  z-index: 2210 !important;
}

body:has(.lyric-view) .drawer-overlay {
  z-index: 2200 !important;
}

body:has(.lyric-view) .drawer-panel {
  z-index: 2210 !important;
}

/* 歌词页弹出层通用 */
.lyric-popover {
  z-index: 2100;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(18px);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
  color: black;
  user-select: none;
  -webkit-user-select: none;
}

.dark .lyric-popover {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.6);
  color: white;
}

/* 弹出层内滑块颜色跟随弹出层文字色 */
.lyric-popover [data-orientation] > span:first-child {
  background-color: currentColor !important;
  opacity: 0.15;
}

.lyric-popover [data-orientation] > span:first-child > span {
  background-color: currentColor !important;
  opacity: 1;
}

.lyric-popover [role='slider'] {
  background-color: currentColor !important;
}

.lyric-atmosphere {
  background:
    radial-gradient(36% 28% at 16% 22%, rgba(255, 255, 255, 0.72), transparent 74%),
    radial-gradient(28% 22% at 78% 18%, rgba(0, 113, 227, 0.08), transparent 74%),
    radial-gradient(44% 34% at 82% 72%, rgba(148, 163, 184, 0.12), transparent 76%);
}

.dark .lyric-atmosphere {
  background:
    radial-gradient(36% 28% at 16% 22%, rgba(37, 99, 235, 0.12), transparent 74%),
    radial-gradient(30% 24% at 80% 16%, rgba(255, 255, 255, 0.03), transparent 76%),
    radial-gradient(50% 44% at 86% 78%, rgba(0, 0, 0, 0.4), transparent 80%);
}

.lyric-portrait-backdrop-wrap {
  overflow: hidden;
}

.lyric-portrait-backdrop {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  object-position: center center;
  opacity: 0.94;
  filter: saturate(0.96) contrast(1.02);
  user-select: none;
}

.lyric-ambient-photo {
  opacity: 0.55;
  filter: blur(60px) saturate(1.2) brightness(1.1);
  transform: scale(1.1);
}

.dark .lyric-ambient-photo {
  opacity: 0.45;
  filter: blur(60px) saturate(0.9) brightness(0.7);
}

.lyric-portrait-overlay {
  background: rgba(0, 0, 0, 0.15);
}

.dark .lyric-portrait-overlay {
  background: rgba(0, 0, 0, 0.15);
}

.lyric-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  box-shadow: 0 10px 30px rgba(148, 163, 184, 0.12);
  transition: all 0.2s ease;
}

.lyric-icon-btn:hover,
.lyric-tool-chip:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.48);
}

.lyric-tool-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  height: 39.5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  box-shadow: 0 12px 28px rgba(148, 163, 184, 0.1);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: all 0.2s ease;
}

.lyric-tool-group {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 3px 4px;
  height: 39.5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  box-shadow: 0 12px 28px rgba(148, 163, 184, 0.1);
}

.lyric-tool-chip-main {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 33.5px;
  box-shadow: none;
  background: transparent;
  border-radius: 999px;
}

.lyric-tool-chip-label {
  display: inline-block;
  min-width: 2em;
  line-height: 1;
  white-space: nowrap;
  opacity: 1;
  color: rgba(15, 23, 42, 0.88);
}

.lyric-photo-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  justify-content: center;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 700;
  color: rgba(15, 23, 42, 0.84);
}

.lyric-tool-chip.is-active {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 24px rgba(148, 163, 184, 0.14);
}

.lyric-tool-chip-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 33.5px;
  height: 33.5px;
  margin-left: 2px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.44);
  box-shadow: none;
  opacity: 0.92;
  transition: all 0.2s ease;
}

.lyric-tool-chip-inline:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.62);
}

.dark .lyric-tool-chip,
.dark .lyric-icon-btn {
  background: rgba(22, 30, 44, 0.72);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .lyric-tool-group {
  background: rgba(14, 18, 26, 0.65);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .lyric-tool-chip-inline {
  background: rgba(28, 36, 52, 0.88);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: none;
}

.dark .lyric-tool-chip.is-active {
  background: rgba(22, 30, 44, 0.72);
  box-shadow: none;
}

.dark .lyric-tool-chip-label {
  color: rgba(255, 255, 255, 0.9);
}

.dark .lyric-photo-chip {
  color: rgba(255, 255, 255, 0.84);
}

.dark .lyric-tool-chip-inline:hover {
  background: rgba(40, 54, 78, 0.96);
}

.dark .lyric-icon-btn:hover,
.dark .lyric-tool-chip:hover {
  background: rgba(36, 48, 70, 0.82);
}

.dark .lyric-tool-chip:disabled,
.dark .lyric-weight-btn:disabled {
  opacity: 0.5;
  background: rgba(18, 24, 36, 0.8);
  border-color: rgba(255, 255, 255, 0.05);
}

.lyric-weight-btn,
.lyric-compact-btn {
  width: 26px;
  height: 26px;
  border-radius: 999px;
}

.lyric-weight-label {
  min-width: 38px;
  text-align: center;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: rgba(15, 23, 42, 0.86);
}

.dark .lyric-weight-label {
  color: rgba(255, 255, 255, 0.84);
}

.lyric-color-swatch {
  width: 32px;
  height: 22px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.26);
  transition: transform 0.15s ease;
}

.lyric-color-swatch:hover {
  transform: scale(1.08);
}

.dark .lyric-color-swatch {
  border-color: rgba(255, 255, 255, 0.15);
}

.lyric-info-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.lyric-info-card {
  width: min(100%, 420px);
  padding: 18px 8px 12px;
}

.lyric-controls-surface {
  padding: 0 10px 0;
}

/* 非写真模式：控制栏按钮 hover 时不变色 */

.lyric-main-play-btn {
  background: rgba(255, 255, 255, 0.38);
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 10px 30px rgba(148, 163, 184, 0.12);
  transition: none !important;
  transform: none !important;
}

.dark .lyric-main-play-btn {
  background: rgba(22, 30, 44, 0.6);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
}

.lyric-cover-shell {
  position: relative;
  width: clamp(240px, 38vh, 400px);
  height: clamp(240px, 38vh, 400px);
}

.lyric-cover-frame {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  border-radius: 28px;
  box-shadow: 0 22px 56px rgba(15, 23, 42, 0.14);
  transition:
    opacity 0.3s ease,
    filter 0.3s ease,
    box-shadow 0.3s ease,
    transform 0.3s ease;
}

.dark .lyric-cover-frame {
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.45);
}

/* 歌曲信息浮层 */
.lyric-photo-song-info {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px 8px 8px;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.45);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.08);
  max-width: 280px;
}

.dark .lyric-photo-song-info {
  background: rgba(0, 0, 0, 0.6);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

.lyric-photo-song-cover {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
}

.lyric-photo-song-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lyric-photo-song-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .lyric-photo-song-title {
  color: var(--color-primary);
}

.lyric-photo-song-artist {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-primary);
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .lyric-photo-song-artist {
  color: var(--color-primary);
}

.lyric-stage {
  min-height: 0;
  z-index: 25;
  mask-image: linear-gradient(180deg, transparent 0%, black 12%, black 88%, transparent 100%);
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    black 12%,
    black 88%,
    transparent 100%
  );
}

.lyric-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.lyric-scroll::-webkit-scrollbar {
  display: none;
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
  background: rgba(0, 113, 227, 0.78);
}

.dark .climax-tick {
  background: rgba(96, 165, 250, 0.72);
}

.lyric-row {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
}

.lyric-line {
  width: 100%;
  max-width: min(100%, 920px);
  padding: 6px 24px;
  border-radius: 28px;
  text-align: center;
  color: inherit;
  cursor: pointer;
  transition:
    opacity 0.26s ease,
    transform 0.26s ease,
    background-color 0.26s ease,
    box-shadow 0.26s ease;
}

.lyric-line > span:first-child {
  color: rgba(15, 23, 42, 0.82);
  transition: color 0.2s ease;
}

.dark .lyric-line > span:first-child {
  color: rgba(255, 255, 255, 0.82);
}

.lyric-line.is-idle {
  opacity: 0.88;
  transform: scale(0.965) translateY(4px);
}

.lyric-line.is-idle > span:first-child {
  color: rgba(15, 23, 42, 0.58);
}

.dark .lyric-line.is-idle > span:first-child {
  color: rgba(255, 255, 255, 0.66);
}

.lyric-line.is-current {
  opacity: 1;
  transform: scale(1) translateY(0);
  background: transparent;
  box-shadow: none;
}

.lyric-line.is-current > span:first-child {
  color: rgba(15, 23, 42, 0.98);
}

.dark .lyric-line.is-current {
  background: transparent;
  box-shadow: none;
}

.dark .lyric-line.is-current > span:first-child {
  color: rgba(255, 255, 255, 0.98);
}

.lyric-subline {
  color: rgba(15, 23, 42, 0.46);
}

.dark .lyric-subline {
  color: rgba(255, 255, 255, 0.46);
}

.lyric-line.is-current .lyric-subline {
  color: rgba(15, 23, 42, 0.62);
}

.dark .lyric-line.is-current .lyric-subline {
  color: rgba(255, 255, 255, 0.62);
}

.lyric-yrc-char {
  display: inline;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
  will-change: background-position-x;
}

.lyric-character {
  transition: color 0.18s ease;
  color: rgba(15, 23, 42, 0.84);
}

.dark .lyric-character {
  color: rgba(255, 255, 255, 0.94);
}

.lyric-line.is-idle .lyric-character {
  color: rgba(15, 23, 42, 0.58);
}

.dark .lyric-line.is-idle .lyric-character {
  color: rgba(255, 255, 255, 0.66);
}

.lyric-line.is-current .lyric-character {
  color: rgba(15, 23, 42, 0.98);
}

.dark .lyric-line.is-current .lyric-character {
  color: rgba(255, 255, 255, 0.98);
}

.lyric-character.is-highlighted {
  color: var(--color-primary);
}

.dark .lyric-character.is-highlighted {
  color: var(--color-primary);
}

.lyric-line.is-current .lyric-character.is-highlighted {
  color: var(--color-primary);
}

.dark .lyric-line.is-current .lyric-character.is-highlighted {
  color: var(--color-primary);
}

.lyric-tool-chip:disabled,
.lyric-weight-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  transform: none !important;
}

@media (max-width: 960px) {
  .lyric-portrait-backdrop {
    object-position: center top;
  }
}

.lyric-add-playlist-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lyric-add-playlist-status {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: rgba(15, 23, 42, 0.5);
}

.dark .lyric-add-playlist-status {
  color: rgba(255, 255, 255, 0.5);
}

.lyric-add-playlist-name {
  font-size: 13px;
  font-weight: 600;
}

.lyric-add-playlist-count {
  font-size: 11px;
  opacity: 0.6;
}

.lyric-add-playlist-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: rgba(255, 255, 255, 0.5);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgba(15, 23, 42, 0.88);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.dark .lyric-add-playlist-item {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.88);
}

.lyric-add-playlist-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.lyric-add-playlist-queue {
  border-style: dashed;
}

.lyric-add-playlist-queue .lyric-add-playlist-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lyric-add-playlist-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: rgba(15, 23, 42, 0.5);
}

.dark .lyric-add-playlist-divider {
  color: rgba(255, 255, 255, 0.5);
}

/* ── 写真模式：统一底色，减少深浅主题下的亮度差异 ── */
.portrait-mode {
  background-color: #2a2d32 !important;
}

.dark .portrait-mode {
  background-color: #1a1d22 !important;
}

/* ── 写真模式：分区亮度自适应 ── */
.portrait-mode {
  --pt-fg: rgba(255, 255, 255, 0.9);
  --pt-fg-hover: var(--color-primary);
  --pt-fg-muted: rgba(255, 255, 255, 0.5);
  --pt-btn-bg: rgba(0, 0, 0, 0.35);
  --pt-btn-bg-hover: rgba(0, 0, 0, 0.5);
  --pt-btn-border: rgba(255, 255, 255, 0.1);
  --pb-fg: rgba(255, 255, 255, 0.85);
  --pb-fg-hover: var(--color-primary);
  --pb-fg-muted: rgba(255, 255, 255, 0.5);
  --pb-btn-bg: rgba(245, 245, 247, 0.12);
  --pb-btn-border: rgba(255, 255, 255, 0.06);
  --pb-card-bg: rgba(10, 14, 20, 0.52);
  --ps-fg: rgba(255, 255, 255, 0.9);
  --ps-fg-muted: rgba(255, 255, 255, 0.6);
  --ps-card-bg: rgba(0, 0, 0, 0.45);
  --ps-card-border: rgba(255, 255, 255, 0.08);
}

.portrait-mode .lyric-icon-btn,
.portrait-mode .lyric-tool-chip {
  background: var(--pt-btn-bg);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid var(--pt-btn-border);
  color: var(--pt-fg);
}

.portrait-mode .lyric-icon-btn:hover,
.portrait-mode .lyric-tool-chip:hover {
  background: var(--pt-btn-bg-hover);
}

.portrait-mode .lyric-tool-group {
  background: var(--pt-btn-bg);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid var(--pt-btn-border);
}

.portrait-mode .lyric-tool-chip-label,
.portrait-mode .lyric-photo-chip,
.portrait-mode .lyric-tool-chip-main {
  color: var(--pt-fg);
}

.portrait-mode .lyric-tool-chip.is-active {
  background: var(--pt-btn-bg);
  box-shadow: none;
}

.portrait-mode .lyric-main-play-btn {
  background: var(--pt-btn-bg) !important;
  border: 1px solid var(--pt-btn-border) !important;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  color: var(--pb-fg);
  transition: none !important;
  transform: none !important;
}

.portrait-mode .lyric-photo-song-info {
  background: var(--ps-card-bg);
  backdrop-filter: blur(16px);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid var(--ps-card-border);
}

.portrait-mode .lyric-photo-song-title {
  color: var(--ps-fg);
}

.portrait-mode .lyric-photo-song-artist {
  color: var(--ps-fg);
  opacity: 0.85;
}

.portrait-mode .lyric-portrait-overlay {
  background: rgba(0, 0, 0, 0.15);
}

/* 写真模式下控制器颜色 */
.portrait-mode .lyric-controls-surface .iconify,
.portrait-mode .lyric-controls-surface svg,
.portrait-mode .lyric-controls-surface button:not(.lyric-main-play-btn),
.portrait-mode .lyric-controls-surface [class*='text-black'],
.portrait-mode .lyric-controls-surface [class*='text-white'] {
  color: var(--pb-fg) !important;
}

.portrait-mode .lyric-controls-surface button:not(.lyric-main-play-btn):hover .iconify,
.portrait-mode .lyric-controls-surface button:not(.lyric-main-play-btn):hover svg {
  color: var(--pb-fg) !important;
}

/* 播放按钮图标颜色独立控制，不受通配覆盖 */
.portrait-mode .lyric-main-play-btn,
.portrait-mode .lyric-main-play-btn .iconify,
.portrait-mode .lyric-main-play-btn svg {
  color: var(--pb-fg) !important;
}

.portrait-mode .lyric-controls-surface span {
  color: var(--pb-fg-muted);
}

/* 写真模式下进度条/滑块颜色 */
.portrait-mode .lyric-controls-surface [data-orientation] > span:first-child {
  background-color: var(--pb-fg-muted) !important;
}

.portrait-mode .lyric-controls-surface [data-orientation] > span:first-child > span {
  background-color: var(--pb-fg) !important;
}

.portrait-mode .lyric-controls-surface [role='slider'] {
  background-color: var(--pb-fg) !important;
  border-color: var(--pb-fg-muted) !important;
}

.lyric-error-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  color: #ef4444;
  opacity: 0.88;
  cursor: help;
  transition: all 0.2s ease;
}

.dark .lyric-error-indicator {
  color: #f87171;
}

.lyric-error-indicator:hover {
  opacity: 1;
  transform: scale(1.1);
}

/* 歌词页徽标根据亮度自适应 */
.lyric-view .badge,
.lyric-view [class*='badge'] {
  background-color: var(--pb-badge-bg, #000) !important;
  color: var(--pb-badge-fg, #fff) !important;
}

.portrait-mode .lyric-controls-surface .badge,
.portrait-mode .lyric-controls-surface [class*='badge'] {
  background-color: var(--pb-badge-bg, #000) !important;
  color: var(--pb-badge-fg, #fff) !important;
}
</style>
