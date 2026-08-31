<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AuthExpiredDialog from '@/components/app/AuthExpiredDialog.vue';
import KugouVerificationFlow from '@/components/app/KugouVerificationFlow.vue';
import ToastViewport from '@/components/app/ToastViewport.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import RouteErrorBoundary from '@/components/app/RouteErrorBoundary.vue';
import { useSettingStore } from './stores/setting';
import { useUpdateStore } from './stores/update';
import { useThemeStore } from './stores/theme';
import { usePlaylistStore } from './stores/playlist';
import { useHistoryStore } from './stores/historyStore';
import { useToastStore } from './stores/toast';
import { useUserStore } from './stores/user';
import { waitForSqlitePersistHydration } from './stores/sqlitePersist';
import { normalizeQuality } from './stores/player/utils';
import { clearCloudAudioIndex, refreshCloudAudioIndex } from '@/services/cloudAudioIndex';
import { registerContentBlacklistIntegration } from '@/services/contentBlacklistIntegration';
import { useContentBlacklistStore } from './stores/contentBlacklist';
import { pageTransitionState } from '@/plugins/runtime/theme';
import { coverFallbackRevision } from '@/plugins/coverFallback';
import { resolveCoverColorUrls } from '@/utils/cover';
import { logger } from '@/utils/logger';
import {
  navigateToShareTarget,
  SHARE_RESOLVE_ROUTE_NAME,
  SHARE_COPIED_EVENT,
  type ShareCopiedEventDetail,
} from '@/utils/share';
import { extractShareTarget, getShareResourceLabel, type ShareTarget } from '../shared/share';

type PlayerStore = ReturnType<(typeof import('./stores/player'))['usePlayerStore']>;
type SyncGlobalShortcuts = (typeof import('@/utils/shortcuts'))['syncGlobalShortcuts'];

const LyricView = defineAsyncComponent(() => import('@/views/lyric/LyricPage.vue'));
const route = useRoute();
const router = useRouter();
const player = shallowRef<PlayerStore | null>(null);
const settings = useSettingStore();
const updateStore = useUpdateStore();
const themeStore = useThemeStore();
const playlistStore = usePlaylistStore();
const historyStore = useHistoryStore();
const toastStore = useToastStore();
const userStore = useUserStore();
const contentBlacklistStore = useContentBlacklistStore();
let disposeShortcuts: (() => void) | null = null;
let disposeDesktopLyricSync: (() => void) | null = null;
let disposeMiniPlayerSync: (() => void) | null = null;
let disposeNowPlayingSync: (() => void) | null = null;
let disposeTrayPlayModeSync: (() => void) | null = null;
let disposePowerResumeSync: (() => void) | null = null;
let disposePluginRuntimeReload: (() => void) | null = null;
let disposeTaskBridges: (() => void) | null = null;
let disposeShareOpen: (() => void) | null = null;
let disposeContentBlacklistIntegration: (() => void) | null = null;
let syncGlobalShortcutsFn: SyncGlobalShortcuts | null = null;
let silentUpdateCheckTimer: number | null = null;
let clipboardShareCheckTimer: number | null = null;
let cloudAudioIndexWarmupTimer: number | null = null;
let lastHandledClipboardText = '';
let isCheckingClipboardShare = false;
let colorSchemeMediaQuery: MediaQueryList | null = null;

const isMiniPlayerWindow = () => {
  const hashPath = window.location.hash.replace(/^#/, '').split(/[?#]/)[0];
  return (
    route.name === 'mini-player' || route.path === '/mini-player' || hashPath === '/mini-player'
  );
};
const isMiniPlayerRoute = computed(isMiniPlayerWindow);
// 首屏从 loading 切到主界面时跳过根级过渡，避免 out-in "先淡出旧页 → 空档" 造成的白屏
const suppressRootTransition = ref(false);
const pendingShareTarget = ref<ShareTarget | null>(null);
const rootPageTransitionName = computed(() =>
  isMiniPlayerRoute.value || suppressRootTransition.value || !pageTransitionState.enabled
    ? undefined
    : pageTransitionState.name,
);
const rootPageTransitionMode = computed(() =>
  suppressRootTransition.value || pageTransitionState.mode === 'default'
    ? undefined
    : pageTransitionState.mode,
);
const rootPageTransitionAppear = computed(
  () =>
    !isMiniPlayerRoute.value &&
    !suppressRootTransition.value &&
    pageTransitionState.enabled &&
    pageTransitionState.appear,
);
const rootPageTransitionKey = computed(() => route.matched[0]?.path ?? route.fullPath);
const currentCoverColorUrls = computed(() =>
  resolveCoverColorUrls(player.value?.currentTrackSnapshot?.coverUrl, 300, { scope: 'theme' }),
);
const currentUserKey = computed(() =>
  String(userStore.info?.userid ?? userStore.info?.userId ?? ''),
);
let loadedCloudUserKey = '';

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
  const activePlayer = player.value;
  if (!activePlayer) return;
  window.electron?.tray?.syncPlayback({
    isPlaying: activePlayer.isPlaying,
    playMode: activePlayer.playMode,
    volume: activePlayer.volume,
  });
};

const clearCloudAudioIndexWarmupTimer = () => {
  if (cloudAudioIndexWarmupTimer === null) return;
  window.clearTimeout(cloudAudioIndexWarmupTimer);
  cloudAudioIndexWarmupTimer = null;
};

const scheduleCloudAudioIndexWarmup = () => {
  clearCloudAudioIndexWarmupTimer();
  if (!userStore.isLoggedIn) return;
  cloudAudioIndexWarmupTimer = window.setTimeout(() => {
    cloudAudioIndexWarmupTimer = null;
    void refreshCloudAudioIndex(false).catch((error) => {
      logger.debug('App', 'Warm cloud audio index failed:', error);
    });
  }, 1500);
};

const openShareTarget = (target: ShareTarget) => {
  if (route.name === 'loading') {
    pendingShareTarget.value = target;
    return;
  }
  if (!navigateToShareTarget(router, target)) {
    logger.warn('App', 'Invalid share target skipped', target);
    void router.push({
      name: SHARE_RESOLVE_ROUTE_NAME,
      query: {
        type: target.type,
        id: target.id,
        reason: 'invalid',
      },
    });
  }
};

const normalizeClipboardText = (value: unknown) => String(value ?? '').trim();

const handleShareCopied = (event: Event) => {
  const detail = (event as CustomEvent<ShareCopiedEventDetail>).detail;
  const text = normalizeClipboardText(detail?.text);
  if (detail?.target?.type && detail.target.id && text) {
    lastHandledClipboardText = text;
  }
};

const checkClipboardShareTarget = async () => {
  if (isMiniPlayerRoute.value || isCheckingClipboardShare) return;
  const readClipboard = window.electron?.share?.readClipboard;
  if (!readClipboard) return;

  isCheckingClipboardShare = true;
  try {
    const text = await readClipboard();
    const normalizedText = normalizeClipboardText(text);
    const target = extractShareTarget(text);
    if (!target) {
      lastHandledClipboardText = '';
      return;
    }

    if (normalizedText && normalizedText === lastHandledClipboardText) return;
    lastHandledClipboardText = normalizedText;

    const label = getShareResourceLabel(target.type);
    toastStore.showAction(`检测到 EchoMusic ${label}分享`, {
      label: '打开',
      handler: () => openShareTarget(target),
    });
  } catch (error) {
    logger.debug('App', 'Failed to inspect clipboard share link', error);
  } finally {
    isCheckingClipboardShare = false;
  }
};

const scheduleClipboardShareCheck = () => {
  if (clipboardShareCheckTimer !== null) {
    window.clearTimeout(clipboardShareCheckTimer);
  }
  clipboardShareCheckTimer = window.setTimeout(() => {
    clipboardShareCheckTimer = null;
    void checkClipboardShareTarget();
  }, 350);
};

const flushPendingShareTarget = () => {
  if (route.name === 'loading' || !pendingShareTarget.value) return;
  const target = pendingShareTarget.value;
  pendingShareTarget.value = null;
  openShareTarget(target);
};

onMounted(async () => {
  await router.isReady();

  disposeShareOpen = window.electron?.share?.onOpen(openShareTarget) ?? null;
  window.addEventListener('focus', scheduleClipboardShareCheck);
  window.addEventListener(SHARE_COPIED_EVENT, handleShareCopied);

  const { onPluginRuntimeReloadRequested, refreshPlugins } = await import('@/plugins/runtime');

  disposePluginRuntimeReload = onPluginRuntimeReloadRequested(() => {
    void refreshPlugins(
      isMiniPlayerRoute.value ? { miniPlayer: true, reloadActive: true } : { reloadActive: true },
    );
  });

  if (isMiniPlayerRoute.value) {
    void refreshPlugins({ miniPlayer: true });
    return;
  }

  disposeContentBlacklistIntegration = registerContentBlacklistIntegration();

  const [
    { usePlayerStore },
    { initShortcutSync, syncGlobalShortcuts },
    { initDesktopLyricSync },
    { initMiniPlayerSync },
    { initNowPlayingSync },
    { setupTaskBridges },
  ] = await Promise.all([
    import('./stores/player'),
    import('@/utils/shortcuts'),
    import('@/desktopLyric/sync'),
    import('@/miniPlayer/sync'),
    import('@/nowPlaying/sync'),
    import('@/tasks/taskBridges'),
  ]);
  const activePlayer = usePlayerStore();
  player.value = activePlayer;
  syncGlobalShortcutsFn = syncGlobalShortcuts;

  await waitForSqlitePersistHydration();
  // 用户信息须在持久化恢复后再拉取，否则 hydrate 未完成时 isLoggedIn 仍为 false，
  // Home 挂载阶段的 fetchUserInfoOnce 会被跳过，导致启动后头像/昵称不更新。
  if (userStore.isLoggedIn) {
    void userStore.fetchUserInfoOnce();
  }
  settings.defaultAudioQuality = normalizeQuality(settings.defaultAudioQuality);
  settings.ensureShortcutDefaults();
  await settings.hydrateLogSettings();
  await Promise.all([
    playlistStore.hydratePlaybackStateFromStorage(),
    playlistStore.hydratePersonalFmPreferences(),
    historyStore.hydrate(),
  ]);
  activePlayer.init();

  // 启动时自动播放：如果开启了设置且有恢复的曲目
  if (settings.autoPlayOnLaunch && activePlayer.currentTrackId && !activePlayer.isPlaying) {
    // 延迟启动播放，确保所有初始化完成
    window.setTimeout(() => {
      if (activePlayer.currentTrackId && !activePlayer.isPlaying) {
        void activePlayer.togglePlay();
      }
    }, 300);
  }

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
  settings.syncTaskbarCoverPreview();
  settings.syncTaskbarProgress();
  settings.syncPreventSleep(activePlayer.isPlaying);
  settings.syncLogSettings();
  disposeShortcuts = initShortcutSync();
  disposeTrayPlayModeSync =
    window.electron?.tray?.onSetPlayMode((playMode) => {
      activePlayer.setPlayMode(playMode);
    }) ?? null;
  // 系统唤醒后重新枚举输出设备（睡眠期间设备可能变化，如耳机被拔）。
  // 引擎级恢复（暂停/重建音频/恢复播放）已在主进程 powerMonitor 完成。
  disposePowerResumeSync =
    window.electron?.power?.onResume(() => {
      void activePlayer.refreshOutputDevices();
    }) ?? null;
  syncTrayPlayback();
  void updateStore.init();
  disposeTaskBridges = setupTaskBridges();
  if (settings.autoCheckUpdate) {
    silentUpdateCheckTimer = window.setTimeout(() => {
      updateStore.check(true);
    }, 4000);
  }
  void refreshPlugins();
  scheduleClipboardShareCheck();
  colorSchemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  colorSchemeMediaQuery.addEventListener('change', updateTheme);
});

onUnmounted(() => {
  window.removeEventListener('focus', scheduleClipboardShareCheck);
  window.removeEventListener(SHARE_COPIED_EVENT, handleShareCopied);
  if (silentUpdateCheckTimer !== null) {
    window.clearTimeout(silentUpdateCheckTimer);
    silentUpdateCheckTimer = null;
  }
  if (clipboardShareCheckTimer !== null) {
    window.clearTimeout(clipboardShareCheckTimer);
    clipboardShareCheckTimer = null;
  }
  clearCloudAudioIndexWarmupTimer();
  updateStore.dispose();
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
  disposeShareOpen?.();
  disposeShareOpen = null;
  disposeContentBlacklistIntegration?.();
  disposeContentBlacklistIntegration = null;
  disposeTaskBridges?.();
  disposeTaskBridges = null;
  colorSchemeMediaQuery?.removeEventListener('change', updateTheme);
  colorSchemeMediaQuery = null;
});

watch(
  () => route.name,
  (toName, fromName) => {
    // 从 loading 进入主界面这次切换跳过过渡，其余路由切换恢复正常过渡
    suppressRootTransition.value = fromName === 'loading' && toName !== 'loading';
    flushPendingShareTarget();
  },
);
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
    if (!isMiniPlayerRoute.value) settings.syncPreventSleep(player.value?.isPlaying ?? false);
  },
);
watch(
  () => player.value?.isPlaying ?? false,
  (isPlaying) => {
    if (isMiniPlayerRoute.value) return;
    settings.syncPreventSleep(isPlaying);
    syncTrayPlayback();
  },
);
watch(
  () => [userStore.isLoggedIn, currentUserKey.value] as const,
  ([loggedIn, userKey]) => {
    contentBlacklistStore.reset();
    if (loggedIn) {
      if (userKey && loadedCloudUserKey && loadedCloudUserKey !== userKey) {
        playlistStore.resetUserCollections();
      }
      if (userKey) {
        loadedCloudUserKey = userKey;
      }
      scheduleCloudAudioIndexWarmup();
    } else {
      loadedCloudUserKey = '';
      playlistStore.resetUserCollections();
      clearCloudAudioIndexWarmupTimer();
      clearCloudAudioIndex();
    }
  },
  { immediate: true },
);
watch(
  () => player.value?.playMode,
  () => {
    if (!isMiniPlayerRoute.value) syncTrayPlayback();
  },
);
watch(
  () => player.value?.volume,
  () => {
    if (!isMiniPlayerRoute.value) syncTrayPlayback();
  },
);
watch(
  () => [
    settings.globalShortcutsEnabled,
    settings.globalShortcutBindings,
    settings.shortcutEnabled,
    settings.shortcutBindings,
  ],
  () => {
    if (!isMiniPlayerRoute.value) void syncGlobalShortcutsFn?.();
  },
  { deep: true },
);

// 切歌时，cover 模式下自动提取封面主色
watch(
  () => [player.value?.currentTrackSnapshot?.coverUrl, coverFallbackRevision.value],
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
  <Teleport v-if="!isMiniPlayerRoute" to="body">
    <Transition name="lyric-overlay">
      <LyricView v-if="player?.isLyricViewOpen" />
    </Transition>
  </Teleport>
  <AuthExpiredDialog v-if="!isMiniPlayerRoute" />
  <KugouVerificationFlow v-if="!isMiniPlayerRoute" />
  <ToastViewport v-if="!isMiniPlayerRoute" :lyric-view-open="Boolean(player?.isLyricViewOpen)" />
  <UpdateDialog v-if="!isMiniPlayerRoute" dismiss-label="稍后" />
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
