import type { ApiServerStatus } from '../shared/api-server';
import type {
  DesktopLyricPointerState,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';

export interface IElectronAPI {
  platform: string;
  ipcRenderer: {
    send: (channel: string, data: unknown) => void;
    on: (channel: string, func: (...args: unknown[]) => void) => void;
    off: (channel: string, func: (...args: unknown[]) => void) => void;
  };
  shortcuts: {
    register: (payload: { enabled: boolean; shortcutMap: Record<string, string> }) => void;
    onTrigger: (func: (command: string) => void) => () => void;
  };
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
  appInfo: {
    get: () => Promise<{ version: string; isPrerelease: boolean }>;
  };
  apiServer: {
    start: () => Promise<{ success: boolean; port?: number; error?: string }>;
    status: () => Promise<ApiServerStatus & { port?: number }>;
    port: () => Promise<number>;
    onStatusChanged: (func: (status: ApiServerStatus) => void) => () => void;
    stop: () => void;
  };
  tray: {
    syncPlayback: (payload: {
      isPlaying?: boolean;
      playMode?: 'list' | 'random' | 'single';
    }) => void;
    onSetPlayMode: (func: (playMode: 'list' | 'random' | 'single') => void) => () => void;
  };
  desktopLyric: {
    getSnapshot: () => Promise<DesktopLyricSnapshot>;
    show: () => Promise<DesktopLyricSnapshot>;
    hide: () => Promise<DesktopLyricSnapshot>;
    toggleLock: () => Promise<DesktopLyricSnapshot>;
    updateSettings: (payload: Partial<DesktopLyricSettings>) => Promise<DesktopLyricSnapshot>;
    syncSnapshot: (payload: DesktopLyricSnapshotPatch) => Promise<DesktopLyricSnapshot>;
    onSnapshot: (func: (snapshot: DesktopLyricSnapshot) => void) => () => void;
    onPointerState: (func: (state: DesktopLyricPointerState) => void) => () => void;
    setIgnoreMouseEvents: (ignore: boolean) => void;
    startDrag: (screenX: number, screenY: number) => void;
    updateDrag: (screenX: number, screenY: number) => void;
    endDrag: () => void;
    startResize: (direction: string, screenX: number, screenY: number) => void;
    updateResize: (screenX: number, screenY: number) => void;
    endResize: () => void;
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
