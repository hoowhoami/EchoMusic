<script setup lang="ts">
import { onMounted, watch, onUnmounted } from 'vue';
import { RouterView } from 'vue-router';
import { useRoute } from 'vue-router';
import AuthExpiredDialog from '@/components/app/AuthExpiredDialog.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import { usePlayerStore } from './stores/player';
import { useSettingStore } from './stores/setting';
import { initShortcutSync, syncGlobalShortcuts } from '@/utils/shortcuts';
import { initDesktopLyricSync } from '@/utils/desktopLyric';

const player = usePlayerStore();
const settings = useSettingStore();
const route = useRoute();
const isDesktopLyricWindow = () => route.name === 'desktop-lyric';
let disposeShortcuts: (() => void) | null = null;
let disposeDesktopLyricSync: (() => void) | null = null;
let disposeTrayPlayModeSync: (() => void) | null = null;

const updateTheme = () => {
  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
};

const syncTrayPlayback = () => {
  if (isDesktopLyricWindow()) return;
  window.electron?.tray?.syncPlayback({
    isPlaying: player.isPlaying,
    playMode: player.playMode,
  });
};

onMounted(() => {
  if (!isDesktopLyricWindow()) {
    player.init();
    void settings.hydrateDesktopLyric();
    void initDesktopLyricSync().then((dispose) => {
      disposeDesktopLyricSync = dispose;
    });
  }
  updateTheme();
  settings.syncTheme();
  settings.syncCloseBehavior();
  settings.syncRememberWindowSize();
  if (!isDesktopLyricWindow()) {
    settings.syncPreventSleep(player.isPlaying);
  }
  if (!isDesktopLyricWindow()) {
    disposeShortcuts = initShortcutSync();
    disposeTrayPlayModeSync = window.electron?.tray?.onSetPlayMode((playMode) => {
      player.setPlayMode(playMode);
    }) ?? null;
    syncTrayPlayback();
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
});

onUnmounted(() => {
  disposeShortcuts?.();
  disposeShortcuts = null;
  disposeDesktopLyricSync?.();
  disposeDesktopLyricSync = null;
  disposeTrayPlayModeSync?.();
  disposeTrayPlayModeSync = null;
});

watch(() => settings.theme, updateTheme);
watch(() => settings.rememberWindowSize, () => {
  if (isDesktopLyricWindow()) return;
  settings.syncRememberWindowSize();
});
watch(() => settings.preventSleep, () => {
  if (isDesktopLyricWindow()) return;
  settings.syncPreventSleep(player.isPlaying);
});
watch(() => player.isPlaying, (isPlaying) => {
  if (isDesktopLyricWindow()) return;
  settings.syncPreventSleep(isPlaying);
  syncTrayPlayback();
});
watch(() => player.playMode, () => {
  syncTrayPlayback();
});
watch(
  () => [settings.globalShortcutsEnabled, settings.globalShortcutBindings],
  () => {
    if (isDesktopLyricWindow()) return;
    syncGlobalShortcuts();
  },
  { deep: true },
);
</script>

<template>
  <RouterView v-slot="{ Component }">
    <transition name="page" mode="out-in">
      <component :is="Component" />
    </transition>
  </RouterView>
  <AuthExpiredDialog />
  <ToastViewport />
</template>

<style>
/* 全局样式已在 style.css 中定义 */

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
</style>
