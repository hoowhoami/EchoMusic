import type { ApiServerStatus } from '../shared/api-server';
import type { AppInfoResult, UpdateDownloadResult } from '../shared/app';
import type { PlayMode } from '../shared/playback';
import type { ShortcutMap, ShortcutRegistrationResult } from '../shared/shortcuts';
import type {
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';
import type { RecognizeResponse } from '../shared/shazam';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../shared/external';

export interface IElectronAPI {
  platform: string;
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
    onTrigger: (func: (command: string) => void) => () => void;
  };
  windowControl: (action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => void;
  appInfo: {
    get: () => Promise<AppInfoResult>;
    getChangelog: () => Promise<string>;
  };
  fonts: {
    getAll: () => Promise<string[]>;
  };
  updater: {
    download: () => void;
    install: (silent?: boolean) => void;
    onDownloadStatus: (func: (result: UpdateDownloadResult) => void) => () => void;
  };
  apiServer: {
    start: () => Promise<{ success: boolean; error?: string }>;
    status: () => Promise<ApiServerStatus>;
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
    clearCache: () => Promise<{ success: boolean }>;
  };
  tray: {
    syncPlayback: (payload: { isPlaying?: boolean; playMode?: PlayMode; volume?: number }) => void;
    onSetPlayMode: (func: (playMode: PlayMode) => void) => () => void;
  };
  desktopLyric: {
    getSnapshot: () => Promise<DesktopLyricSnapshot>;
    show: () => Promise<DesktopLyricSnapshot>;
    hide: () => Promise<DesktopLyricSnapshot>;
    toggleLock: () => Promise<DesktopLyricSnapshot>;
    updateSettings: (payload: Partial<DesktopLyricSettings>) => Promise<DesktopLyricSnapshot>;
    syncSnapshot: (payload: DesktopLyricSnapshotPatch) => void;
    onSnapshot: (func: (snapshot: DesktopLyricSnapshot) => void) => () => void;
    setIgnoreMouseEvents: (ignore: boolean) => void;
    command: (
      command:
        | 'togglePlayback'
        | 'previousTrack'
        | 'nextTrack'
        | 'toggleLyricsMode'
        | 'cycleLyricsMode',
    ) => void;
  };
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    verbose: (...args: unknown[]) => void;
  };
  shazam: {
    recognize: (pcmData: ArrayBuffer) => Promise<RecognizeResponse>;
    enableLoopback: () => Promise<void>;
    disableLoopback: () => Promise<void>;
  };
  external: {
    resolvePlaylist: (req: ResolvePlaylistRequest) => Promise<ResolvePlaylistResponse>;
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
    available: () => Promise<boolean>;
    onEvent: (func: (event: { type: string; positionMs?: number }) => void) => () => void;
  };
  mpv: {
    load: (url: string) => Promise<void>;
    loadMkvTrack: (url: string, trackId: number) => Promise<void>;
    getTrackList: () => Promise<
      Array<{ id: number; type: string; codec: string; title?: string; lang?: string }>
    >;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    stop: () => Promise<void>;
    seek: (time: number) => Promise<void>;
    setVolume: (volume: number) => Promise<void>;
    setSpeed: (speed: number) => Promise<void>;
    setEqualizer: (gains: number[]) => Promise<void>;
    setAudioDevice: (deviceName: string) => Promise<void>;
    getAudioDevices: () => Promise<Array<{ name: string; description: string }>>;
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
    setMediaTitle: (title: string) => Promise<void>;
    setLoopFile: (loop: boolean) => Promise<void>;
    onTimeUpdate: (func: (time: number) => void) => () => void;
    onDurationChange: (func: (duration: number) => void) => () => void;
    onStateChange: (func: (state: { playing?: boolean; paused?: boolean }) => void) => () => void;
    onPlaybackEnd: (func: (reason: string) => void) => () => void;
    onError: (func: (message: string) => void) => () => void;
    onAudioDeviceListChanged: (
      func: (devices: Array<{ name: string; description: string }>) => void,
    ) => () => void;
  };
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
