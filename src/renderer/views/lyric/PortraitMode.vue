<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useThrottleFn } from '@vueuse/core';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useSettingStore } from '@/stores/setting';
import { useLyricPortrait } from '@/composables/useLyricPortrait';
import LyricScroller from './LyricScroller.vue';

const { currentTrack } = usePlayerControls();
const settingStore = useSettingStore();

const currentTrackLyricHash = computed(() =>
  String(currentTrack.value?.hash ?? currentTrack.value?.id ?? '').trim(),
);

// 写真
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

// ── 收起逻辑 ──
const isLyricCollapsed = ref(false);
let collapseTimer: number | null = null;

const clearCollapseTimer = () => {
  if (collapseTimer !== null) {
    window.clearTimeout(collapseTimer);
    collapseTimer = null;
  }
};

const scheduleCollapse = () => {
  clearCollapseTimer();
  if (!settingStore.lyricAutoCollapseEnabled) return;
  const delay = Math.max(settingStore.lyricAutoCollapseDelay || 5, 5) * 1000;
  collapseTimer = window.setTimeout(() => {
    collapseTimer = null;
    isLyricCollapsed.value = true;
  }, delay);
};

const handleCollapseClick = () => {
  isLyricCollapsed.value = !isLyricCollapsed.value;
  if (!isLyricCollapsed.value) {
    scheduleCollapse();
  }
};

// 鼠标活动
const isMouseActive = ref(false);
let mouseActiveTimer: number | null = null;

const handleMouseMove = useThrottleFn(() => {
  isMouseActive.value = true;
  if (mouseActiveTimer) window.clearTimeout(mouseActiveTimer);
  mouseActiveTimer = window.setTimeout(() => {
    isMouseActive.value = false;
    mouseActiveTimer = null;
  }, 3000);
  if (!isLyricCollapsed.value) scheduleCollapse();
}, 200);

// 滚轮展开
const handleWheel = () => {
  if (isLyricCollapsed.value) {
    isLyricCollapsed.value = false;
  }
  scheduleCollapse();
};

watch(
  () => [currentTrack.value?.id],
  () => void ensureArtistBackdropForCurrentTrack(),
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

onMounted(() => {
  void ensureArtistBackdropForCurrentTrack();
  setTimeout(() => scheduleCollapse(), 500);
});

onUnmounted(() => {
  disposePortrait();
  clearCollapseTimer();
  if (mouseActiveTimer) window.clearTimeout(mouseActiveTimer);
});

defineExpose({
  isLyricCollapsed,
  handleCollapseClick,
  artistPortraitUrls,
  portraitCounterLabel,
  showPreviousPortrait,
  showNextPortrait,
  isMouseActive,
});
</script>

<template>
  <div class="portrait-mode" @mousemove="handleMouseMove" @wheel.passive="handleWheel">
    <!-- 写真背景 -->
    <div class="portrait-backdrop">
      <img
        v-if="activePortraitUrl"
        :src="activePortraitUrl"
        :alt="`${currentTrack?.artist || '歌手'}写真`"
        class="portrait-img"
      />
      <div
        v-else-if="currentTrack?.coverUrl"
        class="portrait-fallback"
        :style="{ backgroundImage: `url(${currentTrack.coverUrl})` }"
      ></div>
    </div>

    <!-- 遮罩层 -->
    <div class="portrait-overlay"></div>

    <!-- 歌词区域 -->
    <div class="portrait-lyric-area">
      <LyricScroller :collapsed="isLyricCollapsed" />
    </div>

    <!-- 收起时点击展开的遮罩 -->
    <div v-if="isLyricCollapsed" class="portrait-expand-overlay" @click="handleCollapseClick"></div>
  </div>
</template>

<style scoped>
.portrait-mode {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  z-index: 2;
}

.portrait-backdrop {
  position: fixed;
  inset: 0;
  overflow: hidden;
  z-index: 0;
  pointer-events: none;
  background: #000;
}

.portrait-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  user-select: none;
}

.portrait-fallback {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  filter: blur(40px) saturate(0.8) brightness(0.6);
  transform: scale(1.1);
}

.portrait-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
  z-index: 1;
}

.portrait-lyric-area {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 10;
}

.portrait-expand-overlay {
  position: absolute;
  inset: 0;
  z-index: 9;
  cursor: pointer;
}
</style>
