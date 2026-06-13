<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AuthExpiredDialog from '@/components/app/AuthExpiredDialog.vue';
import KugouVerificationDialog from '@/components/app/KugouVerificationDialog.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import RouteErrorBoundary from '@/components/app/RouteErrorBoundary.vue';
import { usePlayerStore } from './stores/player';
import { useSettingStore } from './stores/setting';
import { useThemeStore } from './stores/theme';
import { usePlaylistStore } from './stores/playlist';
import { waitForSqlitePersistHydration } from './stores/sqlitePersist';
import { initShortcutSync, syncGlobalShortcuts } from '@/utils/shortcuts';
import { initDesktopLyricSync } from '@/desktopLyric/sync';
import { initMiniPlayerSync } from '@/miniPlayer/sync';
import { initNowPlayingSync } from '@/nowPlaying/sync';
import {
  onPluginRuntimeReloadRequested,
  pageTransitionState,
  refreshPlugins,
} from '@/plugins/runtime';
import { coverFallbackRevision } from '@/plugins/coverFallback';
import { resolveCoverColorUrls } from '@/utils/cover';
import type { UpdateCheckResult } from '../shared/app';
import LyricView from '@/views/lyric/LyricPage.vue';

const route = useRoute();
const player = usePlayerStore();
const settings = useSettingStore();
const themeStore = useThemeStore();
const playlistStore = usePlaylistStore();
let disposeShortcuts: (() => void) | null = null;
let disposeDesktopLyricSync: (() => void) | null = null;
let disposeMiniPlayerSync: (() => void) | null = null;
let disposeNowPlayingSync: (() => void) | null = null;
let disposeTrayPlayModeSync: (() => void) | null = null;
let disposePowerResumeSync: (() => void) | null = null;
let disposePluginRuntimeReload: (() => void) | null = null;
let silentUpdateCheckTimer: number | null = null;
let colorSchemeMediaQuery: MediaQueryList | null = null;

const showStartupUpdateDialog = ref(false);
const startupUpdateResult = ref<UpdateCheckResult | null>(null);
const isMiniPlayerRoute = computed(() => route.name === 'mini-player');
const rootPageTransitionName = computed(() =>
  isMiniPlayerRoute.value || !pageTransitionState.enabled ? undefined : pageTransitionState.name,
);
const rootPageTransitionMode = computed(() =>
  pageTransitionState.mode === 'default' ? undefined : pageTransitionState.mode,
);
const rootPageTransitionAppear = computed(
  () => !isMiniPlayerRoute.value && pageTransitionState.enabled && pageTransitionState.appear,
);
const rootPageTransitionKey = computed(() => route.matched[0]?.path ?? route.fullPath);
const currentCoverColorUrls = computed(() =>
  resolveCoverColorUrls(player.currentTrackSnapshot?.coverUrl, 300, { scope: 'theme' }),
);

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

onMounted(async () => {
  disposePluginRuntimeReload = onPluginRuntimeReloadRequested(() => {
    void refreshPlugins(
      isMiniPlayerRoute.value ? { miniPlayer: true, reloadActive: true } : { reloadActive: true },
    );
  });

  if (isMiniPlayerRoute.value) {
    void refreshPlugins({ miniPlayer: true });
    return;
  }

  await waitForSqlitePersistHydration();
  settings.ensureShortcutDefaults();
  await playlistStore.hydratePlaybackStateFromStorage();
  player.init();
  updateTheme();
  applyGlobalFont();
  themeStore.applyCurrent();
  void initDesktopLyricSync().then((dispose) => {
    disposeDesktopLyricSync = dispose;
  });
  void initNowPlayingSync().then((dispose) => {
    disposeNowPlayingSync = dispose;
  });
  void initMiniPlayerSync().then((dispose) => {
    disposeMiniPlayerSync = dispose;
  });
  settings.syncTheme();
  settings.syncCloseBehavior();
  settings.syncRememberWindowSize();
  settings.syncPreventSleep(player.isPlaying);
  settings.syncLogSettings();
  disposeShortcuts = initShortcutSync();
  disposeTrayPlayModeSync =
    window.electron?.tray?.onSetPlayMode((playMode) => {
      player.setPlayMode(playMode);
    }) ?? null;
  // 系统唤醒后重新枚举输出设备（睡眠期间设备可能变化，如耳机被拔）。
  // 引擎级恢复（暂停/重建音频/恢复播放）已在主进程 powerMonitor 完成。
  disposePowerResumeSync =
    window.electron?.power?.onResume(() => {
      void player.refreshOutputDevices();
    }) ?? null;
  syncTrayPlayback();
  window.electron?.ipcRenderer?.on('update-check-result', handleSilentUpdateCheckResult);
  if (settings.autoCheckUpdate) {
    silentUpdateCheckTimer = window.setTimeout(() => {
      settings.checkForUpdates(true);
    }, 4000);
  }
  void refreshPlugins();
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
  disposeMiniPlayerSync?.();
  disposeMiniPlayerSync = null;
  disposeNowPlayingSync?.();
  disposeNowPlayingSync = null;
  disposeTrayPlayModeSync?.();
  disposeTrayPlayModeSync = null;
  disposePowerResumeSync?.();
  disposePowerResumeSync = null;
  disposePluginRuntimeReload?.();
  disposePluginRuntimeReload = null;
  colorSchemeMediaQuery?.removeEventListener('change', updateTheme);
  colorSchemeMediaQuery = null;
});

watch(
  () => settings.theme,
  () => {
    if (!isMiniPlayerRoute.value) updateTheme();
  },
);
watch(
  () => settings.globalFont,
  () => {
    if (!isMiniPlayerRoute.value) applyGlobalFont();
  },
);
watch(
  () => settings.rememberWindowSize,
  () => {
    if (!isMiniPlayerRoute.value) settings.syncRememberWindowSize();
  },
);
watch(
  () => settings.preventSleep,
  () => {
    if (!isMiniPlayerRoute.value) settings.syncPreventSleep(player.isPlaying);
  },
);
watch(
  () => player.isPlaying,
  (isPlaying) => {
    if (isMiniPlayerRoute.value) return;
    settings.syncPreventSleep(isPlaying);
    syncTrayPlayback();
  },
);
watch(
  () => player.playMode,
  () => {
    if (!isMiniPlayerRoute.value) syncTrayPlayback();
  },
);
watch(
  () => player.volume,
  () => {
    if (!isMiniPlayerRoute.value) syncTrayPlayback();
  },
);
watch(
  () => [settings.globalShortcutsEnabled, settings.globalShortcutBindings],
  () => {
    if (!isMiniPlayerRoute.value) void syncGlobalShortcuts();
  },
  { deep: true },
);

// 切歌时，cover 模式下自动提取封面主色
watch(
  () => [player.currentTrackSnapshot?.coverUrl, coverFallbackRevision.value],
  () => {
    if (isMiniPlayerRoute.value) return;
    const coverColorUrls = currentCoverColorUrls.value;
    if (themeStore.accentMode === 'cover') {
      void themeStore.refreshFromCover(coverColorUrls);
      return;
    }
    void themeStore.refreshCoverColor(coverColorUrls);
  },
  { immediate: true },
);

// 切换到 cover 模式时，立即用当前封面重新提取主色
watch(
  () => themeStore.accentMode,
  (mode) => {
    if (isMiniPlayerRoute.value) return;
    if (mode !== 'cover') return;
    void themeStore.refreshFromCover(currentCoverColorUrls.value);
  },
);
</script>

<template>
  <RouterView v-slot="{ Component, route }">
    <Transition
      :name="rootPageTransitionName"
      :mode="rootPageTransitionMode"
      :appear="rootPageTransitionAppear"
    >
      <RouteErrorBoundary :key="rootPageTransitionKey" :route="route">
        <component :is="Component" />
      </RouteErrorBoundary>
    </Transition>
  </RouterView>
  <Teleport v-if="route.name !== 'mini-player'" to="body">
    <Transition name="lyric-overlay">
      <LyricView v-if="player.isLyricViewOpen" />
    </Transition>
  </Teleport>
  <AuthExpiredDialog v-if="route.name !== 'mini-player'" />
  <KugouVerificationDialog v-if="route.name !== 'mini-player'" />
  <ToastViewport v-if="route.name !== 'mini-player'" />
  <UpdateDialog
    v-if="route.name !== 'mini-player'"
    v-model:open="showStartupUpdateDialog"
    :result="startupUpdateResult"
    dismiss-label="稍后"
  />
</template>

<style>
/* 歌词覆盖层动画 */
.lyric-overlay-enter-active {
  transition:
    transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
    opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform, opacity;
  backface-visibility: hidden;
}

.lyric-overlay-leave-active {
  transition:
    transform 0.3s cubic-bezier(0.4, 0, 0.6, 1),
    opacity 0.2s cubic-bezier(0.4, 0, 1, 1);
  will-change: transform, opacity;
  backface-visibility: hidden;
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
