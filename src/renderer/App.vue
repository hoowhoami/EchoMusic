<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterView } from 'vue-router';
import AuthExpiredDialog from '@/components/app/AuthExpiredDialog.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import { usePlayerStore } from './stores/player';
import { useSettingStore } from './stores/setting';
import { useThemeStore } from './stores/theme';
import { initShortcutSync, syncGlobalShortcuts } from '@/utils/shortcuts';
import { initDesktopLyricSync } from '@/desktopLyric/sync';
import { getCoverUrl } from '@/utils/cover';
import type { UpdateCheckResult } from '../shared/app';
import LyricView from '@/views/Lyric.vue';

const player = usePlayerStore();
const settings = useSettingStore();
const themeStore = useThemeStore();
let disposeShortcuts: (() => void) | null = null;
let disposeDesktopLyricSync: (() => void) | null = null;
let disposeTrayPlayModeSync: (() => void) | null = null;
let silentUpdateCheckTimer: number | null = null;
let colorSchemeMediaQuery: MediaQueryList | null = null;

const showStartupUpdateDialog = ref(false);
const startupUpdateResult = ref<UpdateCheckResult | null>(null);

const updateTheme = () => {
  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
  themeStore.onThemeChange();
};

const applyGlobalFont = () => {
  document.documentElement.style.fontFamily = settings.buildGlobalFontFamily();
};

const syncTrayPlayback = () => {
  window.electron?.tray?.syncPlayback({
    isPlaying: player.isPlaying,
    playMode: player.playMode,
    volume: player.volume,
  });
};

const handleSilentUpdateCheckResult = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  if (Reflect.get(payload, 'silent') !== true) return;
  if (Reflect.get(payload, 'status') !== 'available') return;

  startupUpdateResult.value = payload as typeof startupUpdateResult.value;
  showStartupUpdateDialog.value = true;
};

onMounted(() => {
  player.init();
  void initDesktopLyricSync().then((dispose) => {
    disposeDesktopLyricSync = dispose;
  });
  updateTheme();
  applyGlobalFont();
  themeStore.applyCurrent();
  settings.syncTheme();
  settings.syncCloseBehavior();
  settings.syncRememberWindowSize();
  settings.syncPreventSleep(player.isPlaying);
  disposeShortcuts = initShortcutSync();
  disposeTrayPlayModeSync =
    window.electron?.tray?.onSetPlayMode((playMode) => {
      player.setPlayMode(playMode);
    }) ?? null;
  syncTrayPlayback();
  window.electron?.ipcRenderer?.on('update-check-result', handleSilentUpdateCheckResult);
  if (settings.autoCheckUpdate) {
    silentUpdateCheckTimer = window.setTimeout(() => {
      settings.checkForUpdates(true);
    }, 4000);
  }
  colorSchemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  colorSchemeMediaQuery.addEventListener('change', updateTheme);
});

onUnmounted(() => {
  if (silentUpdateCheckTimer !== null) {
    window.clearTimeout(silentUpdateCheckTimer);
    silentUpdateCheckTimer = null;
  }
  window.electron?.ipcRenderer?.off('update-check-result', handleSilentUpdateCheckResult);
  disposeShortcuts?.();
  disposeShortcuts = null;
  disposeDesktopLyricSync?.();
  disposeDesktopLyricSync = null;
  disposeTrayPlayModeSync?.();
  disposeTrayPlayModeSync = null;
  colorSchemeMediaQuery?.removeEventListener('change', updateTheme);
  colorSchemeMediaQuery = null;
});

watch(() => settings.theme, updateTheme);
watch(() => settings.globalFont, applyGlobalFont);
watch(
  () => settings.rememberWindowSize,
  () => settings.syncRememberWindowSize(),
);
watch(
  () => settings.preventSleep,
  () => settings.syncPreventSleep(player.isPlaying),
);
watch(
  () => player.isPlaying,
  (isPlaying) => {
    settings.syncPreventSleep(isPlaying);
    syncTrayPlayback();
  },
);
watch(() => player.playMode, syncTrayPlayback);
watch(() => player.volume, syncTrayPlayback);
watch(
  () => [settings.globalShortcutsEnabled, settings.globalShortcutBindings],
  () => void syncGlobalShortcuts(),
  { deep: true },
);

// 切歌时，cover 模式下自动提取封面主色
watch(
  () => player.currentTrackSnapshot?.coverUrl,
  (coverUrl) => {
    if (!coverUrl) return;
    if (themeStore.accentMode !== 'cover') return;
    void themeStore.refreshFromCover(getCoverUrl(coverUrl, 300));
  },
  { immediate: true },
);

// 切换到 cover 模式时，立即用当前封面重新提取主色
watch(
  () => themeStore.accentMode,
  (mode) => {
    if (mode !== 'cover') return;
    const coverUrl = player.currentTrackSnapshot?.coverUrl;
    if (!coverUrl) return;
    void themeStore.refreshFromCover(getCoverUrl(coverUrl, 300));
  },
);
</script>

<template>
  <RouterView v-slot="{ Component }">
    <transition name="page" mode="out-in">
      <component :is="Component" />
    </transition>
  </RouterView>
  <Teleport to="body">
    <Transition name="lyric-overlay">
      <LyricView v-if="player.isLyricViewOpen" />
    </Transition>
  </Teleport>
  <AuthExpiredDialog />
  <ToastViewport />
  <UpdateDialog
    v-model:open="showStartupUpdateDialog"
    :result="startupUpdateResult"
    dismiss-label="稍后"
  />
</template>

<style>
.page-enter-active,
.page-leave-active {
  transition: all 0.3s ease-out;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 歌词覆盖层动画 */
.lyric-overlay-enter-active {
  transition:
    transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
}

.lyric-overlay-leave-active {
  transition:
    transform 0.3s cubic-bezier(0.4, 0, 0.6, 1),
    opacity 0.2s cubic-bezier(0.4, 0, 1, 1);
  will-change: transform, opacity;
}

.lyric-overlay-enter-from {
  opacity: 0;
  transform: translateY(100%);
}

.lyric-overlay-leave-to {
  opacity: 0;
  transform: translateY(100%);
}
</style>
