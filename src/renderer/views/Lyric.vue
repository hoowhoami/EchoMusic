<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getAudioImages, type AudioImageAuthor, type AudioImagePortrait } from '@/api/music';
import { useLyricStore } from '@/stores/lyric';
import type { Song } from '@/models/song';
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
  SliderRoot,
  SliderTrack,
  SliderRange,
  SliderThumb,
} from 'reka-ui';
import Cover from '@/components/ui/Cover.vue';
import Slider from '@/components/ui/Slider.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import { formatDuration } from '@/utils/format';
import { closeTransientView } from '@/utils/navigation';
import { getCoverUrl } from '@/utils/cover';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import Tag from '@/components/ui/Tag.vue';
import Badge from '@/components/ui/Badge.vue';
import AudioWaveIcon from '@/components/ui/AudioWaveIcon.vue';
import {
  iconChevronDown,
  iconChevronLeft,
  iconChevronRight,
  iconCopy,
  iconImage,
  iconLanguage,
  iconChevronUpDown,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconHeart,
  iconHeartFilled,
  iconMessageCircle,
  iconSpeedometer,
  iconTypography,
  iconList,
  iconPlaylistAdd,
} from '@/icons';
import { usePlayerControls } from '@/utils/usePlayerControls';

const router = useRouter();
const route = useRoute();
const lyricStore = useLyricStore();

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
  volumeIcon,
  lastVolume,
  handleVolumeChange,
  toggleMute,
  playbackRateDisplay,
  handlePlaybackRateSlider,
  resetPlaybackRate,
  setPlaybackRate,
  effectiveAudioQuality,
  isAudioQualityDisabled,
  audioQualityButtonBadge,
  currentAudioQualityBadgeColor,
  getAudioQualityTagColor,
  setAudioQuality,
  setAudioEffect,
  toggleDesktopLyric,
  goToComments,
  goToMv,
  isQueueDrawerOpen,
  showAddToPlaylistDialog,
  isPlaylistLoading,
  canAddToPlaylist,
  createdPlaylists,
  addToPlaybackQueues,
  handleOpenAddToPlaylist,
  handleAddToQueue,
  handleSelectPlaylist,
  queueCount,
} = usePlayerControls();
const singerPortraitCache = new Map<string, string[]>();
const singerPortraitPending = new Map<string, Promise<string[]>>();

const normalizeRemoteImageUrl = (url: string | undefined): string => {
  return String(url ?? '')
    .trim()
    .replace(/^http:\/\//, 'https://');
};

const resolvePortraitsFromAuthors = (authors: unknown): string[] => {
  if (!Array.isArray(authors)) return [];
  const portraitSet = new Set<string>();
  for (const author of authors as AudioImageAuthor[]) {
    const portraits = Array.isArray(author?.imgs?.['3'])
      ? (author.imgs?.['3'] as AudioImagePortrait[])
      : [];
    for (const portrait of portraits) {
      const url = normalizeRemoteImageUrl(portrait?.sizable_portrait);
      if (url) portraitSet.add(url);
    }
  }
  return [...portraitSet];
};

const lyricListRef = ref<HTMLElement | null>(null);
const progressValue = ref(0);
const isProgressDragging = ref(false);
const isHoveringProgress = ref(false);
const copyFeedback = ref(false);
const isUserScrollingLyrics = ref(false);
const artistPortraitUrls = ref<string[]>([]);
const activePortraitIndex = ref(0);
let userScrollResumeTimer: number | null = null;
let artistBackdropRequestId = 0;

const isVolumeVisible = ref(false);
const volumeContainerRef = ref<HTMLElement | null>(null);
let volumeWheelTimer: ReturnType<typeof setTimeout> | null = null;

const isMacPlatform = navigator.platform.toLowerCase().includes('mac');

const toggleVolume = () => {
  isVolumeVisible.value = !isVolumeVisible.value;
};

const handleVolumeWheel = (e: WheelEvent) => {
  e.preventDefault();
  const normalized = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120);
  const step = (normalized / 120) * 0.05;
  const direction = isMacPlatform ? 1 : -1;
  const newVolume = Math.max(0, Math.min(1, playerStore.volume + step * direction));
  playerStore.setVolume(newVolume);
  isVolumeVisible.value = true;

  if (volumeWheelTimer) clearTimeout(volumeWheelTimer);
  volumeWheelTimer = setTimeout(() => {
    isVolumeVisible.value = false;
    volumeWheelTimer = null;
  }, 1000);
};

const handleVolumeClickOutside = (e: MouseEvent) => {
  if (
    isVolumeVisible.value &&
    volumeContainerRef.value &&
    !volumeContainerRef.value.contains(e.target as Node)
  ) {
    isVolumeVisible.value = false;
  }
};

const coverBackgroundUrl = computed(() => getCoverUrl(currentTrack.value?.coverUrl, 900));
const activePortraitUrl = computed(() => {
  return artistPortraitUrls.value[activePortraitIndex.value] || '';
});
const hasPortraitGallery = computed(
  () => settingStore.lyricArtistBackdrop && artistPortraitUrls.value.length > 0,
);
const backdropOpacityStyle = computed(() => ({
  opacity: settingStore.lyricBackdropOpacity / 100,
}));
const backdropOpacityLabel = computed(() => `${settingStore.lyricBackdropOpacity}%`);
const portraitCounterLabel = computed(() => {
  if (!hasPortraitGallery.value) return '';
  return `${activePortraitIndex.value + 1} / ${artistPortraitUrls.value.length}`;
});
const currentTrackLyricHash = computed(() =>
  String(currentTrack.value?.hash ?? currentTrack.value?.id ?? '').trim(),
);
const currentIndex = computed(() => lyricStore.currentIndex);
const hasLyrics = computed(() => lyricStore.lines.length > 0);
const hasActiveTrack = computed(() => Boolean(currentTrack.value));
const displayLabel = computed(() => {
  if (!lyricStore.secondaryEnabled || !lyricStore.canShowSecondary) return '原词';
  if (lyricStore.lyricsMode === 'both') return '译+音';
  if (lyricStore.lyricsMode === 'romanization') return '音译';
  if (lyricStore.lyricsMode === 'translation') return '翻译';
  return lyricStore.preferredMode === 'romanization' ? '音译' : '翻译';
});
const canToggleSecondary = computed(() => lyricStore.canShowSecondary);
const canCycleSecondaryMode = computed(
  () => lyricStore.hasTranslation && lyricStore.hasRomanization,
);
const emptyStateTitle = computed(() => {
  if (!hasActiveTrack.value) return '未在播放';
  if (lyricStore.isLoading) return '歌词加载中…';
  return '暂无歌词';
});
const titleFontSize = computed(
  () =>
    `clamp(${23 * lyricStore.fontScale}px, ${2.3 * lyricStore.fontScale}vw, ${36 * lyricStore.fontScale}px)`,
);
const secondaryFontSize = computed(
  () =>
    `clamp(${12 * lyricStore.fontScale}px, ${1.0 * lyricStore.fontScale}vw, ${15 * lyricStore.fontScale}px)`,
);
const fontWeightLabel = computed(() => `W${lyricStore.fontWeightValue}`);
const fontSizeLabel = computed(() => `${Math.round(lyricStore.fontScale * 100)}%`);

const lyricColorPresets = [
  '#31cfa1', '#0071e3', '#8b5cf6', '#ef476f',
  '#f59e0b', '#22c55e', '#60a5fa', '#f97316',
  '#e11d48', '#14b8a6', '#a855f7', '#ffffff',
];

const activeLyricColorField = ref<'playedColor' | 'unplayedColor' | null>(null);

const activeLyricColorValue = computed(() => {
  if (!activeLyricColorField.value) return '#31cfa1';
  return lyricStore[activeLyricColorField.value] || '#31cfa1';
});

const openLyricColorPicker = (field: 'playedColor' | 'unplayedColor') => {
  activeLyricColorField.value = field;
};

const closeLyricColorPicker = () => {
  activeLyricColorField.value = null;
};

const applyLyricColor = (value: string) => {
  if (!activeLyricColorField.value) return;
  lyricStore[activeLyricColorField.value] = value;
  closeLyricColorPicker();
};

const resetLyricColors = () => {
  lyricStore.playedColor = '';
  lyricStore.unplayedColor = '';
};

const effectivePlayedColor = computed(() => lyricStore.playedColor || '');
const effectiveUnplayedColor = computed(() => lyricStore.unplayedColor || '');

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
  const index = lyricStore.currentIndex;
  if (!container || index < 0 || isUserScrollingLyrics.value) return;

  const target = container.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
  if (!target) return;

  const offset = target.offsetTop - container.clientHeight / 2 + target.offsetHeight / 2;
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

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }

  copyFeedback.value = true;
  window.setTimeout(() => {
    copyFeedback.value = false;
  }, 1200);
};

const toggleSecondary = () => {
  if (!canToggleSecondary.value) return;
  lyricStore.toggleSecondaryEnabled();
};

const cycleSecondaryMode = () => {
  if (!canCycleSecondaryMode.value) return;
  lyricStore.cycleSecondaryMode();
};

const handleLyricLineClick = (time: number) => {
  playerStore.seek(time);
};

const ensureLyricsForCurrentTrack = () => {
  const track = currentTrack.value;
  if (!track || lyricStore.isLoading) return;

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

const syncPortraitIndex = (nextIndex = 0) => {
  if (artistPortraitUrls.value.length === 0) {
    activePortraitIndex.value = 0;
    return;
  }
  const max = artistPortraitUrls.value.length - 1;
  activePortraitIndex.value = Math.min(Math.max(nextIndex, 0), max);
};

const showPreviousPortrait = () => {
  if (artistPortraitUrls.value.length <= 1) return;
  const total = artistPortraitUrls.value.length;
  activePortraitIndex.value = (activePortraitIndex.value - 1 + total) % total;
};

const showNextPortrait = () => {
  if (artistPortraitUrls.value.length <= 1) return;
  const total = artistPortraitUrls.value.length;
  activePortraitIndex.value = (activePortraitIndex.value + 1) % total;
};

const clearArtistBackdrop = () => {
  artistPortraitUrls.value = [];
  activePortraitIndex.value = 0;
};

const ensureArtistBackdropForCurrentTrack = async () => {
  const requestId = ++artistBackdropRequestId;
  const track = currentTrack.value;
  const lyricHash = currentTrackLyricHash.value;

  if (!settingStore.lyricArtistBackdrop || !track || !lyricHash) {
    clearArtistBackdrop();
    return;
  }

  if (singerPortraitCache.has(lyricHash)) {
    artistPortraitUrls.value = singerPortraitCache.get(lyricHash) ?? [];
    syncPortraitIndex();
    return;
  }

  try {
    const pendingRequest =
      singerPortraitPending.get(lyricHash) ??
      (async () => {
        try {
          const res = await getAudioImages({
            hash: lyricHash,
            audioId: track.fileId,
            albumAudioId: track.mixSongId,
            filename: track.name ?? track.title,
            count: 5,
          });
          const data = Array.isArray((res as { data?: unknown[] })?.data)
            ? ((res as { data?: unknown[] }).data ?? [])
            : [];
          const matchedGroups = data.filter((group) => Array.isArray(group));
          const portraitSet = new Set<string>();
          for (const group of matchedGroups) {
            for (const portraitUrl of resolvePortraitsFromAuthors(group)) {
              portraitSet.add(portraitUrl);
            }
          }
          const portraitUrls = [...portraitSet].slice(0, 5);

          singerPortraitCache.set(lyricHash, portraitUrls);
          return portraitUrls;
        } finally {
          singerPortraitPending.delete(lyricHash);
        }
      })();

    singerPortraitPending.set(lyricHash, pendingRequest);
    const portraitUrls = (await pendingRequest) ?? [];
    if (requestId !== artistBackdropRequestId) return;
    artistPortraitUrls.value = portraitUrls;
    syncPortraitIndex();
  } catch {
    singerPortraitCache.set(lyricHash, []);
    if (requestId !== artistBackdropRequestId) return;
    clearArtistBackdrop();
  }
};

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
  () => {
    void ensureArtistBackdropForCurrentTrack();
  },
  { immediate: true },
);

watch(
  () => lyricStore.lyricsMode,
  async () => {
    await nextTick();
    scrollToCurrentLine(false);
  },
);

const closeLyricPage = async () => {
  await closeTransientView(router, route);
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

onMounted(() => {
  ensureLyricsForCurrentTrack();
  void ensureArtistBackdropForCurrentTrack();
  void nextTick(() => scrollToCurrentLine(false));
  window.addEventListener('keydown', handleKeydown);
  document.addEventListener('click', handleVolumeClickOutside);
});

onUnmounted(() => {
  artistBackdropRequestId += 1;
  clearUserScrollResumeTimer();
  window.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('click', handleVolumeClickOutside);
  if (volumeWheelTimer) clearTimeout(volumeWheelTimer);
});
</script>

<template>
  <div
    class="lyric-view relative h-screen w-screen overflow-hidden bg-[#eef2f7] text-black select-none transition-colors duration-500 dark:bg-[#030406] dark:text-white"
  >
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div v-if="hasPortraitGallery" class="lyric-portrait-backdrop-wrap absolute inset-0" :style="backdropOpacityStyle">
        <img
          :src="activePortraitUrl"
          :alt="`${currentTrack?.artist || '歌手'}写真`"
          class="lyric-portrait-backdrop"
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
        class="absolute inset-0 bg-white/40 transition-colors duration-500 dark:bg-[#04070b]/50"
      ></div>
    </div>

    <OverlayHeader />

    <div class="absolute inset-x-0 bottom-0 top-10 z-10 flex flex-col overflow-hidden">
      <div class="px-6 pb-3 no-drag">
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
                <Icon :icon="iconImage" width="14" height="14" />
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
            <PopoverRoot v-if="hasPortraitGallery">
              <PopoverTrigger as-child>
                <Button variant="unstyled" size="none" type="button" class="lyric-tool-chip" title="背景透明度">
                  <Icon :icon="iconImage" width="14" height="14" />
                  <span>{{ backdropOpacityLabel }}</span>
                </Button>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  class="z-[100] w-[240px] rounded-[24px] border border-black/10 bg-white/70 p-6 shadow-2xl backdrop-blur-xl dark:border-white/20 dark:bg-black/60"
                  :side-offset="8"
                  align="end"
                >
                  <div class="space-y-2 text-black dark:text-white">
                    <div class="flex items-center justify-between text-[13px] font-semibold">
                      <span class="text-black/60 dark:text-white/60">背景透明度</span>
                      <span class="font-mono">{{ backdropOpacityLabel }}</span>
                    </div>
                    <Slider
                      :model-value="settingStore.lyricBackdropOpacity"
                      :min="10"
                      :max="100"
                      :step="5"
                      @update:model-value="(v) => settingStore.lyricBackdropOpacity = v"
                      class="h-1 w-full"
                      track-class="bg-black/15 dark:bg-white/30"
                      range-class="bg-black dark:bg-white"
                      thumb-class="h-3.5 w-3.5 bg-black dark:bg-white shadow-md"
                    />
                  </div>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
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
              <span>写真</span>
            </Button>
            <PopoverRoot>
              <PopoverTrigger as-child>
                <Button variant="unstyled" size="none" type="button" class="lyric-tool-chip">
                  <Icon :icon="iconTypography" width="14" height="14" />
                  <span>字体</span>
                </Button>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  class="z-[100] w-[260px] rounded-[24px] border border-black/10 bg-white/70 p-6 shadow-2xl backdrop-blur-xl dark:border-white/20 dark:bg-black/60"
                  :side-offset="8"
                  align="end"
                >
                  <div class="space-y-6 text-black dark:text-white">
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
                          @click="resetLyricColors"
                        >重置</button>
                      </div>
                      <div class="flex items-center gap-4">
                        <div class="flex items-center gap-2">
                          <span class="text-[12px] font-semibold text-black/50 dark:text-white/50">已播</span>
                          <button
                            type="button"
                            class="lyric-color-swatch"
                            :style="{ backgroundColor: effectivePlayedColor || 'var(--color-primary)' }"
                            @click="openLyricColorPicker('playedColor')"
                          ></button>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="text-[12px] font-semibold text-black/50 dark:text-white/50">未播</span>
                          <button
                            type="button"
                            class="lyric-color-swatch"
                            :style="{ backgroundColor: effectiveUnplayedColor || 'rgba(15,23,42,0.84)' }"
                            @click="openLyricColorPicker('unplayedColor')"
                          ></button>
                        </div>
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
            <div class="lyric-tool-group">
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="lyric-tool-chip lyric-tool-chip-main"
                :class="{ 'is-active': lyricStore.secondaryEnabled && canToggleSecondary }"
                :disabled="!canToggleSecondary"
                @click="toggleSecondary"
              >
                <Icon :icon="iconLanguage" width="14" height="14" />
                <span class="lyric-tool-chip-label" v-text="displayLabel"></span>
              </Button>
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="lyric-tool-chip-inline"
                :disabled="!canCycleSecondaryMode"
                @click.stop="cycleSecondaryMode"
              >
                <Icon :icon="iconChevronUpDown" width="14" height="14" />
              </Button>
            </div>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="lyric-tool-chip"
              :disabled="!hasLyrics"
              @click="copyLyrics"
            >
              <Icon :icon="iconCopy" width="14" height="14" />
              <span>{{ copyFeedback ? '已复制' : '复制' }}</span>
            </Button>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 px-6 pb-2 no-drag">
        <div class="mx-auto flex h-full max-w-[1560px] gap-7">
          <section
            v-if="!hasPortraitGallery"
            class="hidden min-w-[250px] max-w-[420px] flex-[5] items-center justify-center md:flex"
          >
            <div class="lyric-info-card lyric-info-panel">
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
              </div>
            </div>
          </section>

          <section
            class="lyric-panel-surface relative flex min-w-0 flex-col justify-center self-stretch"
            :class="hasPortraitGallery ? 'flex-1' : 'flex-[7]'"
          >
            <!-- 写真模式：歌曲信息浮层 -->
            <div v-if="hasPortraitGallery && currentTrack" class="lyric-photo-song-info">
              <div class="lyric-photo-song-cover">
                <Cover
                  :url="currentTrack?.coverUrl"
                  :size="120"
                  :borderRadius="10"
                  class="h-full w-full"
                />
              </div>
              <div class="lyric-photo-song-meta">
                <span class="lyric-photo-song-title">{{ currentTrack?.title || '未在播放' }}</span>
                <span class="lyric-photo-song-artist">{{ currentTrack?.artist || '' }}</span>
              </div>
            </div>

            <div class="lyric-stage absolute inset-0">
              <div
                ref="lyricListRef"
                class="lyric-scroll absolute inset-0 overflow-y-auto"
                @wheel.passive="handleLyricWheel"
              >
                <template v-if="hasLyrics">
                  <div class="py-[40vh]">
                    <div
                      v-for="(line, index) in lyricStore.lines"
                      :key="line.time"
                      class="lyric-row"
                      :data-lyric-index="index"
                      :style="{
                        minHeight:
                          (lyricStore.lyricsMode === 'both'
                            ? 108
                            : lyricStore.lyricsMode === 'translation' ||
                                lyricStore.lyricsMode === 'romanization'
                              ? 84
                              : 56) *
                            lyricStore.fontScale +
                          'px',
                        paddingTop: '8px',
                        paddingBottom: '8px',
                      }"
                    >
                      <div
                        :class="['lyric-line', currentIndex === index ? 'is-current' : 'is-idle']"
                        @click="handleLyricLineClick(line.time)"
                      >
                        <span
                          class="block leading-[1.24] tracking-[0.01em]"
                          :style="{
                            fontSize: titleFontSize,
                            fontWeight: String(lyricStore.fontWeightValue),
                          }"
                        >
                          <template v-if="currentIndex === index && line.characters.length > 1">
                            <span
                              v-for="char in line.characters"
                              :key="`${char.startTime}`"
                              class="lyric-character"
                              :class="char.highlighted ? 'is-highlighted' : ''"
                              :style="char.highlighted && effectivePlayedColor ? { color: effectivePlayedColor } : (!char.highlighted && effectiveUnplayedColor ? { color: effectiveUnplayedColor } : undefined)"
                              >{{ char.text }}</span
                            >
                          </template>
                          <template v-else>
                            <span v-if="currentIndex === index && effectiveUnplayedColor" :style="{ color: effectiveUnplayedColor }">{{ line.text }}</span>
                            <template v-else>{{ line.text }}</template>
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
                            }"
                          >
                            {{ line.translated.trim() }}
                          </span>
                          <span
                            v-if="line.romanized?.trim()"
                            class="lyric-subline mt-1 block max-w-full truncate"
                            :style="{
                              fontSize: secondaryFontSize,
                              fontWeight: String(
                                currentIndex === index
                                  ? Math.max(500, lyricStore.fontWeightValue - 200)
                                  : 400,
                              ),
                              opacity: 0.72,
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

      <div class="px-6 pb-4 pt-1 no-drag">
        <div class="lyric-controls-surface mx-auto flex w-full max-w-[820px] flex-col">
          <!-- 核心播放控制行 -->
          <div class="flex items-center justify-center gap-6 self-center">
              <Tooltip :content="playModeLabel" side="top">
                <template #trigger>
                  <Button variant="unstyled" size="none" type="button" class="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95" @click="cyclePlayMode">
                    <Icon :icon="playModeIcon" width="21" height="21" class="text-black/55 dark:text-white/55" />
                  </Button>
                </template>
              </Tooltip>
              <Button variant="unstyled" size="none" type="button" class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95" title="上一曲" @click="playerStore.prev()">
                <Icon :icon="iconSkipBack" width="24" height="24" class="text-black/80 dark:text-white/80" />
              </Button>
              <Button variant="unstyled" size="none" type="button" class="lyric-main-play-btn flex h-14 w-14 items-center justify-center rounded-full transition-all active:scale-95" :title="playerStore.isPlaying ? '暂停' : '播放'" @click="playerStore.togglePlay()">
                <Icon :icon="playerStore.isPlaying ? iconPause : iconPlay" width="24" height="24" class="text-black dark:text-white" />
              </Button>
              <Button variant="unstyled" size="none" type="button" class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95" title="下一曲" @click="playerStore.next()">
                <Icon :icon="iconSkipForward" width="24" height="24" class="text-black/80 dark:text-white/80" />
              </Button>
              <!-- 音量 -->
              <div ref="volumeContainerRef" class="relative flex items-center" @wheel.prevent="handleVolumeWheel">
                <Button variant="unstyled" size="none" type="button" class="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95" @click="toggleVolume">
                  <Icon :icon="volumeIcon" width="21" height="21" class="text-black/55 dark:text-white/55" />
                </Button>
                <Transition name="volume-pop">
                  <div v-show="isVolumeVisible" class="absolute bottom-[100%] left-1/2 -translate-x-1/2 pb-2 z-[100]" @click.stop>
                    <div class="rounded-2xl border border-black/10 bg-white/70 p-3 shadow-xl backdrop-blur-xl dark:border-white/20 dark:bg-black/60">
                      <div class="flex h-36 flex-col items-center gap-2">
                        <SliderRoot :model-value="[playerStore.volume * 100]" :max="100" orientation="vertical" class="relative flex flex-col items-center select-none touch-none w-5 h-full" @update:model-value="handleVolumeChange">
                          <SliderTrack class="relative grow rounded-full w-[3px] bg-black/15 dark:bg-white/30">
                            <SliderRange class="absolute bg-black dark:bg-white rounded-full w-full" />
                          </SliderTrack>
                          <SliderThumb class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none" />
                        </SliderRoot>
                        <Button variant="unstyled" size="none" type="button" class="p-1 text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white transition-colors" @click="toggleMute">
                          <Icon :icon="volumeIcon" width="18" height="18" />
                        </Button>
                        <span class="text-[10px] font-semibold text-black/50 dark:text-white/50 tabular-nums">{{ Math.round(playerStore.volume * 100) }}</span>
                      </div>
                    </div>
                  </div>
                </Transition>
              </div>
          </div>

          <!-- 进度条行 -->
          <div class="mt-2 w-full" style="display: grid; grid-template-columns: 1fr minmax(0, 420px) 1fr; align-items: center; gap: 4px;">
            <!-- 左列 -->
            <div class="flex items-center justify-start">
              <Tooltip :content="isFavorite ? '取消收藏' : '收藏'" side="top">
                <template #trigger>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-all hover:scale-110 active:scale-90" @click="toggleFavorite">
                    <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" :class="isFavorite ? 'text-red-500' : 'text-black/40 dark:text-white/40'" />
                  </Button>
                </template>
              </Tooltip>
              <Tooltip v-if="canAddToPlaylist" content="添加到" side="top">
                <template #trigger>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-all hover:scale-110 active:scale-90 text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white" @click="handleOpenAddToPlaylist">
                    <Icon :icon="iconPlaylistAdd" width="20" height="20" />
                  </Button>
                </template>
              </Tooltip>
            </div>

            <!-- 中列：进度条 -->
            <div class="min-w-0 flex items-center gap-2">
              <span class="w-[38px] text-right font-mono text-[11px] font-semibold text-black/40 dark:text-white/40 shrink-0">
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
                <SliderTrack class="bg-black/10 dark:bg-white/10 relative grow rounded-full h-[3px]">
                  <div class="climax-mark-layer">
                    <template v-for="(mark, index) in playerStore.climaxMarks" :key="`${mark.start}-${index}`">
                      <span class="climax-tick" :style="{ left: `calc(${(mark.start * 100).toFixed(3)}% - 1px)` }"></span>
                      <span v-if="mark.end > mark.start" class="climax-tick" :style="{ left: `calc(${(mark.end * 100).toFixed(3)}% - 1px)` }"></span>
                    </template>
                  </div>
                  <SliderRange class="absolute bg-black dark:bg-white rounded-full h-full" />
                </SliderTrack>
                <SliderThumb
                  class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none transition-all duration-200"
                  :class="[isHoveringProgress ? 'opacity-100 scale-110' : 'opacity-0 scale-50']"
                />
              </SliderRoot>
              <span class="w-[38px] text-left font-mono text-[11px] font-semibold text-black/40 dark:text-white/40 shrink-0">
                {{ formatDuration(playerStore.duration) }}
              </span>
            </div>

            <!-- 右列 -->
            <div class="flex items-center justify-end gap-1 select-none">
              <!-- 倍速 -->
              <PopoverRoot>
                <PopoverTrigger as-child>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-colors" :class="playerStore.playbackRate !== 1 ? 'text-black dark:text-white' : 'text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70'" title="播放倍速">
                    <Icon :icon="iconSpeedometer" width="20" height="20" />
                  </Button>
                </PopoverTrigger>
                <PopoverPortal>
                  <PopoverContent class="lyric-popover lyric-popover--speed" :side-offset="8" align="end" side="top">
                    <div class="space-y-3">
                      <div class="flex items-center justify-between">
                        <span class="text-[11px] font-bold opacity-50">播放倍速</span>
                        <Button variant="unstyled" size="none" class="text-[13px] font-extrabold px-1.5 py-0.5 rounded-md transition-colors" :class="playerStore.playbackRate === 1 ? 'opacity-40' : 'hover:bg-black/5 dark:hover:bg-white/10'" @click="resetPlaybackRate">{{ playbackRateDisplay }}</Button>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] font-semibold opacity-40 shrink-0">0.1</span>
                        <SliderRoot class="relative flex items-center select-none touch-none flex-1 h-5" :model-value="[Math.round(playerStore.playbackRate * 10)]" :min="1" :max="50" :step="1" orientation="horizontal" @update:model-value="handlePlaybackRateSlider">
                          <SliderTrack class="relative grow rounded-full h-[3px] bg-black/12 dark:bg-white/15">
                            <SliderRange class="absolute h-full rounded-full bg-black dark:bg-white" />
                          </SliderTrack>
                          <SliderThumb class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none" />
                        </SliderRoot>
                        <span class="text-[10px] font-semibold opacity-40 shrink-0">5x</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <Button v-for="r in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]" :key="r" variant="unstyled" size="none" class="text-[11px] font-semibold px-2 py-1 rounded-md transition-colors" :class="Math.abs(playerStore.playbackRate - r) < 0.01 ? 'bg-black/10 dark:bg-white/15' : 'opacity-50 hover:bg-black/5 dark:hover:bg-white/8 hover:opacity-100'" @click="setPlaybackRate(r)">{{ r === Math.floor(r) ? r.toFixed(1) : r }}x</Button>
                      </div>
                    </div>
                  </PopoverContent>
                </PopoverPortal>
              </PopoverRoot>
              <!-- 音质 -->
              <PopoverRoot>
                <PopoverTrigger as-child>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-colors" :class="playerStore.currentAudioQualityOverride !== null || playerStore.audioEffect !== 'none' ? 'text-black dark:text-white' : 'text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70'" title="音质">
                    <span class="relative inline-flex w-5 h-5 items-center justify-center">
                      <AudioWaveIcon class="w-5 h-5" style="transform: translateY(3px)" />
                      <Badge v-if="currentTrack" :count="audioQualityButtonBadge" class="absolute -top-2" :style="{ right: '-12px', color: '#FFF', backgroundColor: currentAudioQualityBadgeColor }" />
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverPortal>
                  <PopoverContent class="lyric-popover lyric-popover--quality" :side-offset="8" align="end" side="top">
                    <div class="space-y-1">
                      <div class="text-[11px] font-bold opacity-50 px-2 pb-1">音质选择</div>
                      <button v-for="q in (['128', '320', 'flac', 'high'] as const)" :key="q" type="button" class="lyric-quality-item" :class="{ 'is-active': effectiveAudioQuality === q, 'is-disabled': isAudioQualityDisabled(q) && effectiveAudioQuality !== q }" :disabled="isAudioQualityDisabled(q) && effectiveAudioQuality !== q" @click="setAudioQuality(q)">
                        <span class="lyric-quality-label">{{ q === '128' ? '标准' : q === '320' ? '高品质' : q === 'flac' ? '无损' : 'Hi-Res' }}</span>
                        <Tag class="lyric-quality-tag" :color="getAudioQualityTagColor(q)">{{ q === '128' ? 'SD' : q === '320' ? 'HQ' : q === 'flac' ? 'SQ' : 'HR' }}</Tag>
                        <span class="lyric-quality-check" :class="{ 'is-visible': effectiveAudioQuality === q }">✓</span>
                      </button>
                      <div class="h-px bg-current opacity-8 my-1"></div>
                      <div class="text-[11px] font-bold opacity-50 px-2 pb-1">音效</div>
                      <button v-for="fx in (['none', 'piano', 'acappella', 'subwoofer', 'ancient'] as const)" :key="fx" type="button" class="lyric-quality-item" :class="{ 'is-active': playerStore.audioEffect === fx }" @click="setAudioEffect(fx)">
                        <span class="lyric-quality-label">{{ fx === 'none' ? '原声' : fx === 'piano' ? '钢琴' : fx === 'acappella' ? '人声' : fx === 'subwoofer' ? '骨笛' : '尤克里里' }}</span>
                        <span class="lyric-quality-check" :class="{ 'is-visible': playerStore.audioEffect === fx }">✓</span>
                      </button>
                    </div>
                  </PopoverContent>
                </PopoverPortal>
              </PopoverRoot>
              <!-- 桌面歌词 -->
              <Tooltip :content="desktopLyricStore.settings.enabled ? '关闭桌面歌词' : '开启桌面歌词'" side="top">
                <template #trigger>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-colors" :class="desktopLyricStore.settings.enabled ? 'text-black dark:text-white' : 'text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70'" @click="toggleDesktopLyric">
                    <Icon :icon="iconTypography" width="20" height="20" />
                  </Button>
                </template>
              </Tooltip>
              <!-- 播放列表 -->
              <Tooltip content="播放列表" side="top">
                <template #trigger>
                  <Button variant="unstyled" size="none" type="button" class="p-2 transition-colors text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70" @click="isQueueDrawerOpen = true">
                    <Icon :icon="iconList" width="22" height="22" />
                  </Button>
                </template>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>

    <PlayerQueueDrawer v-model:open="isQueueDrawerOpen" />

    <Dialog
      v-model:open="showAddToPlaylistDialog"
      title="添加到"
      contentClass="max-w-[420px]"
      showClose
    >
      <div class="lyric-add-playlist-body">
        <div class="lyric-add-playlist-divider"><span>播放列表</span></div>
        <div v-if="addToPlaybackQueues.length === 0" class="lyric-add-playlist-status">暂无播放列表</div>
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
            {{ queue.title || '播放列表' }}
          </span>
          <span class="lyric-add-playlist-count">{{ queue.songs.length }} 首</span>
        </Button>
        <div class="lyric-add-playlist-divider"><span>歌单</span></div>
        <div v-if="isPlaylistLoading" class="lyric-add-playlist-status">加载歌单中...</div>
        <div v-else-if="createdPlaylists.length === 0" class="lyric-add-playlist-status">暂无可用歌单</div>
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
      :open="activeLyricColorField !== null"
      :title="activeLyricColorField === 'unplayedColor' ? '选择未播字色' : '选择已播字色'"
      :value="activeLyricColorValue"
      :presets="lyricColorPresets"
      @update:open="(open) => !open && closeLyricColorPicker()"
      @confirm="applyLyricColor"
    />
  </div>
</template>

<style>
/* 歌词页弹出层通用 */
.lyric-popover {
  z-index: 100;
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

.lyric-popover--speed {
  width: 320px;
  padding: 14px 16px 12px;
}

.lyric-popover--quality {
  width: 190px;
  padding: 10px 6px;
}

/* 音质列表项 */
.lyric-quality-item {
  display: flex;
  align-items: center;
  width: calc(100% - 8px);
  margin: 0 4px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: inherit;
  opacity: 0.7;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}

.lyric-quality-item:hover {
  background: rgba(0, 0, 0, 0.05);
  opacity: 1;
}

.dark .lyric-quality-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.lyric-quality-item.is-active {
  background: rgba(0, 113, 227, 0.1);
  opacity: 1;
}

.dark .lyric-quality-item.is-active {
  background: rgba(0, 113, 227, 0.2);
}

.lyric-quality-item.is-disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.lyric-quality-item.is-disabled:hover {
  background: transparent;
}

.lyric-quality-label {
  flex: 1;
  text-align: left;
}

.lyric-quality-tag {
  font-size: 9px;
  padding: 0 4px;
  margin-right: 6px;
}

.lyric-quality-check {
  width: 14px;
  text-align: right;
  font-size: 12px;
  opacity: 0;
}

.lyric-quality-check.is-visible {
  opacity: 1;
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

.dark .lyric-portrait-backdrop {
  opacity: 0.88;
  filter: saturate(0.88) brightness(0.86) contrast(1.06);
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
  background: linear-gradient(
    180deg,
    rgba(0, 0, 0, 0.15) 0%,
    rgba(0, 0, 0, 0.05) 40%,
    rgba(0, 0, 0, 0.05) 60%,
    rgba(0, 0, 0, 0.25) 100%
  );
}

.dark .lyric-portrait-overlay {
  background: linear-gradient(
    180deg,
    rgba(0, 0, 0, 0.3) 0%,
    rgba(0, 0, 0, 0.12) 40%,
    rgba(0, 0, 0, 0.12) 60%,
    rgba(0, 0, 0, 0.4) 100%
  );
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
  backdrop-filter: blur(18px);
  transition: all 0.2s ease;
}

.lyric-icon-btn:hover,
.lyric-tool-chip:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.56);
}

.lyric-tool-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.26);
  box-shadow: 0 12px 28px rgba(148, 163, 184, 0.1);
  backdrop-filter: blur(18px);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: all 0.2s ease;
}

.lyric-tool-group {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 3px;
  height: 39.5px;
  box-sizing: border-box;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  box-shadow: 0 12px 28px rgba(148, 163, 184, 0.1);
  backdrop-filter: blur(18px);
}

.lyric-tool-chip-main {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: max-content;
  flex-shrink: 0;
  height: 33.5px;
  padding: 0 16px;
  box-shadow: none;
  background: transparent;
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
  gap: 8px;
  min-width: 88px;
  justify-content: center;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 700;
  color: rgba(15, 23, 42, 0.84);
}

.lyric-tool-chip.is-active {
  background: rgba(255, 255, 255, 0.78);
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
  background: rgba(255, 255, 255, 0.34);
  box-shadow: none;
  backdrop-filter: blur(18px);
  opacity: 0.92;
  transition: all 0.2s ease;
}

.lyric-tool-chip-inline:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.62);
}

.dark .lyric-tool-chip,
.dark .lyric-icon-btn {
  background: rgba(22, 30, 44, 0.82);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .lyric-tool-group {
  background: rgba(14, 18, 26, 0.66);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .lyric-tool-chip-inline {
  background: rgba(28, 36, 52, 0.92);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: none;
}

.dark .lyric-tool-chip.is-active {
  background: rgba(40, 54, 78, 0.96);
  box-shadow: inset 0 0 0 1px rgba(147, 197, 253, 0.2);
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
  background: rgba(36, 48, 70, 0.94);
}

.dark .lyric-tool-chip:disabled,
.dark .lyric-weight-btn:disabled {
  opacity: 0.5;
  background: rgba(18, 24, 36, 0.72);
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
  padding: 8px 12px 6px;
}

.lyric-main-play-btn {
  background: rgba(255, 255, 255, 0.5);
  box-shadow: 0 12px 32px rgba(148, 163, 184, 0.16);
}

.lyric-main-play-btn:hover {
  background: rgba(255, 255, 255, 0.76);
}

.dark .lyric-main-play-btn {
  background: rgba(10, 14, 20, 0.82);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
}

.dark .lyric-main-play-btn:hover {
  background: rgba(15, 20, 28, 0.92);
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

/* 写真模式歌曲信息浮层 */
.lyric-photo-song-info {
  position: absolute;
  left: 24px;
  bottom: 8px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px 8px 8px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.32);
  backdrop-filter: blur(18px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  max-width: 360px;
}

.dark .lyric-photo-song-info {
  background: rgba(10, 14, 20, 0.52);
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
  color: rgba(15, 23, 42, 0.92);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .lyric-photo-song-title {
  color: rgba(255, 255, 255, 0.92);
}

.lyric-photo-song-artist {
  font-size: 12px;
  font-weight: 500;
  color: rgba(15, 23, 42, 0.56);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .lyric-photo-song-artist {
  color: rgba(255, 255, 255, 0.56);
}

.lyric-stage {
  min-height: 0;
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
  scrollbar-width: none;
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
  padding: 12px 24px;
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
  opacity: 0.52;
  transform: scale(0.965) translateY(4px);
}

.lyric-line.is-idle > span:first-child {
  color: rgba(15, 23, 42, 0.34);
}

.dark .lyric-line.is-idle > span:first-child {
  color: rgba(255, 255, 255, 0.3);
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

.lyric-character {
  transition: color 0.18s ease;
  color: rgba(15, 23, 42, 0.84);
}

.dark .lyric-character {
  color: rgba(255, 255, 255, 0.94);
}

.lyric-line.is-idle .lyric-character {
  color: rgba(15, 23, 42, 0.34);
}

.dark .lyric-line.is-idle .lyric-character {
  color: rgba(255, 255, 255, 0.3);
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

.volume-pop-enter-active,
.volume-pop-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.volume-pop-enter-from,
.volume-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
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
  transition: color 0.2s ease, border-color 0.2s ease;
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
</style>
