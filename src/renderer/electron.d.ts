import type { ApiServerStatus } from '../shared/api-server';
import type {
  AppInfoResult,
  UpdateDownloadResult,
  UpdateInstallResult,
  UpdateState,
} from '../shared/app';
import type { PlayMode } from '../shared/playback';
import type {
  PluginGlobalShortcutRegistrationPayload,
  PluginGlobalShortcutRegistrationResult,
  PluginGlobalShortcutTriggerPayload,
  ShortcutMap,
  ShortcutRegistrationResult,
} from '../shared/shortcuts';
import type {
  DesktopLyricCommand,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotMessage,
  DesktopLyricSnapshotPatch,
  DesktopLyricWindowBoundsUpdate,
} from '../shared/desktop-lyric';
import type {
  NowPlayingCommand,
  NowPlayingSnapshot,
  NowPlayingSnapshotPatch,
} from '../shared/now-playing';
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
import type {
  AudioSpectrumFrame,
  AudioSpectrumOptions,
  AudioSpectrumStatus,
} from '../shared/audio-spectrum';
import type { LogSettings } from '../shared/logging';
import type { NetworkSettings } from '../shared/network';
import type { PlayerErrorPayload } from '../shared/player-error';
import type {
  PlayerAudioGraphParameterPatch,
  PlayerAudioGraphPlanPatch,
  PlayerAudioGraphSnapshot,
} from '../shared/player-audio-graph';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../shared/external';
import type { ShareCaptureRect, ShareTarget } from '../shared/share';
import type { DiagnosticsMemorySnapshot } from '../shared/diagnostics';
import type { CloudPickMode, CloudReadUploadFileDataResult } from '../shared/cloud';
import type {
  PluginAssetSourceResult,
  PluginAppIconRefreshResult,
  PluginDialogResult,
  PluginFileUrlResult,
  PluginFailureRecord,
  PluginListFilesOptions,
  PluginListFilesResult,
  PluginListImageFilesOptions,
  PluginListImageFilesResult,
  PluginListResult,
  PluginLocalInstallOptions,
  PluginLocalInstallResult,
  PluginMarketplaceInstallOptions,
  PluginMarketplaceInstallResult,
  PluginMarketplaceListResult,
  PluginMarketplaceRemoveSourceResult,
  PluginMarketplaceRequestOptions,
  PluginMarketplaceSourceInput,
  PluginMarketplaceSourceListResult,
  PluginMarketplaceSourceMutationResult,
  PluginMarketplaceSourcePatch,
  PluginOpenDialogOptions,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginReadAudioMetadataResult,
  PluginReadFileBytesOptions,
  PluginReadFileBytesResult,
  PluginReadTextFileOptions,
  PluginReadTextFileResult,
  PluginReportFailureResult,
  PluginSetEnabledResult,
  PluginSetSafeModeResult,
  PluginSqliteCloseResult,
  PluginSqliteDeleteResult,
  PluginSqliteExecResult,
  PluginSqliteListResult,
  PluginSqliteOpenOptions,
  PluginSqliteOpenResult,
  PluginSqliteParams,
  PluginSqliteQueryOptions,
  PluginSqliteQueryResult,
  PluginSqliteRunResult,
  PluginSqliteStatement,
  PluginUninstallResult,
  PluginWebServerCloseResult,
  PluginWebServerListenOptions,
  PluginWebServerListenResult,
  PluginWebServerRequest,
  PluginWebServerResponsePayload,
  PluginWebServerStatusResult,
  PluginWriteFileData,
  PluginWriteFileOptions,
  PluginWriteFileResult,
  PluginDeleteFileResult,
  PluginRestoreIconResult,
  PluginWindowBounds,
  PluginWindowContextResult,
  PluginWindowResult,
  PluginWindowShowOptions,
  PluginShowOnTopOptions,
  PluginHostWindowTarget,
  PluginHostWindowResult,
} from '../shared/plugins';
import type {
  StorageAppendQueueItemsPayload,
  StorageHistoryEntry,
  StorageHistoryGetEntriesPayload,
  StorageHistoryRecordPlayPayload,
  StorageHistoryRemoveEntriesPayload,
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

type PlayerPacketCacheStats = {
  forwardBytes: number;
  backBytes: number;
  totalBytes: number;
  forwardSecs?: number;
  seekableRanges: Array<{ startSecs: number; endSecs: number }>;
  eof: boolean;
  pendingSeek: boolean;
  hasError: boolean;
};

type PlayerAudioOutputStats = {
  backend: string;
  sampleRate: number;
  engineSampleRate: number;
  channels: number;
  format: string;
  bufferMode: string;
  bufferFrames: number;
  bufferSecs: number;
  requestedBufferSecs?: number;
  deviceBufferSecs?: number;
  softwareBufferSecs?: number;
  aoBufferTargetSecs?: number;
  aoBufferCapacitySecs?: number;
  aoRequestFrames?: number;
  delaySecs: number;
  underruns: number;
};

type PlayerAoState = {
  paused?: boolean;
  reason?: string;
  bufferingState?: number;
  bufferedSecs?: number;
  targetSecs?: number;
  trackSeq?: number;
  generation?: number;
};

type PlayerStateChangePayload = {
  playing?: boolean;
  paused?: boolean;
  trackSeq?: number;
  generation?: number;
};

type PlayerTimeUpdatePayload = {
  time?: number;
  trackSeq?: number;
  generation?: number;
};

type PlayerCoreStateChangePayload = {
  state?: string;
  reason?: string;
  trackSeq?: number;
  generation?: number;
};

export interface IElectronAPI {
  platform: string;
  isWayland?: boolean;
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void;
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    on: (channel: string, func: (...args: unknown[]) => void) => void;
    off: (channel: string, func: (...args: unknown[]) => void) => void;
  };
  shortcuts: {
    register: (payload: {
      enabled: boolean;
      shortcutMap: ShortcutMap;
    }) => Promise<ShortcutRegistrationResult>;
    refresh: () => Promise<ShortcutRegistrationResult>;
    registerPluginGlobal: (
      payload: PluginGlobalShortcutRegistrationPayload,
    ) => Promise<PluginGlobalShortcutRegistrationResult>;
    unregisterPluginGlobal: (
      payload: Pick<PluginGlobalShortcutRegistrationPayload, 'pluginId' | 'registrationId'>,
    ) => Promise<boolean>;
    onTrigger: (func: (command: string) => void) => () => void;
    onPluginGlobalTrigger: (
      func: (payload: PluginGlobalShortcutTriggerPayload) => void,
    ) => () => void;
  };
  windowControl: (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => void;
  appInfo: {
    get: () => Promise<AppInfoResult>;
    getChangelog: () => Promise<string>;
    relaunch: () => Promise<boolean>;
    onOpenSettings: (func: () => void) => () => void;
  };
  share?: {
    copy: (text: string) => Promise<boolean>;
    readClipboard: () => Promise<string>;
    captureRectToClipboard: (rect: ShareCaptureRect) => Promise<boolean>;
    onOpen: (func: (target: ShareTarget) => void) => () => void;
  };
  fonts: {
    getAll: () => Promise<string[]>;
  };
  audioEffects: {
    importImpulseResponse: () => Promise<ImportImpulseResponseResult>;
    deleteImpulseResponse: (filePath: string) => Promise<boolean>;
    reconcileImpulseResponses: (files: ImpulseResponseFile[]) => Promise<ImpulseResponseFile[]>;
  };
  updater: {
    download: () => void;
    cancelDownload: () => void;
    install: (silent?: boolean) => Promise<UpdateInstallResult>;
    getState: () => Promise<UpdateState>;
    onDownloadStatus: (func: (result: UpdateDownloadResult) => void) => () => void;
  };
  apiServer: {
    start: () => Promise<{ success: boolean; error?: string }>;
    status: () => Promise<ApiServerStatus>;
    identity: () => Promise<{ guid: string; mac: string; serverDev: string; mid: string }>;
  };
  diagnostics?: {
    getMemory: (label?: string) => Promise<DiagnosticsMemorySnapshot>;
  };
  api: {
    request: (config: {
      method: string;
      url: string;
      params?: Record<string, any>;
      data?: any;
      headers?: Record<string, string>;
    }) => Promise<{
      status: number;
      body: any;
      cookie?: string[];
      headers?: Record<string, string>;
    }>;
  };
  cloud: {
    pickUploadFiles: (
      mode: CloudPickMode,
      multi?: boolean,
    ) => Promise<{
      canceled: boolean;
      files: {
        name: string;
        path: string;
        size: number;
        extension: string;
        modifiedAt: number;
        title?: string;
        artist?: string;
        duration?: number;
      }[];
      errors?: string[];
    }>;
    readUploadFileData: (filePath: string) => Promise<CloudReadUploadFileDataResult>;
    clearUploadFiles: () => Promise<{ ok: true }>;
  };
  tray: {
    syncPlayback: (payload: { isPlaying?: boolean; playMode?: PlayMode; volume?: number }) => void;
    onSetPlayMode: (func: (playMode: PlayMode) => void) => () => void;
  };
  power: {
    onSuspend: (func: () => void) => () => void;
    onResume: (func: () => void) => () => void;
  };
  desktopLyric: {
    getSnapshot: () => Promise<DesktopLyricSnapshot>;
    getWindow: () => Promise<{ x: number; y: number; width: number; height: number }>;
    show: () => Promise<DesktopLyricSnapshot>;
    hide: () => Promise<DesktopLyricSnapshot>;
    toggleLock: () => Promise<DesktopLyricSnapshot>;
    updateSettings: (payload: Partial<DesktopLyricSettings>) => Promise<DesktopLyricSnapshot>;
    updateWindow: (
      payload: DesktopLyricWindowBoundsUpdate,
    ) => Promise<{ x: number; y: number; width: number; height: number }>;
    syncSnapshot: (payload: DesktopLyricSnapshotPatch) => void;
    onSnapshot: (func: (snapshot: DesktopLyricSnapshotMessage) => void) => () => void;
    setIgnoreMouseEvents: (ignore: boolean) => void;
    onHover: (func: (hovered: boolean) => void) => () => void;
    command: (command: DesktopLyricCommand) => void;
  };
  nowPlaying: {
    getSnapshot: () => Promise<NowPlayingSnapshot>;
    syncSnapshot: (payload: NowPlayingSnapshotPatch) => void;
    onSnapshot: (func: (snapshot: NowPlayingSnapshot) => void) => () => void;
    command: (command: NowPlayingCommand) => void;
    onCommand: (func: (command: NowPlayingCommand) => void) => () => void;
  };
  miniPlayer: {
    getSnapshot: () => Promise<MiniPlayerSnapshot>;
    show: () => Promise<MiniPlayerSnapshot>;
    hide: () => Promise<MiniPlayerSnapshot>;
    toggle: () => Promise<MiniPlayerSnapshot>;
    syncSnapshot: (payload: MiniPlayerSnapshotPatch) => void;
    setExpanded: (expanded: boolean) => Promise<MiniPlayerSnapshot>;
    setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<MiniPlayerSnapshot>;
    getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>;
    move: (x: number, y: number) => void;
    applyExpandBounds: () => Promise<MiniPlayerSnapshot>;
    onSnapshot: (func: (snapshot: MiniPlayerSnapshot) => void) => () => void;
    command: (command: MiniPlayerCommand) => void;
    onCommand: (func: (command: MiniPlayerCommand) => void) => () => void;
    notifyLyricVisibility?: (visible: boolean) => void;
    onLyricVisibility?: (func: (visible: boolean) => void) => () => void;
  };
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    verbose: (...args: unknown[]) => void;
  };
  logging?: {
    get: () => Promise<LogSettings>;
    update: (settings: Partial<LogSettings>) => Promise<LogSettings>;
  };
  network?: {
    update: (settings: Partial<NetworkSettings>) => Promise<NetworkSettings>;
  };
  audioSpectrum?: {
    getStatus: () => Promise<AudioSpectrumStatus>;
    getSnapshot: () => Promise<AudioSpectrumFrame | null>;
    subscribe: (
      options: AudioSpectrumOptions,
      func: (frame: AudioSpectrumFrame) => void,
      metadata?: { pluginId?: string },
    ) => () => void;
  };
  recognize: {
    enableLoopback: () => Promise<void>;
    disableLoopback: () => Promise<void>;
  };
  external: {
    resolvePlaylist: (req: ResolvePlaylistRequest) => Promise<ResolvePlaylistResponse>;
  };
  plugins?: {
    list: () => Promise<PluginListResult>;
    getDirectory: () => Promise<string>;
    openDirectory: () => Promise<string>;
    getDroppedFilePaths: (files: File[]) => string[];
    marketplace: {
      listSources: () => Promise<PluginMarketplaceSourceListResult>;
      addSource: (
        input: PluginMarketplaceSourceInput,
        options?: PluginMarketplaceRequestOptions,
      ) => Promise<PluginMarketplaceSourceMutationResult>;
      patchSource: (
        sourceId: string,
        patch: PluginMarketplaceSourcePatch,
      ) => Promise<PluginMarketplaceSourceMutationResult>;
      removeSource: (sourceId: string) => Promise<PluginMarketplaceRemoveSourceResult>;
      list: (options?: PluginMarketplaceRequestOptions) => Promise<PluginMarketplaceListResult>;
      install: (
        sourceId: string,
        pluginId: string,
        options?: PluginMarketplaceInstallOptions,
      ) => Promise<PluginMarketplaceInstallResult>;
    };
    reloadRuntimes: () => Promise<void>;
    icons: {
      refresh: () => Promise<PluginAppIconRefreshResult>;
      restoreDefaultDesktopIcon: () => Promise<PluginRestoreIconResult>;
      restoreDefaultTaskbarIcon: () => Promise<PluginRestoreIconResult>;
      setRuntimeWindowIcon: (iconPath: string) => Promise<PluginRestoreIconResult>;
      restoreDefaultWindowIcon: () => Promise<PluginRestoreIconResult>;
    };
    onRuntimeReloadRequested: (func: () => void) => () => void;
    setEnabled: (pluginId: string, enabled: boolean) => Promise<PluginSetEnabledResult>;
    setSafeMode: (enabled: boolean) => Promise<PluginSetSafeModeResult>;
    installLocal: (
      paths: string[],
      options?: PluginLocalInstallOptions,
    ) => Promise<PluginLocalInstallResult>;
    uninstall: (pluginId: string) => Promise<PluginUninstallResult>;
    markStartup: (pluginIds: string[]) => Promise<PluginReportFailureResult>;
    clearStartup: () => Promise<PluginReportFailureResult>;
    setActiveSession: (pluginIds: string[]) => Promise<PluginReportFailureResult>;
    reportFailure: (
      failure: Omit<PluginFailureRecord, 'createdAt'> & {
        createdAt?: number;
        safeMode?: boolean;
      },
    ) => Promise<PluginReportFailureResult>;
    clearFailure: (pluginId?: string) => Promise<PluginReportFailureResult>;
    readAsset: (pluginId: string, asset: 'main' | 'style') => Promise<PluginAssetSourceResult>;
    windows: {
      show: (
        pluginId: string,
        windowId: string,
        options?: PluginWindowShowOptions,
      ) => Promise<PluginWindowResult>;
      hide: (pluginId: string, windowId: string) => Promise<PluginWindowResult>;
      close: (pluginId: string, windowId: string) => Promise<PluginWindowResult>;
      move: (
        pluginId: string,
        windowId: string,
        bounds: Partial<PluginWindowBounds>,
      ) => Promise<PluginWindowResult>;
      getBounds: (pluginId: string, windowId: string) => Promise<PluginWindowResult>;
      setIgnoreMouseEvents: (
        pluginId: string,
        windowId: string,
        ignore: boolean,
      ) => Promise<PluginWindowResult>;
      showOnTop: (
        pluginId: string,
        windowId: string,
        options?: PluginShowOnTopOptions,
      ) => Promise<PluginWindowResult>;
      getContext: (pluginId: string, windowId: string) => Promise<PluginWindowContextResult>;
      readAsset: (
        pluginId: string,
        windowId: string,
        asset: 'main' | 'style',
      ) => Promise<PluginAssetSourceResult>;
    };
    host: {
      showOnTop: (
        target?: PluginHostWindowTarget,
        options?: PluginShowOnTopOptions,
      ) => Promise<PluginHostWindowResult>;
    };
    dialog: {
      selectDirectory: (options?: PluginOpenDialogOptions) => Promise<PluginDialogResult>;
      selectFiles: (options?: PluginOpenDialogOptions) => Promise<PluginDialogResult>;
    };
    fs: {
      listFiles: (
        pluginId: string,
        directoryPath: string,
        options?: PluginListFilesOptions,
      ) => Promise<PluginListFilesResult>;
      listImageFiles: (
        directoryPath: string,
        options?: PluginListImageFilesOptions,
      ) => Promise<PluginListImageFilesResult>;
      getFileUrl: (filePath: string) => Promise<PluginFileUrlResult>;
      readTextFile: (
        pluginId: string,
        filePath: string,
        options?: PluginReadTextFileOptions,
      ) => Promise<PluginReadTextFileResult>;
      readFileBytes: (
        pluginId: string,
        filePath: string,
        options?: PluginReadFileBytesOptions,
      ) => Promise<PluginReadFileBytesResult>;
      readAudioMetadata: (
        pluginId: string,
        filePath: string,
      ) => Promise<PluginReadAudioMetadataResult>;
      writeFile: (
        pluginId: string,
        filePath: string,
        data: PluginWriteFileData,
        options?: PluginWriteFileOptions,
      ) => Promise<PluginWriteFileResult>;
      deleteFile: (pluginId: string, filePath: string) => Promise<PluginDeleteFileResult>;
    };
    process: {
      launch: (
        pluginId: string,
        options: PluginProcessLaunchOptions,
      ) => Promise<PluginProcessLaunchResult>;
      terminate: (pluginId: string, pid: number) => Promise<PluginProcessTerminateResult>;
    };
    webServer: {
      listen: (
        pluginId: string,
        options?: PluginWebServerListenOptions,
      ) => Promise<PluginWebServerListenResult>;
      status: (pluginId: string) => Promise<PluginWebServerStatusResult>;
      respond: (
        pluginId: string,
        payload: PluginWebServerResponsePayload,
      ) => Promise<{ ok: boolean; error?: string }>;
      close: (pluginId: string) => Promise<PluginWebServerCloseResult>;
      onRequest: (func: (request: PluginWebServerRequest) => void) => () => void;
    };
    sqlite: {
      open: (
        pluginId: string,
        options?: PluginSqliteOpenOptions,
      ) => Promise<PluginSqliteOpenResult>;
      exec: (pluginId: string, databaseId: string, sql: string) => Promise<PluginSqliteExecResult>;
      run: (
        pluginId: string,
        databaseId: string,
        sql: string,
        params?: PluginSqliteParams,
      ) => Promise<PluginSqliteRunResult>;
      all: (
        pluginId: string,
        databaseId: string,
        sql: string,
        params?: PluginSqliteParams,
        options?: PluginSqliteQueryOptions,
      ) => Promise<PluginSqliteQueryResult>;
      get: (
        pluginId: string,
        databaseId: string,
        sql: string,
        params?: PluginSqliteParams,
      ) => Promise<PluginSqliteQueryResult>;
      transaction: (
        pluginId: string,
        databaseId: string,
        statements: PluginSqliteStatement[],
      ) => Promise<PluginSqliteExecResult>;
      close: (pluginId: string, databaseId: string) => Promise<PluginSqliteCloseResult>;
      list: (pluginId: string) => Promise<PluginSqliteListResult>;
      delete: (pluginId: string, name?: string) => Promise<PluginSqliteDeleteResult>;
    };
    storage: {
      get: <T = unknown>(pluginId: string, key: string) => Promise<T | null>;
      set: (pluginId: string, key: string, value: unknown) => Promise<{ ok: boolean }>;
      delete: (pluginId: string, key: string) => Promise<{ ok: boolean }>;
    };
  };
  storage?: {
    getPlaybackSnapshot: () => Promise<StoragePlaybackSnapshot>;
    getPlaybackQueue: (payload: StorageQueueIdPayload) => Promise<StoragePlaybackQueueState | null>;
    replacePlaybackQueue: (payload: StorageReplaceQueuePayload) => Promise<StorageResetResult>;
    appendPlaybackQueueItems: (
      payload: StorageAppendQueueItemsPayload,
    ) => Promise<StorageResetResult>;
    updatePlaybackQueueMeta: (
      payload: StorageUpdateQueueMetaPayload,
    ) => Promise<StorageResetResult>;
    clearPlaybackQueue: (payload: StorageUpdateQueueMetaPayload) => Promise<StorageResetResult>;
    removePlaybackQueue: (payload: StorageQueueIdPayload) => Promise<StoragePlaybackSnapshot>;
    removePlaybackQueueItem: (
      payload: StorageRemoveQueueItemPayload,
    ) => Promise<StorageResetResult>;
    reorderPlaybackQueueItems: (
      payload: StorageReorderQueueItemsPayload,
    ) => Promise<StorageResetResult>;
    setQueueCurrentTrack: (
      payload: StorageSetQueueCurrentTrackPayload,
    ) => Promise<StorageResetResult>;
    setActiveQueue: (queueId: string) => Promise<StorageResetResult>;
    getHistoryEntries: (
      payload?: StorageHistoryGetEntriesPayload,
    ) => Promise<StorageHistoryEntry[]>;
    recordHistoryPlay: (
      payload: StorageHistoryRecordPlayPayload,
    ) => Promise<StorageHistoryEntry | null>;
    removeHistoryEntries: (
      payload: StorageHistoryRemoveEntriesPayload,
    ) => Promise<StorageResetResult>;
    clearHistory: () => Promise<StorageResetResult>;
    getKv: <T = unknown>(key: string) => Promise<T | null>;
    setKv: (key: string, value: unknown) => Promise<StorageResetResult>;
    deleteKv: (key: string) => Promise<StorageResetResult>;
    resetAll: () => Promise<StorageResetResult>;
  };
  mediaControls: {
    updateMetadata: (payload: {
      title: string;
      artist: string;
      album: string;
      coverUrl?: string;
      durationMs?: number;
    }) => Promise<void>;
    updateState: (payload: { status: string }) => Promise<void>;
    updateTimeline: (payload: { currentTimeMs: number; totalTimeMs: number }) => Promise<void>;
    updateSkipIntervals: (payload: { forwardMs: number; backwardMs: number }) => Promise<void>;
    available: () => Promise<boolean>;
    onEvent: (
      func: (event: { type: string; positionMs?: number; offsetMs?: number }) => void,
    ) => () => void;
  };
  player: {
    load: (url: string) => Promise<void>;
    loadMkvTrack: (url: string, trackId: number) => Promise<void>;
    beginNextSourcePreparation: () => Promise<number | null>;
    cancelNextSourcePreparation: (requestId: number) => Promise<boolean>;
    prepareNextSource: (
      url: string,
      requestId: number,
      trackId?: number | null,
    ) => Promise<number | null>;
    clearPreparedNextSource: () => Promise<void>;
    getTrackList: (url?: string) => Promise<
      Array<{
        id: number;
        type: string;
        codec?: string;
        selected?: boolean;
        title?: string;
        lang?: string;
      }>
    >;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    stop: () => Promise<void>;
    seek: (time: number) => Promise<void>;
    setVolume: (volume: number) => Promise<void>;
    setSpeed: (speed: number) => Promise<void>;
    setEqualizer: (gains: number[]) => Promise<void>;
    setImpulseResponse: (payload: string | ImpulseResponsePlaybackOptions) => Promise<void>;
    setImpulseResponseMix: (mix: number) => Promise<void>;
    getAudioGraph: () => Promise<PlayerAudioGraphSnapshot | null>;
    setAudioGraphParameter: (patch: PlayerAudioGraphParameterPatch) => Promise<void>;
    setAudioGraphPlan: (plan: PlayerAudioGraphPlanPatch) => Promise<void>;
    setAudioDevice: (deviceName: string) => Promise<void>;
    getAudioDevices: () => Promise<
      Array<{ name: string; description: string; isDefault?: boolean }>
    >;
    setNormalizationGain: (gainDb: number) => Promise<void>;
    fade: (from: number, to: number, durationMs: number) => Promise<void>;
    cancelFade: () => Promise<void>;
    pauseWithFade: (savedVolume: number, durationMs: number) => Promise<void>;
    playWithFade: (targetVolume: number, durationMs: number) => Promise<void>;
    getState: () => Promise<{
      playing: boolean;
      paused: boolean;
      duration: number;
      timePos: number;
      volume: number;
      speed: number;
      idle: boolean;
      path: string;
      audioDevice: string;
    } | null>;
    available: () => Promise<boolean>;
    restart: () => Promise<boolean>;
    setExclusive: (exclusive: boolean) => Promise<boolean>;
    setPauseOnDeviceDisconnect: (enabled: boolean) => Promise<void>;
    setMediaTitle: (title: string) => Promise<void>;
    setLoopFile: (loop: boolean) => Promise<void>;
    setStallTimeout: (seconds: number) => Promise<void>;
    onTimeUpdate: (func: (payload: number | PlayerTimeUpdatePayload) => void) => () => void;
    onSeeked: (func: (time: number) => void) => () => void;
    onPlaybackRestart: (func: (payload?: { time?: number; reason?: string }) => void) => () => void;
    onDurationChange: (func: (duration: number) => void) => () => void;
    onFileLoaded: (
      func: (payload?: {
        path?: string;
        seq?: number;
        trackSeq?: number;
        generation?: number;
      }) => void,
    ) => () => void;
    onStateChange: (func: (state: PlayerStateChangePayload) => void) => () => void;
    onCoreStateChange: (func: (payload: PlayerCoreStateChangePayload) => void) => () => void;
    onAoStateChange: (func: (payload: PlayerAoState) => void) => () => void;
    onPlaybackEnd: (func: (reason: string) => void) => () => void;
    onStall: (func: (position: number) => void) => () => void;
    onError: (func: (payload: PlayerErrorPayload) => void) => () => void;
    onImpulseResponseDisabled: (
      func: (payload: { path?: string; reason?: string }) => void,
    ) => () => void;
    onAudioDeviceListChanged: (
      func: (payload: {
        devices: Array<{ name: string; description: string; isDefault?: boolean }>;
        deviceChangeKind?: string;
        disconnectedDevices?: Array<{ name: string; description: string; isDefault?: boolean }>;
      }) => void,
    ) => () => void;
    onPacketCacheStats: (func: (payload?: PlayerPacketCacheStats) => void) => () => void;
    onAudioOutputStats: (func: (payload?: PlayerAudioOutputStats) => void) => () => void;
    onAudioGraphChange: (func: (payload?: PlayerAudioGraphSnapshot) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
