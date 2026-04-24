import type { ApiServerStatus } from '../shared/api-server';
import type { AppInfoResult, UpdateDownloadResult } from '../shared/app';
import type { PlayMode } from '../shared/playback';
import type { ShortcutMap, ShortcutRegistrationResult } from '../shared/shortcuts';
import type {
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';

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
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
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
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
