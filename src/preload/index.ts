import { contextBridge, ipcRenderer } from 'electron';
import log from 'electron-log/renderer';
import type { ApiServerStatus } from '../shared/api-server';
import type { AppInfoResult, UpdateDownloadResult } from '../shared/app';
import type { PlayMode } from '../shared/playback';
import type { ShortcutCommand, ShortcutMap, ShortcutRegistrationResult } from '../shared/shortcuts';
import type {
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';
import type {
  MiniPlayerCommand,
  MiniPlayerSnapshot,
  MiniPlayerSnapshotPatch,
} from '../shared/mini-player';
import type {
  ImportImpulseResponseResult,
  ImpulseResponseFile,
  ImpulseResponsePlaybackOptions,
} from '../shared/audio';
import type { LogSettings } from '../shared/logging';
import type { RecognizeResponse } from '../shared/shazam';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../shared/external';
import type {
  PluginAssetSourceResult,
  PluginDialogResult,
  PluginFileUrlResult,
  PluginFailureRecord,
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
  PluginListResult,
  PluginOpenDialogOptions,
  PluginReportFailureResult,
  PluginSetEnabledResult,
  PluginSetSafeModeResult,
  PluginUninstallResult,
} from '../shared/plugins';
import type {
  StorageAppendQueueItemsPayload,
  StoragePlaybackSnapshot,
  StoragePlaybackQueueState,
  StorageQueueIdPayload,
  StorageReplaceQueuePayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageResetResult,
  StorageSetQueueCurrentTrackPayload,
  StorageUpdateQueueMetaPayload,
} from '../shared/storage';

const ipcListenerMap = new Map<
  string,
  WeakMap<(...args: any[]) => void, (...args: any[]) => void>
>();

const getWrappedListener = (channel: string, func: (...args: any[]) => void) => {
  let channelMap = ipcListenerMap.get(channel);
  if (!channelMap) {
    channelMap = new WeakMap();
    ipcListenerMap.set(channel, channelMap);
  }

  const existing = channelMap.get(func);
  if (existing) return existing;

  const wrapped = (_event: Electron.IpcRendererEvent, ...args: any[]) => func(...args);
  channelMap.set(func, wrapped);
  return wrapped;
};

const toPlainIpcPayload = <T>(value: T): T => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;

  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, nextValue) => {
      if (typeof nextValue === 'bigint') return nextValue.toString();
      if (typeof nextValue !== 'object' || nextValue === null) return nextValue;
      if (seen.has(nextValue)) return undefined;
      seen.add(nextValue);
      return nextValue;
    }),
  ) as T;
};

const invokeWithPlainPayload = <T = unknown>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args.map(toPlainIpcPayload)) as Promise<T>;

const sendWithPlainPayload = (channel: string, ...args: unknown[]) => {
  ipcRenderer.send(channel, ...args.map(toPlainIpcPayload));
};

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => sendWithPlainPayload(channel, ...args),
    invoke: (channel: string, ...args: any[]) => invokeWithPlainPayload(channel, ...args),
    on: (channel: string, func: (...args: any[]) => void) => {
      const wrapped = getWrappedListener(channel, func);
      ipcRenderer.on(channel, wrapped);
    },
    off: (channel: string, func: (...args: any[]) => void) => {
      const wrapped = ipcListenerMap.get(channel)?.get(func);
      if (wrapped) {
        ipcRenderer.removeListener(channel, wrapped);
      }
    },
  },
  shortcuts: {
    register: (payload: { enabled: boolean; shortcutMap: ShortcutMap }) =>
      invokeWithPlainPayload<ShortcutRegistrationResult>('shortcuts:register', payload),
    refresh: () => ipcRenderer.invoke('shortcuts:refresh') as Promise<ShortcutRegistrationResult>,
    onTrigger: (func: (command: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: string) => func(command);
      ipcRenderer.on('shortcut-trigger', listener);
      return () => ipcRenderer.removeListener('shortcut-trigger', listener);
    },
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') =>
    ipcRenderer.send('window-control', action),
  appInfo: {
    get: () => ipcRenderer.invoke('app:get-info') as Promise<AppInfoResult>,
    getChangelog: () => ipcRenderer.invoke('app:get-changelog') as Promise<string>,
  },
  fonts: {
    getAll: () => ipcRenderer.invoke('get-all-fonts') as Promise<string[]>,
  },
  audioEffects: {
    importImpulseResponse: () =>
      ipcRenderer.invoke('audio:import-impulse-response') as Promise<ImportImpulseResponseResult>,
    deleteImpulseResponse: (filePath: string) =>
      ipcRenderer.invoke('audio:delete-impulse-response', filePath) as Promise<boolean>,
    reconcileImpulseResponses: (files: ImpulseResponseFile[]) =>
      invokeWithPlainPayload<ImpulseResponseFile[]>('audio:reconcile-impulse-responses', files),
  },
  updater: {
    download: () => ipcRenderer.send('update:download'),
    install: (silent?: boolean) => ipcRenderer.send('update:install', { silent: !!silent }),
    onDownloadStatus: (func: (result: UpdateDownloadResult) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: UpdateDownloadResult) =>
        func(result);
      ipcRenderer.on('update-download-status', listener);
      return () => ipcRenderer.removeListener('update-download-status', listener);
    },
  },
  apiServer: {
    start: () => ipcRenderer.invoke('api-server:start'),
    status: () => ipcRenderer.invoke('api-server:status') as Promise<ApiServerStatus>,
  },
  api: {
    request: (config: {
      method: string;
      url: string;
      params?: Record<string, any>;
      data?: any;
      headers?: Record<string, string>;
    }) => invokeWithPlainPayload('api:request', config),
  },
  tray: {
    syncPlayback: (payload: { isPlaying?: boolean; playMode?: PlayMode; volume?: number }) =>
      sendWithPlainPayload('tray:sync-playback', payload),
    onSetPlayMode: (func: (playMode: PlayMode) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, playMode: PlayMode) => func(playMode);
      ipcRenderer.on('tray:set-play-mode', listener);
      return () => ipcRenderer.removeListener('tray:set-play-mode', listener);
    },
  },
  power: {
    onSuspend: (func: () => void) => {
      const listener = () => func();
      ipcRenderer.on('power:suspend', listener);
      return () => ipcRenderer.removeListener('power:suspend', listener);
    },
    onResume: (func: () => void) => {
      const listener = () => func();
      ipcRenderer.on('power:resume', listener);
      return () => ipcRenderer.removeListener('power:resume', listener);
    },
  },
  desktopLyric: {
    getSnapshot: () =>
      ipcRenderer.invoke('desktop-lyric:get-snapshot') as Promise<DesktopLyricSnapshot>,
    show: () => ipcRenderer.invoke('desktop-lyric:show') as Promise<DesktopLyricSnapshot>,
    hide: () => ipcRenderer.invoke('desktop-lyric:hide') as Promise<DesktopLyricSnapshot>,
    toggleLock: () =>
      ipcRenderer.invoke('desktop-lyric:toggle-lock') as Promise<DesktopLyricSnapshot>,
    updateSettings: (payload: Partial<DesktopLyricSettings>) =>
      invokeWithPlainPayload<DesktopLyricSnapshot>('desktop-lyric:update-settings', payload),
    syncSnapshot: (payload: DesktopLyricSnapshotPatch) =>
      sendWithPlainPayload('desktop-lyric:sync-snapshot', payload),
    onSnapshot: (func: (snapshot: DesktopLyricSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshotPayload: DesktopLyricSnapshot) =>
        func(snapshotPayload);
      ipcRenderer.on('desktop-lyric:snapshot', listener);
      return () => ipcRenderer.removeListener('desktop-lyric:snapshot', listener);
    },
    setIgnoreMouseEvents: (ignore: boolean) =>
      ipcRenderer.send('desktop-lyric:set-ignore-mouse-events', ignore),
    command: (
      command: Extract<
        ShortcutCommand,
        | 'togglePlayback'
        | 'previousTrack'
        | 'nextTrack'
        | 'toggleLyricsMode'
        | 'cycleLyricsMode'
        | 'openLyricSource'
      >,
    ) => ipcRenderer.send('desktop-lyric:command', command),
  },
  miniPlayer: {
    getSnapshot: () =>
      ipcRenderer.invoke('mini-player:get-snapshot') as Promise<MiniPlayerSnapshot>,
    show: () => ipcRenderer.invoke('mini-player:show') as Promise<MiniPlayerSnapshot>,
    hide: () => ipcRenderer.invoke('mini-player:hide') as Promise<MiniPlayerSnapshot>,
    syncSnapshot: (payload: MiniPlayerSnapshotPatch) =>
      sendWithPlainPayload('mini-player:sync-snapshot', payload),
    setExpanded: (expanded: boolean) =>
      ipcRenderer.invoke('mini-player:set-expanded', expanded) as Promise<MiniPlayerSnapshot>,
    setAlwaysOnTop: (alwaysOnTop: boolean) =>
      ipcRenderer.invoke(
        'mini-player:set-always-on-top',
        alwaysOnTop,
      ) as Promise<MiniPlayerSnapshot>,
    getBounds: () =>
      ipcRenderer.invoke('mini-player:get-bounds') as Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>,
    move: (x: number, y: number) => ipcRenderer.send('mini-player:move', x, y),
    applyExpandBounds: () =>
      ipcRenderer.invoke('mini-player:apply-expand-bounds') as Promise<MiniPlayerSnapshot>,
    onSnapshot: (func: (snapshot: MiniPlayerSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshotPayload: MiniPlayerSnapshot) =>
        func(snapshotPayload);
      ipcRenderer.on('mini-player:snapshot', listener);
      return () => ipcRenderer.removeListener('mini-player:snapshot', listener);
    },
    command: (command: MiniPlayerCommand) => ipcRenderer.send('mini-player:command', command),
    onCommand: (func: (command: MiniPlayerCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: MiniPlayerCommand) =>
        func(command);
      ipcRenderer.on('mini-player:command', listener);
      return () => ipcRenderer.removeListener('mini-player:command', listener);
    },
    notifyLyricVisibility: (visible: boolean) =>
      ipcRenderer.send('mini-player:lyric-visibility', visible),
    onLyricVisibility: (func: (visible: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => func(visible);
      ipcRenderer.on('mini-player:lyric-visibility', listener);
      return () => ipcRenderer.removeListener('mini-player:lyric-visibility', listener);
    },
  },
  log: log.functions,
  logging: {
    get: () => ipcRenderer.invoke('logging:get-settings') as Promise<LogSettings>,
    update: (settings: Partial<LogSettings>) =>
      invokeWithPlainPayload<LogSettings>('logging:update-settings', settings),
  },
  mpv: {
    load: (url: string) => ipcRenderer.invoke('mpv:load', url),
    loadMkvTrack: (url: string, trackId: number) =>
      ipcRenderer.invoke('mpv:load-mkv-track', url, trackId),
    getTrackList: () => ipcRenderer.invoke('mpv:get-track-list'),
    play: () => ipcRenderer.invoke('mpv:play'),
    pause: () => ipcRenderer.invoke('mpv:pause'),
    stop: () => ipcRenderer.invoke('mpv:stop'),
    seek: (time: number) => ipcRenderer.invoke('mpv:seek', time),
    setVolume: (volume: number) => ipcRenderer.invoke('mpv:set-volume', volume),
    setSpeed: (speed: number) => ipcRenderer.invoke('mpv:set-speed', speed),
    setEqualizer: (gains: number[]) => invokeWithPlainPayload('mpv:set-equalizer', gains),
    setImpulseResponse: (payload: string | ImpulseResponsePlaybackOptions) =>
      invokeWithPlainPayload('mpv:set-impulse-response', payload),
    getAudioFilter: () => ipcRenderer.invoke('mpv:get-audio-filter') as Promise<string>,
    setAudioDevice: (deviceName: string) => ipcRenderer.invoke('mpv:set-audio-device', deviceName),
    getAudioDevices: () =>
      ipcRenderer.invoke('mpv:get-audio-devices') as Promise<
        Array<{ name: string; description: string }>
      >,
    setNormalizationGain: (gainDb: number) =>
      ipcRenderer.invoke('mpv:set-normalization-gain', gainDb),
    fade: (from: number, to: number, durationMs: number) =>
      ipcRenderer.invoke('mpv:fade', from, to, durationMs),
    cancelFade: () => ipcRenderer.invoke('mpv:cancel-fade'),
    pauseWithFade: (savedVolume: number, durationMs: number) =>
      ipcRenderer.invoke('mpv:pause-with-fade', savedVolume, durationMs),
    playWithFade: (targetVolume: number, durationMs: number) =>
      ipcRenderer.invoke('mpv:play-with-fade', targetVolume, durationMs),
    getState: () => ipcRenderer.invoke('mpv:get-state'),
    available: () => ipcRenderer.invoke('mpv:available') as Promise<boolean>,
    restart: () => ipcRenderer.invoke('mpv:restart') as Promise<boolean>,
    setExclusive: (exclusive: boolean) => ipcRenderer.invoke('mpv:set-exclusive', exclusive),
    setMediaTitle: (title: string) => ipcRenderer.invoke('mpv:set-media-title', title),
    setLoopFile: (loop: boolean) => ipcRenderer.invoke('mpv:set-loop-file', loop),
    onTimeUpdate: (func: (time: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, time: number) => func(time);
      ipcRenderer.on('mpv:time-update', listener);
      return () => ipcRenderer.removeListener('mpv:time-update', listener);
    },
    onDurationChange: (func: (duration: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, duration: number) => func(duration);
      ipcRenderer.on('mpv:duration-change', listener);
      return () => ipcRenderer.removeListener('mpv:duration-change', listener);
    },
    onStateChange: (func: (state: { playing?: boolean; paused?: boolean }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: { playing?: boolean; paused?: boolean },
      ) => func(state);
      ipcRenderer.on('mpv:state-change', listener);
      return () => ipcRenderer.removeListener('mpv:state-change', listener);
    },
    onPlaybackEnd: (func: (reason: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, reason: string) => func(reason);
      ipcRenderer.on('mpv:playback-end', listener);
      return () => ipcRenderer.removeListener('mpv:playback-end', listener);
    },
    onError: (func: (message: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string) => func(message);
      ipcRenderer.on('mpv:error', listener);
      return () => ipcRenderer.removeListener('mpv:error', listener);
    },
    onImpulseResponseDisabled: (func: (payload: { path?: string; reason?: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { path?: string; reason?: string },
      ) => func(payload);
      ipcRenderer.on('mpv:impulse-response-disabled', listener);
      return () => ipcRenderer.removeListener('mpv:impulse-response-disabled', listener);
    },
    onAudioDeviceListChanged: (
      func: (devices: Array<{ name: string; description: string }>) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        devices: Array<{ name: string; description: string }>,
      ) => func(devices);
      ipcRenderer.on('mpv:audio-device-list-changed', listener);
      return () => ipcRenderer.removeListener('mpv:audio-device-list-changed', listener);
    },
  },
  shazam: {
    recognize: (pcmData: ArrayBuffer) =>
      ipcRenderer.invoke('shazam:recognize', pcmData) as Promise<RecognizeResponse>,
    enableLoopback: () => ipcRenderer.invoke('enable-loopback-audio'),
    disableLoopback: () => ipcRenderer.invoke('disable-loopback-audio'),
  },
  external: {
    resolvePlaylist: (req: ResolvePlaylistRequest) =>
      invokeWithPlainPayload<ResolvePlaylistResponse>('external:resolve-playlist', req),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list') as Promise<PluginListResult>,
    getDirectory: () => ipcRenderer.invoke('plugins:get-directory') as Promise<string>,
    openDirectory: () => ipcRenderer.invoke('plugins:open-directory') as Promise<string>,
    setEnabled: (pluginId: string, enabled: boolean) =>
      ipcRenderer.invoke(
        'plugins:set-enabled',
        pluginId,
        enabled,
      ) as Promise<PluginSetEnabledResult>,
    setSafeMode: (enabled: boolean) =>
      ipcRenderer.invoke('plugins:set-safe-mode', enabled) as Promise<PluginSetSafeModeResult>,
    uninstall: (pluginId: string) =>
      ipcRenderer.invoke('plugins:uninstall', pluginId) as Promise<PluginUninstallResult>,
    markStartup: (pluginIds: string[]) =>
      invokeWithPlainPayload<PluginReportFailureResult>('plugins:startup:mark', pluginIds),
    clearStartup: () =>
      ipcRenderer.invoke('plugins:startup:clear') as Promise<PluginReportFailureResult>,
    setActiveSession: (pluginIds: string[]) =>
      invokeWithPlainPayload<PluginReportFailureResult>('plugins:active-session:set', pluginIds),
    reportFailure: (
      failure: Omit<PluginFailureRecord, 'createdAt'> & {
        createdAt?: number;
        safeMode?: boolean;
      },
    ) => invokeWithPlainPayload<PluginReportFailureResult>('plugins:failure:report', failure),
    readAsset: (pluginId: string, asset: 'main' | 'style') =>
      ipcRenderer.invoke('plugins:read-asset', pluginId, asset) as Promise<PluginAssetSourceResult>,
    dialog: {
      selectDirectory: (options?: PluginOpenDialogOptions) =>
        invokeWithPlainPayload<PluginDialogResult>('plugins:dialog:select-directory', options),
      selectFiles: (options?: PluginOpenDialogOptions) =>
        invokeWithPlainPayload<PluginDialogResult>('plugins:dialog:select-files', options),
    },
    fs: {
      listImageFiles: (directoryPath: string, options?: PluginListImageFilesOptions) =>
        invokeWithPlainPayload<PluginListImageFilesResult>(
          'plugins:fs:list-image-files',
          directoryPath,
          options,
        ),
      getFileUrl: (filePath: string) =>
        ipcRenderer.invoke('plugins:fs:get-file-url', filePath) as Promise<PluginFileUrlResult>,
    },
    storage: {
      get: <T = unknown>(pluginId: string, key: string) =>
        ipcRenderer.invoke('plugins:data:get', pluginId, key) as Promise<T | null>,
      set: (pluginId: string, key: string, value: unknown) =>
        invokeWithPlainPayload('plugins:data:set', pluginId, key, value),
      delete: (pluginId: string, key: string) =>
        ipcRenderer.invoke('plugins:data:delete', pluginId, key),
    },
  },
  storage: {
    getPlaybackSnapshot: () =>
      ipcRenderer.invoke('storage:playback:get-snapshot') as Promise<StoragePlaybackSnapshot>,
    getPlaybackQueue: (payload: StorageQueueIdPayload) =>
      invokeWithPlainPayload(
        'storage:playback:get-queue',
        payload,
      ) as Promise<StoragePlaybackQueueState | null>,
    replacePlaybackQueue: (payload: StorageReplaceQueuePayload) =>
      invokeWithPlainPayload(
        'storage:playback:replace-queue',
        payload,
      ) as Promise<StorageResetResult>,
    appendPlaybackQueueItems: (payload: StorageAppendQueueItemsPayload) =>
      invokeWithPlainPayload(
        'storage:playback:append-items',
        payload,
      ) as Promise<StorageResetResult>,
    updatePlaybackQueueMeta: (payload: StorageUpdateQueueMetaPayload) =>
      invokeWithPlainPayload(
        'storage:playback:update-queue-meta',
        payload,
      ) as Promise<StorageResetResult>,
    clearPlaybackQueue: (payload: StorageUpdateQueueMetaPayload) =>
      invokeWithPlainPayload(
        'storage:playback:clear-queue',
        payload,
      ) as Promise<StorageResetResult>,
    removePlaybackQueue: (payload: StorageQueueIdPayload) =>
      invokeWithPlainPayload(
        'storage:playback:remove-queue',
        payload,
      ) as Promise<StoragePlaybackSnapshot>,
    removePlaybackQueueItem: (payload: StorageRemoveQueueItemPayload) =>
      invokeWithPlainPayload(
        'storage:playback:remove-item',
        payload,
      ) as Promise<StorageResetResult>,
    reorderPlaybackQueueItems: (payload: StorageReorderQueueItemsPayload) =>
      invokeWithPlainPayload(
        'storage:playback:reorder-items',
        payload,
      ) as Promise<StorageResetResult>,
    setQueueCurrentTrack: (payload: StorageSetQueueCurrentTrackPayload) =>
      invokeWithPlainPayload(
        'storage:playback:set-current-track',
        payload,
      ) as Promise<StorageResetResult>,
    setActiveQueue: (queueId: string) =>
      ipcRenderer.invoke(
        'storage:playback:set-active-queue',
        queueId,
      ) as Promise<StorageResetResult>,
    getKv: <T = unknown>(key: string) =>
      ipcRenderer.invoke('storage:kv:get', key) as Promise<T | null>,
    setKv: (key: string, value: unknown) =>
      invokeWithPlainPayload<StorageResetResult>('storage:kv:set', key, value),
    deleteKv: (key: string) =>
      ipcRenderer.invoke('storage:kv:delete', key) as Promise<StorageResetResult>,
    resetAll: () => ipcRenderer.invoke('storage:reset-all') as Promise<StorageResetResult>,
  },
  mediaControls: {
    updateMetadata: (payload: {
      title: string;
      artist: string;
      album: string;
      coverUrl?: string;
      durationMs?: number;
    }) => invokeWithPlainPayload('media-control:update-metadata', payload),
    updateState: (payload: { status: string }) =>
      invokeWithPlainPayload('media-control:update-state', payload),
    updateTimeline: (payload: { currentTimeMs: number; totalTimeMs: number }) =>
      invokeWithPlainPayload('media-control:update-timeline', payload),
    available: () => ipcRenderer.invoke('media-control:available') as Promise<boolean>,
    onEvent: (func: (event: { type: string; positionMs?: number }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { type: string; positionMs?: number },
      ) => func(data);
      ipcRenderer.on('media-control:event', listener);
      return () => ipcRenderer.removeListener('media-control:event', listener);
    },
  },
});
