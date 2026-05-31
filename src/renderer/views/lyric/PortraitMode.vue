<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useThrottleFn } from '@vueuse/core';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useSettingStore } from '@/stores/setting';
import { useLyricPortrait } from '@/composables/useLyricPortrait';
import { useLyricBackground } from './composables/useLyricBackground';
import LyricScroller from './LyricScroller.vue';

const { currentTrack } = usePlayerControls();
const settingStore = useSettingStore();

const currentTrackLyricHash = computed(() =>
  String(currentTrack.value?.hash ?? currentTrack.value?.id ?? '').trim(),
);

// 背景主题色（无写真时使用）
const coverUrl = computed(() => currentTrack.value?.coverUrl);
const { backgroundColor } = useLyricBackground(coverUrl);

// 模糊封面背景（无写真时的备选背景）
const blurCoverUrl = computed(() => {
  if (!settingStore.lyricPageBackgroundBlur || !coverUrl.value) return '';
  const url = coverUrl.value;
  return url.replace(/\{size\}/g, '400').replace(/\/\d+(?=\/\d{8}\/)/, '/400');
});

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

const portraitLayers = ref<[string, string]>(['', '']);
const visiblePortraitLayer = ref<0 | 1>(0);
const hasVisiblePortrait = computed(() =>
  Boolean(portraitLayers.value[0] || portraitLayers.value[1]),
);
const blurLayers = ref<[string, string]>(['', '']);
const visibleBlurLayer = ref<0 | 1>(0);
const hasVisibleBlur = computed(() => Boolean(blurLayers.value[0] || blurLayers.value[1]));

let portraitSwapToken = 0;
let portraitCleanupTimer: number | null = null;
let blurSwapToken = 0;
let blurCleanupTimer: number | null = null;

const clearPortraitCleanupTimer = () => {
  if (portraitCleanupTimer !== null) {
    window.clearTimeout(portraitCleanupTimer);
    portraitCleanupTimer = null;
  }
};

const clearBlurCleanupTimer = () => {
  if (blurCleanupTimer !== null) {
    window.clearTimeout(blurCleanupTimer);
    blurCleanupTimer = null;
  }
};

const preloadImage = async (url: string) => {
  if (!url) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;

  if (img.complete) {
    await img.decode?.().catch(() => {});
    return;
  }

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('portrait-image-load-failed'));
  });

  await img.decode?.().catch(() => {});
};

const clearPortraitLayers = () => {
  clearPortraitCleanupTimer();
  portraitLayers.value = ['', ''];
  visiblePortraitLayer.value = 0;
};

const clearBlurLayers = () => {
  clearBlurCleanupTimer();
  blurLayers.value = ['', ''];
  visibleBlurLayer.value = 0;
};

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
  currentTrackLyricHash,
  () => {
    // 切歌时旧写真立即失效，宁可先退回新歌封面/底色，也不让用户感知到串图。
    portraitSwapToken += 1;
    clearPortraitLayers();
  },
  { immediate: true },
);

watch(
  activePortraitUrl,
  async (url) => {
    const normalizedUrl = String(url ?? '').trim();
    const token = ++portraitSwapToken;

    if (!normalizedUrl) {
      clearPortraitLayers();
      return;
    }

    const currentVisibleUrl = portraitLayers.value[visiblePortraitLayer.value];
    if (normalizedUrl === currentVisibleUrl) return;

    try {
      await preloadImage(normalizedUrl);
      if (token !== portraitSwapToken) return;

      const nextLayer = (visiblePortraitLayer.value === 0 ? 1 : 0) as 0 | 1;
      const currentLayer = visiblePortraitLayer.value;

      portraitLayers.value[nextLayer] = normalizedUrl;
      visiblePortraitLayer.value = nextLayer;

      clearPortraitCleanupTimer();
      portraitCleanupTimer = window.setTimeout(() => {
        if (token !== portraitSwapToken) return;
        portraitLayers.value[currentLayer] = '';
        portraitCleanupTimer = null;
      }, 260);
    } catch {
      if (token !== portraitSwapToken) return;
      if (!hasVisiblePortrait.value) {
        clearPortraitLayers();
      }
    }
  },
  { immediate: true },
);

watch(
  blurCoverUrl,
  async (url) => {
    const normalizedUrl = String(url ?? '').trim();
    const token = ++blurSwapToken;

    if (!normalizedUrl) {
      clearBlurLayers();
      return;
    }

    const currentVisibleUrl = blurLayers.value[visibleBlurLayer.value];
    if (normalizedUrl === currentVisibleUrl) return;

    try {
      await preloadImage(normalizedUrl);
      if (token !== blurSwapToken) return;

      const nextLayer = (visibleBlurLayer.value === 0 ? 1 : 0) as 0 | 1;
      const currentLayer = visibleBlurLayer.value;

      blurLayers.value[nextLayer] = normalizedUrl;
      visibleBlurLayer.value = nextLayer;

      clearBlurCleanupTimer();
      blurCleanupTimer = window.setTimeout(() => {
        if (token !== blurSwapToken) return;
        blurLayers.value[currentLayer] = '';
        blurCleanupTimer = null;
      }, 260);
    } catch {
      if (token !== blurSwapToken) return;
      if (!hasVisibleBlur.value) {
        clearBlurLayers();
      }
    }
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

onMounted(() => {
  void ensureArtistBackdropForCurrentTrack();
  setTimeout(() => scheduleCollapse(), 500);
});

onUnmounted(() => {
  disposePortrait();
  clearCollapseTimer();
  clearPortraitCleanupTimer();
  clearBlurCleanupTimer();
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
    <div class="portrait-backdrop" :style="{ backgroundColor: backgroundColor || '#1a1d22' }">
      <div class="portrait-blur-stack">
        <img
          v-for="(_, layerIndex) in blurLayers"
          v-show="blurLayers[layerIndex]"
          :key="`blur-${layerIndex}`"
          :src="blurLayers[layerIndex]"
          class="portrait-blur-img"
          :class="{ 'is-visible': visibleBlurLayer === layerIndex }"
        />
        <div v-if="hasVisibleBlur" class="portrait-blur-overlay"></div>
      </div>
      <div class="portrait-media-stack">
        <img
          v-for="(_, layerIndex) in portraitLayers"
          v-show="portraitLayers[layerIndex]"
          :key="layerIndex"
          :src="portraitLayers[layerIndex]"
          :alt="`${currentTrack?.artist || '歌手'}写真`"
          class="portrait-img"
          :class="{ 'is-visible': visiblePortraitLayer === layerIndex }"
        />
      </div>
    </div>

    <!-- 遮罩层（仅有写真时需要压暗，透明度由设置控制） -->
    <div
      v-if="hasVisiblePortrait"
      class="portrait-overlay"
      :style="{ opacity: 1 - settingStore.lyricBackdropOpacity / 100 }"
    ></div>

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
}

.portrait-media-stack {
  position: absolute;
  inset: 0;
}

.portrait-blur-stack {
  position: absolute;
  inset: 0;
}

.portrait-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  user-select: none;
  opacity: 0;
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity;
}

.portrait-img.is-visible {
  opacity: 1;
}

.portrait-blur-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(40px);
  transform: scale(1.2);
  user-select: none;
  opacity: 0;
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity;
}

.portrait-blur-img.is-visible {
  opacity: 1;
}

.portrait-blur-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.portrait-overlay {
  position: fixed;
  inset: 0;
  background: black;
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
