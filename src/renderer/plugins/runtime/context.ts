import * as Vue from 'vue';
import { watch, type App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import type {
  EchoPluginDescriptor,
  EchoPluginManifest,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginWebServerHandlerResult,
  PluginWebServerListenOptions,
  PluginWebServerRequest,
  PluginWindowBounds,
  PluginWindowShowOptions,
  PluginShowOnTopOptions,
  PluginHostWindowTarget,
} from '../../../shared/plugins';
import type {
  DesktopLyricSettings,
  DesktopLyricWindowBoundsUpdate,
} from '../../../shared/desktop-lyric';
import * as icons from '@/icons';
import { usePlayerStore } from '@/stores/player';
import type { PlayerEventName, PlayerEventPayload } from '@/stores/player/events';
import { usePlaylistStore } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { executePluginCommand, registerPluginCommand } from '../registry';
import { createKugouApi, type PluginKugouApi } from '../kugou';
import {
  createAppearanceApi,
  createAudioApi,
  createCoverApi,
  createDesktopLyricApi,
  createFontsApi,
  createKugouVerificationApi,
  createLyricEffectsApi,
  createLyricsApi,
  createPlayerApi,
  createPlaylistApi,
  createTaskApi,
  createToastApi,
  type PluginCoverApi,
} from './contextApis';
import {
  createPluginFsApi,
  createPluginHostApi,
  createPluginProcessApi,
  createPluginWindowsApi,
} from './hostApis';
import { serializeForIpc } from './ipc';
import { createPluginSqliteApi, createPluginWebServerApi } from './runtimeServices';
import { createDomApi, createRuntimeUiApi, createScrollApi } from './runtimeUi';
import { createShortcutsApi } from './shortcuts';
import { createStyleDisposer } from './styles';
import { createThemeApi, type PluginThemeApi } from './theme';

type PluginCallbackRunner = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
) => T;

type PluginRuntimeErrorReporter = (
  pluginId: string,
  error: unknown,
  source?: string,
  fallback?: string,
) => unknown;

export interface PluginRuntimeHost {
  app: VueApp;
  router: Router;
  pinia: Pinia;
}

interface PluginContextRuntimeDeps {
  runPluginCallback: PluginCallbackRunner;
  reportPluginRuntimeError: PluginRuntimeErrorReporter;
}

export interface EchoPluginContext {
  id: string;
  manifest: EchoPluginManifest;
  descriptor: EchoPluginDescriptor;
  app: VueApp;
  vue: typeof Vue;
  router: Router;
  pinia: Pinia;
  stores: {
    player: ReturnType<typeof usePlayerStore>;
    playlist: ReturnType<typeof usePlaylistStore>;
    lyric: ReturnType<typeof useLyricStore>;
    settings: ReturnType<typeof useSettingStore>;
    theme: ReturnType<typeof useThemeStore>;
  };
  player: ReturnType<typeof createPlayerApi>;
  audio: ReturnType<typeof createAudioApi>;
  playlist: ReturnType<typeof createPlaylistApi>;
  lyric: ReturnType<typeof useLyricStore>;
  lyrics: ReturnType<typeof createLyricsApi>;
  lyricEffects: ReturnType<typeof createLyricEffectsApi>;
  kugou: PluginKugouApi;
  kugouVerification: ReturnType<typeof createKugouVerificationApi>;
  settings: ReturnType<typeof useSettingStore>;
  theme: PluginThemeApi;
  appearance: ReturnType<typeof createAppearanceApi>;
  fonts: ReturnType<typeof createFontsApi>;
  cover: PluginCoverApi;
  scroll: ReturnType<typeof createScrollApi>;
  appIcons: {
    refresh: () => Promise<unknown>;
    restoreDefaultDesktopIcon: () => Promise<unknown>;
    restoreDefaultTaskbarIcon: () => Promise<unknown>;
    setRuntimeWindowIcon: (iconPath: string) => Promise<unknown>;
    restoreDefaultWindowIcon: () => Promise<unknown>;
  };
  nowPlaying: Window['electron']['nowPlaying'];
  desktopLyric: {
    getSnapshot: () => ReturnType<Window['electron']['desktopLyric']['getSnapshot']>;
    getWindow: () => ReturnType<Window['electron']['desktopLyric']['getWindow']>;
    show: () => ReturnType<Window['electron']['desktopLyric']['show']>;
    hide: () => ReturnType<Window['electron']['desktopLyric']['hide']>;
    updateSettings: (
      payload: Partial<DesktopLyricSettings>,
    ) => ReturnType<Window['electron']['desktopLyric']['updateSettings']>;
    updateWindow: (
      payload: DesktopLyricWindowBoundsUpdate,
    ) => ReturnType<Window['electron']['desktopLyric']['updateWindow']>;
  };
  windows: {
    show: (windowId: string, options?: PluginWindowShowOptions) => Promise<unknown>;
    hide: (windowId: string) => Promise<unknown>;
    close: (windowId: string) => Promise<unknown>;
    move: (windowId: string, bounds: Partial<PluginWindowBounds>) => Promise<unknown>;
    getBounds: (windowId: string) => Promise<unknown>;
    setIgnoreMouseEvents: (windowId: string, ignore: boolean) => Promise<unknown>;
    showOnTop: (windowId: string, options?: PluginShowOnTopOptions) => Promise<unknown>;
  };
  host: {
    showOnTop: (
      target?: PluginHostWindowTarget,
      options?: PluginShowOnTopOptions,
    ) => Promise<unknown>;
  };
  toast: ReturnType<typeof createToastApi>;
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  dialog: NonNullable<Window['electron']['plugins']>['dialog'];
  fs: ReturnType<typeof createPluginFsApi>;
  process: {
    launch: (options: PluginProcessLaunchOptions) => Promise<PluginProcessLaunchResult>;
    terminate: (pid: number) => Promise<PluginProcessTerminateResult>;
  };
  webServer: {
    listen: (
      handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
      options?: PluginWebServerListenOptions,
    ) => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['listen']>;
    status: () => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['status']>;
    close: () => ReturnType<NonNullable<Window['electron']['plugins']>['webServer']['close']>;
    onRequest: (
      handler: (request: PluginWebServerRequest) => PluginWebServerHandlerResult,
    ) => () => void;
  };
  sqlite: ReturnType<typeof createPluginSqliteApi>;
  ui: ReturnType<typeof createRuntimeUiApi>;
  commands: {
    register: (
      id: string,
      handler: (...args: unknown[]) => unknown,
      options?: { title?: string },
    ) => () => void;
    execute: (id: string, ...args: unknown[]) => unknown;
  };
  shortcuts: {
    register: (accelerator: string, handler: () => void) => () => void;
    registerGlobal: (accelerator: string, handler: () => void) => Promise<() => void>;
  };
  css: {
    inject: (cssText: string, options?: { id?: string }) => () => void;
  };
  events: {
    onTrackChange: (handler: (track: unknown) => void) => () => void;
    onPlaybackChange: (handler: (isPlaying: boolean) => void) => () => void;
    onPlaybackStateChange: (
      handler: (state: ReturnType<typeof usePlayerStore>['playbackDisplayState']) => void,
    ) => () => void;
    onPlay: (
      handler: (payload: PlayerEventPayload) => void,
      options?: { immediate?: boolean },
    ) => () => void;
    onPause: (handler: (payload: PlayerEventPayload) => void) => () => void;
    onEnded: (handler: (payload: PlayerEventPayload) => void) => () => void;
    onSeek: (handler: (payload: PlayerEventPayload) => void) => () => void;
    onError: (handler: (payload: PlayerEventPayload) => void) => () => void;
    onTimeUpdate: (handler: (payload: PlayerEventPayload) => void) => () => void;
    on: (event: PlayerEventName, handler: (payload: PlayerEventPayload) => void) => () => void;
  };
  dom: {
    query: <T extends Element = Element>(selector: string) => T | null;
    queryAll: <T extends Element = Element>(selector: string) => T[];
    observe: (
      selector: string,
      handler: (element: Element) => void | (() => void),
      options?: { root?: Element | Document; once?: boolean },
    ) => () => void;
  };
  net: {
    fetch: typeof fetch;
  };
  icons: typeof icons;
  tasks: ReturnType<typeof createTaskApi>;
  electron: Window['electron'];
  dispose: (dispose: () => void) => () => void;
}

export const createPluginContext = (
  descriptor: EchoPluginDescriptor,
  host: PluginRuntimeHost,
  disposables: Array<() => void>,
  deps: PluginContextRuntimeDeps,
): EchoPluginContext => {
  const { reportPluginRuntimeError, runPluginCallback } = deps;
  const addDisposable = (dispose: () => void) => {
    disposables.push(dispose);
    return dispose;
  };
  const playerStore = usePlayerStore();

  const registerPlayerEvent = (
    event: PlayerEventName,
    handler: (payload: PlayerEventPayload) => void,
    options?: { immediate?: boolean },
  ) => {
    const wrapped = (payload: PlayerEventPayload) =>
      runPluginCallback(descriptor.id, `播放事件: ${event}`, () => handler(payload), undefined);
    const off = playerStore.onPlayerEvent(event, wrapped);
    addDisposable(off);
    // immediate：订阅时若当前已处于该状态，立即用当前状态回调一次（仅对 play 有意义）
    if (options?.immediate && event === 'play' && playerStore.isPlaying) {
      wrapped(playerStore.getPlayerEventPayload('play'));
    }
    return off;
  };
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();
  const apiDeps = {
    addDisposable,
    runPluginCallback,
    reportPluginRuntimeError,
  };

  const context: EchoPluginContext = {
    id: descriptor.id,
    manifest: descriptor.manifest,
    descriptor,
    app: host.app,
    vue: Vue,
    router: host.router,
    pinia: host.pinia,
    stores: {
      player: playerStore,
      playlist: playlistStore,
      lyric: lyricStore,
      settings: settingStore,
      theme: themeStore,
    },
    player: createPlayerApi(descriptor, apiDeps),
    audio: createAudioApi(descriptor, apiDeps),
    playlist: createPlaylistApi(),
    lyric: lyricStore,
    lyrics: createLyricsApi(descriptor, apiDeps),
    lyricEffects: createLyricEffectsApi(descriptor, apiDeps),
    kugou: createKugouApi(descriptor),
    kugouVerification: createKugouVerificationApi(descriptor),
    settings: settingStore,
    theme: createThemeApi(descriptor.id, addDisposable),
    appearance: createAppearanceApi(descriptor.id, apiDeps),
    fonts: createFontsApi(),
    cover: createCoverApi(() => themeStore.sourceColor),
    scroll: createScrollApi(descriptor.id, addDisposable, runPluginCallback),
    appIcons: {
      refresh: () => window.electron.plugins?.icons.refresh() ?? Promise.resolve({ ok: false }),
      restoreDefaultDesktopIcon: () =>
        window.electron.plugins?.icons.restoreDefaultDesktopIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      restoreDefaultTaskbarIcon: () =>
        window.electron.plugins?.icons.restoreDefaultTaskbarIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      setRuntimeWindowIcon: (iconPath: string) =>
        window.electron.plugins?.icons.setRuntimeWindowIcon(iconPath) ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
      restoreDefaultWindowIcon: () =>
        window.electron.plugins?.icons.restoreDefaultWindowIcon() ??
        Promise.resolve({ ok: false, error: '图标 API 不可用' }),
    },
    nowPlaying: window.electron.nowPlaying,
    desktopLyric: createDesktopLyricApi(),
    windows: createPluginWindowsApi(descriptor.id),
    host: createPluginHostApi(),
    toast: createToastApi(),
    storage: {
      get: <T = unknown>(key: string) =>
        window.electron.plugins?.storage.get<T>(descriptor.id, key) ?? Promise.resolve(null),
      set: (key: string, value: unknown) =>
        window.electron.plugins?.storage.set(descriptor.id, key, serializeForIpc(value)) ??
        Promise.resolve(null),
      delete: (key: string) =>
        window.electron.plugins?.storage.delete(descriptor.id, key) ?? Promise.resolve(null),
    },
    dialog: {
      selectDirectory: (options) =>
        window.electron.plugins?.dialog.selectDirectory(
          serializeForIpc(options) as typeof options,
        ) ?? Promise.resolve({ canceled: true, paths: [] }),
      selectFiles: (options) =>
        window.electron.plugins?.dialog.selectFiles(serializeForIpc(options) as typeof options) ??
        Promise.resolve({ canceled: true, paths: [] }),
    },
    fs: createPluginFsApi(descriptor.id),
    process: createPluginProcessApi(descriptor.id),
    webServer: createPluginWebServerApi(
      descriptor,
      addDisposable,
      runPluginCallback,
      reportPluginRuntimeError,
    ),
    sqlite: createPluginSqliteApi(descriptor, addDisposable),
    ui: createRuntimeUiApi(
      descriptor.id,
      host,
      addDisposable,
      runPluginCallback,
      reportPluginRuntimeError,
    ),
    commands: {
      register: (id, handler, options) => {
        const dispose = registerPluginCommand(descriptor.id, {
          id,
          title: options?.title,
          handler: (...args) =>
            runPluginCallback(
              descriptor.id,
              `插件命令: ${options?.title || id}`,
              () => handler(...args),
              undefined,
            ),
        });
        return addDisposable(dispose);
      },
      execute: executePluginCommand,
    },
    shortcuts: createShortcutsApi(descriptor.id, addDisposable, runPluginCallback),
    css: {
      inject: (cssText, options) =>
        addDisposable(createStyleDisposer(descriptor.id, cssText, options?.id)),
    },
    events: {
      onTrackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.currentTrackSnapshot,
            (track) =>
              runPluginCallback(descriptor.id, '播放曲目变化事件', () => handler(track), undefined),
            { deep: true },
          ),
        ),
      onPlaybackChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.isPlaying,
            (isPlaying) =>
              runPluginCallback(
                descriptor.id,
                '播放状态变化事件',
                () => handler(isPlaying),
                undefined,
              ),
          ),
        ),
      onPlaybackStateChange: (handler) =>
        addDisposable(
          watch(
            () => playerStore.playbackDisplayState,
            (state) =>
              runPluginCallback(
                descriptor.id,
                '播放展示状态变化事件',
                () => handler(state),
                undefined,
              ),
          ),
        ),
      onPlay: (handler, options) => registerPlayerEvent('play', handler, options),
      onPause: (handler) => registerPlayerEvent('pause', handler),
      onEnded: (handler) => registerPlayerEvent('ended', handler),
      onSeek: (handler) => registerPlayerEvent('seek', handler),
      onError: (handler) => registerPlayerEvent('error', handler),
      onTimeUpdate: (handler) => registerPlayerEvent('timeupdate', handler),
      on: (event, handler) => registerPlayerEvent(event, handler),
    },
    dom: createDomApi(descriptor.id, addDisposable, runPluginCallback),
    net: {
      fetch: window.fetch.bind(window),
    },
    icons,
    tasks: createTaskApi(descriptor.id),
    electron: window.electron,
    dispose: addDisposable,
  };

  return context;
};
