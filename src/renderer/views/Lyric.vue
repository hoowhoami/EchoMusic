<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
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
import { formatDuration } from '@/utils/format';
import { closeTransientView } from '@/utils/navigation';
import { getCoverUrl } from '@/utils/cover';
import Button from '@/components/ui/Button.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import {
  iconChevronDown,
  iconCopy,
  iconLanguage,
  iconChevronUpDown,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
  iconTypography,
  iconRepeat,
  iconRepeatOff,
  iconShuffle,
  iconListRestart,
  iconVolume2,
  iconVolume1,
  iconVolumeX,
} from '@/icons';
import type { PlayMode } from '@/types';

const router = useRouter();
const route = useRoute();
const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const lyricStore = useLyricStore();

const lyricListRef = ref<HTMLElement | null>(null);
const progressValue = ref(0);
const isProgressDragging = ref(false);
const isHoveringProgress = ref(false);
const copyFeedback = ref(false);
const isUserScrollingLyrics = ref(false);
let userScrollResumeTimer: number | null = null;

const playModeLabel = computed(() => {
  const labels: Record<PlayMode, string> = {
    sequential: '顺序播放',
    list: '列表循环',
    random: '随机播放',
    single: '单曲循环',
  };
  return labels[playerStore.playMode] ?? '顺序播放';
});

const playModeIcon = computed(() => {
  if (playerStore.playMode === 'sequential') return iconRepeatOff;
  if (playerStore.playMode === 'list') return iconRepeat;
  if (playerStore.playMode === 'random') return iconShuffle;
  return iconListRestart;
});

const volumeIcon = computed(() => {
  if (playerStore.volume > 0.5) return iconVolume2;
  if (playerStore.volume > 0) return iconVolume1;
  return iconVolumeX;
});

const lastVolume = ref(0.8);
const isVolumeVisible = ref(false);
const volumeContainerRef = ref<HTMLElement | null>(null);
let volumeWheelTimer: ReturnType<typeof setTimeout> | null = null;

const cyclePlayMode = () => {
  const next: PlayMode =
    playerStore.playMode === 'sequential'
      ? 'list'
      : playerStore.playMode === 'list'
        ? 'random'
        : playerStore.playMode === 'random'
          ? 'single'
          : 'sequential';
  playerStore.setPlayMode(next);
};

const handleVolumeChange = (value: number[] | undefined) => {
  if (!value?.length) return;
  playerStore.setVolume(value[0] / 100);
};

const toggleMute = () => {
  if (playerStore.volume > 0) {
    lastVolume.value = playerStore.volume;
    playerStore.setVolume(0);
  } else {
    playerStore.setVolume(lastVolume.value || 0.8);
  }
};

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

const currentTrack = computed<Song | undefined>(() => {
  const currentId = String(playerStore.currentTrackId ?? '');
  if (!currentId) return undefined;
  return (
    playlistStore.defaultList.find((song) => String(song.id) === currentId) ||
    playlistStore.favorites.find((song) => String(song.id) === currentId) ||
    playerStore.currentTrackSnapshot ||
    undefined
  );
});

const backgroundUrl = computed(() => getCoverUrl(currentTrack.value?.coverUrl, 900));
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
  void nextTick(() => scrollToCurrentLine(false));
  window.addEventListener('keydown', handleKeydown);
  document.addEventListener('click', handleVolumeClickOutside);
});

onUnmounted(() => {
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
      <div
        class="absolute inset-[-6%] scale-[1.06] bg-cover bg-center opacity-[0.18] blur-[2px] transition-all duration-500 dark:opacity-[0.22]"
        :style="{ backgroundImage: backgroundUrl ? `url(${backgroundUrl})` : undefined }"
      ></div>
      <div class="lyric-atmosphere absolute inset-0"></div>
      <div
        class="absolute inset-0 bg-gradient-to-b from-white/72 via-white/48 to-white/84 transition-colors duration-500 dark:from-black/88 dark:via-black/72 dark:to-black/92"
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
            class="lyric-panel-surface relative flex min-w-0 flex-[7] flex-col justify-center self-stretch"
          >
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
                              >{{ char.text }}</span
                            >
                          </template>
                          <template v-else>
                            {{ line.text }}
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

      <div class="px-6 pb-6 pt-2 no-drag">
        <div class="lyric-controls-surface mx-auto flex w-full max-w-[560px] flex-col items-center">
          <div class="flex items-center justify-center gap-8">
            <!-- 播放模式 -->
            <Tooltip :content="playModeLabel" side="top">
              <template #trigger>
                <Button
                  variant="unstyled"
                  size="none"
                  type="button"
                  class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95"
                  @click="cyclePlayMode"
                >
                  <Icon
                    :icon="playModeIcon"
                    width="22"
                    height="22"
                    class="text-black/60 dark:text-white/60"
                  />
                </Button>
              </template>
            </Tooltip>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95"
              title="上一曲"
              @click="playerStore.prev()"
            >
              <Icon
                :icon="iconSkipBack"
                width="24"
                height="24"
                class="text-black/80 dark:text-white/80"
              />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="lyric-main-play-btn flex h-14 w-14 items-center justify-center rounded-full transition-all active:scale-95"
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
              class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95"
              title="下一曲"
              @click="playerStore.next()"
            >
              <Icon
                :icon="iconSkipForward"
                width="24"
                height="24"
                class="text-black/80 dark:text-white/80"
              />
            </Button>
            <!-- 音量 -->
            <div
              ref="volumeContainerRef"
              class="relative flex items-center"
              @wheel.prevent="handleVolumeWheel"
            >
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10 active:scale-95"
                @click="toggleVolume"
              >
                <Icon
                  :icon="volumeIcon"
                  width="22"
                  height="22"
                  class="text-black/60 dark:text-white/60"
                />
              </Button>
              <Transition name="volume-pop">
                <div
                  v-show="isVolumeVisible"
                  class="absolute bottom-[100%] left-1/2 -translate-x-1/2 pb-2 z-[100]"
                  @click.stop
                >
                  <div
                    class="rounded-2xl border border-black/10 bg-white/70 p-3 shadow-xl backdrop-blur-xl dark:border-white/20 dark:bg-black/60"
                  >
                    <div class="flex h-36 flex-col items-center gap-2">
                      <SliderRoot
                        :model-value="[playerStore.volume * 100]"
                        :max="100"
                        orientation="vertical"
                        class="relative flex flex-col items-center select-none touch-none w-5 h-full"
                        @update:model-value="handleVolumeChange"
                      >
                        <SliderTrack
                          class="relative grow rounded-full w-[3px] bg-black/15 dark:bg-white/30"
                        >
                          <SliderRange
                            class="absolute bg-black dark:bg-white rounded-full w-full"
                          />
                        </SliderTrack>
                        <SliderThumb
                          class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none"
                        />
                      </SliderRoot>
                      <Button
                        variant="unstyled"
                        size="none"
                        type="button"
                        class="p-1 text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white transition-colors"
                        @click="toggleMute"
                      >
                        <Icon :icon="volumeIcon" width="18" height="18" />
                      </Button>
                      <span
                        class="text-[10px] font-semibold text-black/50 dark:text-white/50 tabular-nums"
                        >{{ Math.round(playerStore.volume * 100) }}</span
                      >
                    </div>
                  </div>
                </div>
              </Transition>
            </div>
          </div>

          <div class="mt-4 flex w-[420px] max-w-full items-center gap-3">
            <span
              class="w-[42px] text-right font-mono text-[11px] font-semibold text-black/40 dark:text-white/40"
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
              <SliderTrack class="bg-black/10 dark:bg-white/10 relative grow rounded-full h-[3px]">
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
                class="block w-3 h-3 bg-black dark:bg-white rounded-full shadow-md focus-visible:outline-none transition-all duration-200"
                :class="[isHoveringProgress ? 'opacity-100 scale-110' : 'opacity-0 scale-50']"
              />
            </SliderRoot>
            <span
              class="w-[42px] text-left font-mono text-[11px] font-semibold text-black/40 dark:text-white/40"
            >
              {{ formatDuration(playerStore.duration) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.lyric-atmosphere {
  background:
    radial-gradient(44% 34% at 18% 24%, rgba(255, 255, 255, 0.76), transparent 72%),
    radial-gradient(28% 24% at 82% 18%, rgba(0, 113, 227, 0.1), transparent 74%),
    radial-gradient(48% 42% at 50% 100%, rgba(255, 255, 255, 0.36), transparent 78%);
}

.dark .lyric-atmosphere {
  background:
    radial-gradient(40% 34% at 16% 22%, rgba(37, 99, 235, 0.12), transparent 72%),
    radial-gradient(34% 28% at 84% 18%, rgba(255, 255, 255, 0.03), transparent 75%),
    radial-gradient(52% 48% at 50% 100%, rgba(0, 0, 0, 0.58), transparent 78%);
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

.dark .lyric-info-card {
}

.lyric-panel-surface {
}

.dark .lyric-panel-surface {
}

.lyric-controls-surface {
  padding: 16px 12px 10px;
}

.dark .lyric-controls-surface {
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
}

.dark .lyric-cover-frame {
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.45);
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
</style>
