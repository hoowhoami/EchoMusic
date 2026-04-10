<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AuthExpiredDialog from '@/components/app/AuthExpiredDialog.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
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
let silentUpdateCheckTimer: number | null = null;

const showStartupUpdateDialog = ref(false);
const startupUpdateResult = ref<{
  status: 'available' | 'latest' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  body?: string;
  message?: string;
  silent?: boolean;
} | null>(null);

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

const startupUpdateDescription = computed(() => {
  if (!startupUpdateResult.value) return '';
  const nextVersion =
    startupUpdateResult.value.releaseName || startupUpdateResult.value.latestVersion || '新版本';
  return `当前版本 v${startupUpdateResult.value.currentVersion}，发现新版本 ${nextVersion}`;
});

const startupUpdateBody = computed(() => startupUpdateResult.value?.body?.trim() || '');

const handleOpenStartupUpdateRelease = () => {
  const url = startupUpdateResult.value?.releaseUrl;
  if (!url) return;
  window.electron?.ipcRenderer?.send('open-external', url);
};

const handleSilentUpdateCheckResult = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  if (Reflect.get(payload, 'silent') !== true) return;
  if (Reflect.get(payload, 'status') !== 'available') return;

  startupUpdateResult.value = payload as typeof startupUpdateResult.value;
  showStartupUpdateDialog.value = true;
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
  if (!isDesktopLyricWindow()) {
    settings.syncCloseBehavior();
    settings.syncRememberWindowSize();
  }
  if (!isDesktopLyricWindow()) {
    settings.syncPreventSleep(player.isPlaying);
  }
  if (!isDesktopLyricWindow()) {
    disposeShortcuts = initShortcutSync();
    disposeTrayPlayModeSync =
      window.electron?.tray?.onSetPlayMode((playMode) => {
        player.setPlayMode(playMode);
      }) ?? null;
    syncTrayPlayback();
    window.electron?.ipcRenderer?.on('update-check-result', handleSilentUpdateCheckResult);
    silentUpdateCheckTimer = window.setTimeout(() => {
      settings.checkForUpdates(true);
    }, 4000);
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
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
});

watch(() => settings.theme, updateTheme);
watch(
  () => settings.rememberWindowSize,
  () => {
    if (isDesktopLyricWindow()) return;
    settings.syncRememberWindowSize();
  },
);
watch(
  () => settings.preventSleep,
  () => {
    if (isDesktopLyricWindow()) return;
    settings.syncPreventSleep(player.isPlaying);
  },
);
watch(
  () => player.isPlaying,
  (isPlaying) => {
    if (isDesktopLyricWindow()) return;
    settings.syncPreventSleep(isPlaying);
    syncTrayPlayback();
  },
);
watch(
  () => player.playMode,
  () => {
    syncTrayPlayback();
  },
);
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
  <Dialog
    :open="showStartupUpdateDialog"
    title="发现新版本"
    :description="startupUpdateDescription"
    show-close
    @update:open="showStartupUpdateDialog = $event"
  >
    <div class="space-y-4">
      <div
        v-if="startupUpdateBody"
        class="max-h-[280px] overflow-y-auto rounded-2xl bg-black/5 px-4 py-3 text-sm leading-6 text-text-secondary dark:bg-white/5"
      >
        <pre class="whitespace-pre-wrap break-words font-inherit">{{ startupUpdateBody }}</pre>
      </div>
    </div>
    <template #footer>
      <Button variant="ghost" size="sm" @click="showStartupUpdateDialog = false">稍后</Button>
      <Button variant="primary" size="sm" @click="handleOpenStartupUpdateRelease">前往下载</Button>
    </template>
  </Dialog>
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
