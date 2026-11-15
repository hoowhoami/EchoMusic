<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import LyricPage from '@/views/lyric/LyricPage.vue';
import { connectWallpaperSync } from '@/wallpaper/sync';
import { portraitLyricCollapsed } from '@/views/lyric/portraitCollapseState';
import { setPageFrozen } from '@/utils/pageFreeze';
import { setRenderFrameRate } from '@/utils/frameBudget';
import WallpaperDim from './WallpaperDim.vue';
import WallpaperParticles from './WallpaperParticles.vue';
import {
  DEFAULT_WALLPAPER_SETTINGS,
  DEFAULT_WALLPAPER_TEXTURE,
  getWallpaperPalette,
  type WallpaperSettings,
  type WallpaperState,
  type WallpaperTextureSettings,
} from '../../../shared/wallpaper';

defineOptions({ name: 'wallpaper-page' });

// 壁纸窗口：整页复用主界面的歌词页，只保留画面，不接受鼠标与键盘操作
const state = ref<WallpaperState | null>(null);
const settings = computed<WallpaperSettings>(
  () => state.value?.settings ?? DEFAULT_WALLPAPER_SETTINGS,
);
// 「仅歌词」的画面质感参数，由设置页实时改写，这里只读。
const texture = computed<WallpaperTextureSettings>(
  () => settings.value.texture ?? DEFAULT_WALLPAPER_TEXTURE,
);
// 整套配色：压暗底色、浮尘颜色、歌词颜色都从这里取，只在壁纸窗口生效。
const palette = computed(() => getWallpaperPalette(settings.value.palette));
// 配色自带的歌词颜色只在「仅歌词」时生效；「跟随播放页」必须与播放页完全一致。
const lyricColor = computed(() =>
  settings.value.contentMode === 'lyric' ? palette.value.lyric || undefined : undefined,
);
// 壁纸看不见的时候整页冻结：停掉浮尘的绘制循环、歌词的逐帧刷新和全部 CSS 动画，
// 合成器没有新帧可画。三种情况 —— 桌面被整块盖住（全屏 / 最大化应用，窗口已被
// 隐藏）、暂停且不显示壁纸（画面停在最后一句）、暂停且关闭壁纸。
// 降帧只减少提交次数，绘制与动画本身还在，所以看不见时直接冻住更省。
const frozen = computed(() => {
  const reason = state.value?.reason;
  if (!reason || reason === 'disabled' || reason === 'detached') return true;
  // 歌词区域被窗口盖住大半：画面冻在原地，等窗口挪开再续上。
  if (reason === 'covered') return true;
  if (reason === 'paused') {
    return settings.value.pauseBehavior === 'freeze' || settings.value.pauseBehavior === 'hide';
  }
  return false;
});

// 冻结/解冻：看不见时整页停画，连 rAF 都不再要帧。
watch(frozen, (value) => setPageFrozen(value), { immediate: true });

// 帧预算：把主进程算出的目标帧率交给页面侧的绘制循环；冻结时不发帧。
watch(
  () => (frozen.value ? 0 : (state.value?.frameRate ?? 0)),
  (fps) => setRenderFrameRate(fps),
  { immediate: true },
);

// 歌词区域上报：省电判定看的是「歌词那块地方有没有被窗口盖住」，所以要告诉主进程
// 它现在在屏幕上的哪儿。每秒读一次布局，位置/尺寸变了才发，避免无意义的 IPC。
const LYRIC_REGION_SELECTORS = [
  // 真正装歌词的那一列；没有它时再退回各皮肤的外层容器。
  '.lyric-scroller',
  '.amll-player-area',
  '.lyric-side',
  '.portrait-lyric-area',
  '.lyric-mode',
  '.lyric-page',
];
const measureLyricRegion = () => {
  const dpr = window.devicePixelRatio || 1;
  for (const selector of LYRIC_REGION_SELECTORS) {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, dpr };
    }
  }
  // 还没渲染出歌词：报空区域，原生侧按「没被挡住」处理。
  return { left: 0, top: 0, width: 0, height: 0, dpr };
};
let lyricRegionTimer: ReturnType<typeof setInterval> | null = null;
let lastLyricRegion = '';
const reportLyricRegion = () => {
  // 冻结时画面不动，位置也不会变；此时测量只会白白唤起一次布局。
  if (frozen.value) return;
  const region = measureLyricRegion();
  const key = [region.left, region.top, region.width, region.height]
    .map((value) => Math.round(value))
    .join(',');
  if (key === lastLyricRegion) return;
  lastLyricRegion = key;
  void window.electron.wallpaper.setLyricRect(region).catch(() => undefined);
};

let disposeState: (() => void) | null = null;
let disposeSync: (() => void) | null = null;

// 壁纸窗口是桌面层上的一层画面：html/body/#app 必须透明，
// 否则「仅歌词」的样式再透也透不出桌面。与桌面歌词、Mini 播放器同一套做法。
const WALLPAPER_WINDOW_CLASS = 'desktop-wallpaper-window';
const setWindowClass = (present: boolean) => {
  const nodes = [document.documentElement, document.body, document.getElementById('app')];
  for (const node of nodes) node?.classList.toggle(WALLPAPER_WINDOW_CLASS, present);
};

onMounted(async () => {
  setWindowClass(true);
  disposeSync = connectWallpaperSync();
  reportLyricRegion();
  lyricRegionTimer = setInterval(reportLyricRegion, 1000);
  try {
    state.value = await window.electron.wallpaper.getState();
  } catch {
    // 读取失败时按默认设置渲染，不影响画面
  }
  disposeState = window.electron.wallpaper.onStateChange((next) => {
    state.value = next;
  });
});

onUnmounted(() => {
  if (lyricRegionTimer) clearInterval(lyricRegionTimer);
  lyricRegionTimer = null;
  setPageFrozen(false);
  setWindowClass(false);
  disposeState?.();
  disposeState = null;
  disposeSync?.();
  disposeSync = null;
});
</script>

<template>
  <div class="wallpaper-root" aria-hidden="true">
    <div v-if="settings.contentMode !== 'lyric'" class="wallpaper-backdrop"></div>
    <LyricPage
      presentation="wallpaper"
      :clear-background="settings.contentMode === 'lyric'"
      :dim-wallpaper="texture.dimEnabled"
      :portrait-collapsed="portraitLyricCollapsed"
      :lyric-color="lyricColor"
    />
    <!-- 「仅歌词」：贴边压暗 + 浮尘粒子，让画面有层次 -->
    <template v-if="settings.contentMode === 'lyric'">
      <WallpaperDim
        v-if="texture.dimEnabled"
        :edge-start="texture.edgeStart"
        :edge-darkness="texture.edgeDarkness"
        :color="palette.dim"
      />
      <WallpaperParticles
        v-if="texture.particleEnabled"
        :density="texture.particleDensity"
        :size="texture.particleSize"
        :color="palette.particle"
        :frozen="frozen"
      />
    </template>
  </div>
</template>

<style scoped>
.wallpaper-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 跟随播放页：给不自绘背景的皮肤（插件皮肤）垫一层主界面底色，
   与在应用窗口里看到的效果保持一致。 */
.wallpaper-backdrop {
  position: fixed;
  inset: 0;
  background: var(--surface-main-base, #1a1d22);
}

/* 兜底：歌词页里所有可操作元素在壁纸中不显示 */
.wallpaper-root :deep(button),
.wallpaper-root :deep([role='button']),
.wallpaper-root :deep([role='slider']),
.wallpaper-root :deep(input),
.wallpaper-root :deep(textarea),
.wallpaper-root :deep(select),
.wallpaper-root :deep(.no-drag) {
  display: none !important;
}
</style>

<style>
/* 冻结时的兜底：壁纸窗口被冻结后，页面里任何动画与过渡都停住，
   合成器不再产生新帧。这个类只在壁纸窗口暂停时挂上，不影响主窗口。 */
html.wallpaper-frozen *,
html.wallpaper-frozen *::before,
html.wallpaper-frozen *::after {
  animation-play-state: paused !important;
  transition: none !important;
}
</style>
