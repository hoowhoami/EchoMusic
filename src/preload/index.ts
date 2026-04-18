import { contextBridge, ipcRenderer } from 'electron';
import log from 'electron-log/renderer';
import type { ApiServerStatus } from '../shared/api-server';
import type { AppInfoResult } from '../shared/app';
import type { PlayMode } from '../shared/playback';
import type { ShortcutCommand, ShortcutMap, ShortcutRegistrationResult } from '../shared/shortcuts';
import type {
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  DesktopLyricSnapshotPatch,
} from '../shared/desktop-lyric';

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

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
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
      ipcRenderer.invoke('shortcuts:register', payload) as Promise<ShortcutRegistrationResult>,
    refresh: () => ipcRenderer.invoke('shortcuts:refresh') as Promise<ShortcutRegistrationResult>,
    onTrigger: (func: (command: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: string) => func(command);
      ipcRenderer.on('shortcut-trigger', listener);
      return () => ipcRenderer.removeListener('shortcut-trigger', listener);
    },
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window-control', action),
  appInfo: {
    get: () => ipcRenderer.invoke('app:get-info') as Promise<AppInfoResult>,
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
    }) => ipcRenderer.invoke('api:request', config),
  },
  tray: {
    syncPlayback: (payload: { isPlaying?: boolean; playMode?: PlayMode; volume?: number }) =>
      ipcRenderer.send('tray:sync-playback', payload),
    onSetPlayMode: (func: (playMode: PlayMode) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, playMode: PlayMode) => func(playMode);
      ipcRenderer.on('tray:set-play-mode', listener);
      return () => ipcRenderer.removeListener('tray:set-play-mode', listener);
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
      ipcRenderer.invoke('desktop-lyric:update-settings', payload) as Promise<DesktopLyricSnapshot>,
    syncSnapshot: (payload: DesktopLyricSnapshotPatch) =>
      ipcRenderer.send('desktop-lyric:sync-snapshot', payload),
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
        'togglePlayback' | 'previousTrack' | 'nextTrack' | 'toggleLyricsMode' | 'cycleLyricsMode'
      >,
    ) => ipcRenderer.send('desktop-lyric:command', command),
  },
  log: log.functions,
});
