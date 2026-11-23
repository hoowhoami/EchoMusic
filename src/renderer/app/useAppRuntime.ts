import { computed, onMounted, onUnmounted, shallowRef, watch, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSettingStore } from '@/stores/setting';
import { useOutputStore } from '@/stores/output';
import { useUpdateStore } from '@/stores/update';
import { usePlaylistStore } from '@/stores/playlist';
import { resolveSongHistoryId, useHistoryStore } from '@/stores/historyStore';
import { useUserStore } from '@/stores/user';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import { normalizeQuality } from '@/stores/player/utils';
import { setupStartupPluginUpdateCheck } from '@/stores/pluginUpdates';
import { registerContentBlacklistIntegration } from '@/services/contentBlacklistIntegration';
import { installWindowFrame } from '@/utils/windowFrame';
import {
  RESUME_HINT_MAX_SECS,
  RESUME_HINT_MIN_SECS,
  setResumeHintConfig,
} from '@/utils/resumeHint';
import { setOpenThemesHandler } from '@/theme/registry';
import { settingsDialogOpen } from '@/composables/useSettingsDialog';
import { createAppLifetime } from './lifetime';
import { useAppAppearance } from './useAppAppearance';
import { useAppShare } from './useAppShare';
import { useAppUserSession } from './useAppUserSession';

export type AppPlayer = ReturnType<(typeof import('@/stores/player'))['usePlayerStore']>;
type SyncGlobalShortcuts = (typeof import('@/utils/shortcuts'))['syncGlobalShortcuts'];

/** Startup ordering and bridges owned by the main renderer, including Mini and taskbar sync. */
export function useAppRuntime(
  isMiniPlayerRoute: Readonly<Ref<boolean>>,
  isWallpaperRoute?: Readonly<Ref<boolean>>,
) {
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

  const trayTrackTitle = computed(() => {
    const track = player.value?.currentTrackSnapshot;
    return track ? String(track.name || track.title || '未知歌曲') : '';
  });
  const trayTrackArtist = computed(() => {
    const track = player.value?.currentTrackSnapshot;
    return String(track?.artist || track?.artists?.map((item) => item.name).join(' / ') || '');
  });

  const syncTrayPlayback = () => {
    const activePlayer = player.value;
    if (!activePlayer) return;
    window.electron?.tray?.syncPlayback({
      isPlaying: activePlayer.isPlaying,
      playMode: activePlayer.playMode,
      volume: activePlayer.volume,
      trackTitle: trayTrackTitle.value,
      trackArtist: trayTrackArtist.value,
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
    if (isWallpaperRoute?.value) {
      // 壁纸窗口只是桌面层上的一张画面：不初始化播放引擎、不抢播放状态、
      // 不发布歌词与进度、不碰托盘/更新检查/剪贴板分享。
      // 只保留主题变量与插件运行时 —— 插件歌词页要按主窗口的皮肤渲染。
      appearance.start();
      appearance.apply();
      void refreshPlugins();
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

    // 续播记录跟播放历史共用一份容量：历史里已经没有的曲目，续播进度与桶一并清掉。
    // 两个前提：历史必须真的读成功了（读失败/未读完时 entries 是空的，据此裁剪会把数据全删），
    // 且当前窗口要拥有播放引擎（壁纸窗口只做镜像，不该改动这份数据）。
    const canPruneResume = () => historyStore.hydrated && !isWallpaperRoute?.value;
    const pruneResumeWithHistory = () => {
      if (!canPruneResume()) return;
      const trackIds = historyStore.entries.map((entry) => resolveSongHistoryId(entry.song));
      // 空列表不能当作「历史里一首都不剩」的证据：只要有一次读到空快照，裁剪就会把
      // 续播记录和全部桶一起删光，之后任何页面都再没有续播卡可显示。
      if (trackIds.length === 0) return;
      activePlayer.pruneResumeAgainstHistory(trackIds);
    };
    pruneResumeWithHistory();
    if (canPruneResume()) activePlayer.dedupeAlbumAudiobookScopes();

    // 续播卡的三个开关与停留时长跟着设置走：设置页一改，下一次弹卡立即生效
    const syncResumeHintConfig = () => {
      const secs = Math.max(
        RESUME_HINT_MIN_SECS,
        Math.min(Number(settings.resumeHintVisibleSecs) || 10, RESUME_HINT_MAX_SECS),
      );
      const enabled = settings.resumeHintEnabled !== false;
      setResumeHintConfig({
        enabled,
        popup: enabled && settings.resumeHintPopupEnabled !== false,
        page: enabled && settings.resumeHintPageEnabled !== false,
        visibleMs: secs * 1000,
      });
    };
    syncResumeHintConfig();
    lifetime.add(
      watch(
        [
          () => settings.resumeHintEnabled,
          () => settings.resumeHintPopupEnabled,
          () => settings.resumeHintPageEnabled,
          () => settings.resumeHintVisibleSecs,
        ],
        syncResumeHintConfig,
      ),
    );
    lifetime.add(
      watch(
        [() => historyStore.entries.length, () => historyStore.playRecordVersion],
        pruneResumeWithHistory,
      ),
    );

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
    // 壁纸窗口是纯消费者：它没有播放引擎，不该往主进程推歌词和播放状态。
    if (!isWallpaperRoute?.value) {
      void initDesktopLyricSync().then(lifetime.add);
      // Taskbar lyrics consume this shared now-playing channel; no separate publisher is needed.
      void initNowPlayingSync().then(lifetime.add);
    }
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
  watch([() => player.value?.currentTrackId, trayTrackTitle, trayTrackArtist], () => {
    if (!isMiniPlayerRoute.value) syncTrayPlayback();
  });
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
