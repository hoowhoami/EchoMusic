import { onMounted, onUnmounted, shallowRef, watch, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { useOutputStore } from '@/stores/output';
import { useUpdateStore } from '@/stores/update';
import { usePlaylistStore } from '@/stores/playlist';
import { useHistoryStore } from '@/stores/historyStore';
import { useUserStore } from '@/stores/user';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import { normalizeQuality } from '@/stores/player/utils';
import { setupStartupPluginUpdateCheck } from '@/stores/pluginUpdates';
import { registerContentBlacklistIntegration } from '@/services/contentBlacklistIntegration';
import { installWindowFrame } from '@/utils/windowFrame';
import { setOpenThemesHandler } from '@/theme/registry';
import { settingsDialogOpen } from '@/composables/useSettingsDialog';
import { createAppLifetime } from './lifetime';
import { useAppAppearance } from './useAppAppearance';
import { useAppShare } from './useAppShare';
import { useAppUserSession } from './useAppUserSession';

export type AppPlayer = ReturnType<(typeof import('@/stores/player'))['usePlayerStore']>;
type SyncGlobalShortcuts = (typeof import('@/utils/shortcuts'))['syncGlobalShortcuts'];

/** Startup ordering and bridges owned by the main renderer, including Mini and taskbar sync. */
export function useAppRuntime(isMiniPlayerRoute: Readonly<Ref<boolean>>) {
  const router = useRouter();
  const settings = useSettingStore();
  const updateStore = useUpdateStore();
  const playlistStore = usePlaylistStore();
  const historyStore = useHistoryStore();
  const userStore = useUserStore();
  const player = shallowRef<AppPlayer | null>(null);
  const lifetime = createAppLifetime();
  onUnmounted(lifetime.dispose);
  const appearance = useAppAppearance(player, isMiniPlayerRoute, lifetime);
  const share = useAppShare(isMiniPlayerRoute, lifetime);
  useAppUserSession(lifetime);
  let syncGlobalShortcutsFn: SyncGlobalShortcuts | null = null;

  const syncTrayPlayback = () => {
    const activePlayer = player.value;
    if (!activePlayer) return;
    window.electron?.tray?.syncPlayback({
      isPlaying: activePlayer.isPlaying,
      playMode: activePlayer.playMode,
      volume: activePlayer.volume,
    });
  };

  onMounted(async () => {
    void useOutputStore().bind();
    if (!isMiniPlayerRoute.value) lifetime.add(installWindowFrame());
    await router.isReady();
    if (!lifetime.active) return;
    share.start();

    const { onPluginRuntimeReloadRequested, refreshPlugins } = await import('@/plugins/runtime');
    if (!lifetime.active) return;
    lifetime.add(
      onPluginRuntimeReloadRequested(() => {
        void refreshPlugins(
          isMiniPlayerRoute.value
            ? { miniPlayer: true, reloadActive: true }
            : { reloadActive: true },
        );
      }),
    );
    if (isMiniPlayerRoute.value) {
      void refreshPlugins({ miniPlayer: true });
      return;
    }

    // Listen before restoring the persisted system color mode.
    appearance.start();
    lifetime.add(registerContentBlacklistIntegration());
    const [
      { usePlayerStore },
      { initShortcutSync, syncGlobalShortcuts },
      { initDesktopLyricSync },
      { initMiniPlayerSync },
      { initNowPlayingSync },
      { setupTaskBridges },
    ] = await Promise.all([
      import('@/stores/player'),
      import('@/utils/shortcuts'),
      import('@/desktopLyric/sync'),
      import('@/miniPlayer/sync'),
      import('@/nowPlaying/sync'),
      import('@/tasks/taskBridges'),
    ]);
    if (!lifetime.active) return;
    const activePlayer = usePlayerStore();
    player.value = activePlayer;
    syncGlobalShortcutsFn = syncGlobalShortcuts;

    await waitForSqlitePersistHydration();
    if (!lifetime.active) return;
    // Fetch identity after persistence restores the logged-in state.
    if (userStore.isLoggedIn) void userStore.fetchUserInfoOnce();
    settings.defaultAudioQuality = normalizeQuality(settings.defaultAudioQuality);
    settings.ensureShortcutDefaults();
    await settings.hydrateLogSettings();
    if (!lifetime.active) return;
    await Promise.all([
      playlistStore.hydratePlaybackStateFromStorage(),
      playlistStore.hydratePersonalFmPreferences(),
      historyStore.hydrate(),
    ]);
    if (!lifetime.active) return;
    const recoveredLiveSession = await activePlayer.init();
    if (!lifetime.active) return;

    if (
      !recoveredLiveSession &&
      settings.autoPlayOnLaunch &&
      activePlayer.currentTrackId &&
      !activePlayer.isPlaying
    ) {
      const timer = window.setTimeout(() => {
        if (activePlayer.currentTrackId && !activePlayer.isPlaying) void activePlayer.togglePlay();
      }, 300);
      lifetime.add(() => window.clearTimeout(timer));
    }

    setOpenThemesHandler(() => {
      settingsDialogOpen.value = false;
      void router.push('/main/themes');
    });
    lifetime.add(() => setOpenThemesHandler(null));
    appearance.apply();
    void initDesktopLyricSync().then(lifetime.add);
    // Taskbar lyrics consume this shared now-playing channel; no separate publisher is needed.
    void initNowPlayingSync().then(lifetime.add);
    void initMiniPlayerSync().then(lifetime.add);
    await appearance.initWindowBackground();
    if (!lifetime.active) return;
    settings.syncTheme();
    settings.syncCloseBehavior();
    settings.syncRememberWindowSize();
    settings.syncTaskbarCoverPreview();
    settings.syncTaskbarProgress();
    settings.syncPreventSleep(activePlayer.isPlaying);
    settings.syncLogSettings();
    lifetime.add(initShortcutSync());
    lifetime.add(
      window.electron?.tray?.onSetPlayMode((playMode) => activePlayer.setPlayMode(playMode)),
    );
    // The main process owns engine recovery; the renderer refreshes device choices.
    lifetime.add(
      window.electron?.power?.onResume(() => {
        void activePlayer.refreshOutputDevices();
      }),
    );
    syncTrayPlayback();
    void updateStore.init();
    lifetime.add(() => updateStore.dispose());
    lifetime.add(setupTaskBridges());
    lifetime.add(setupStartupPluginUpdateCheck());
    if (settings.autoCheckUpdate) {
      const timer = window.setTimeout(() => {
        updateStore.check(true);
      }, 4000);
      lifetime.add(() => window.clearTimeout(timer));
    }
    void refreshPlugins();
    share.scheduleClipboardShareCheck();
  });

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
    () => [player.value?.playMode, player.value?.volume],
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

  return player;
}
