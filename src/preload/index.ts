import { contextBridge, ipcRenderer } from 'electron';
import log from 'electron-log/renderer';
import type { ApiServerStatus } from '../shared/api-server';
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
    register: (payload: { enabled: boolean; shortcutMap: Record<string, string> }) =>
      ipcRenderer.send('shortcuts:register', payload),
    onTrigger: (func: (command: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: string) => func(command);
      ipcRenderer.on('shortcut-trigger', listener);
      return () => ipcRenderer.removeListener('shortcut-trigger', listener);
    },
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window-control', action),
  appInfo: {
    get: () =>
      ipcRenderer.invoke('app:get-info') as Promise<{ version: string; isPrerelease: boolean }>,
  },
  apiServer: {
    start: () => ipcRenderer.invoke('api-server:start'),
    status: () => ipcRenderer.invoke('api-server:status') as Promise<ApiServerStatus>,
    port: () => ipcRenderer.invoke('api-server:port') as Promise<number>,
    onStatusChanged: (func: (status: ApiServerStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ApiServerStatus) => func(status);
      ipcRenderer.on('api-server:status-changed', listener);
      return () => ipcRenderer.removeListener('api-server:status-changed', listener);
    },
    stop: () => ipcRenderer.send('api-server:stop'),
  },
  tray: {
    syncPlayback: (payload: {
      isPlaying?: boolean;
      playMode?: 'sequential' | 'list' | 'random' | 'single';
    }) => ipcRenderer.send('tray:sync-playback', payload),
    onSetPlayMode: (func: (playMode: 'sequential' | 'list' | 'random' | 'single') => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        playMode: 'sequential' | 'list' | 'random' | 'single',
      ) => func(playMode);
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
    startDrag: (screenX: number, screenY: number) =>
      ipcRenderer.send('desktop-lyric:drag-start', { screenX, screenY }),
    updateDrag: (screenX: number, screenY: number) =>
      ipcRenderer.send('desktop-lyric:drag-update', { screenX, screenY }),
    endDrag: () => ipcRenderer.send('desktop-lyric:drag-end'),
    startResize: (direction: string, screenX: number, screenY: number) =>
      ipcRenderer.send('desktop-lyric:resize-start', { direction, screenX, screenY }),
    updateResize: (screenX: number, screenY: number) =>
      ipcRenderer.send('desktop-lyric:resize-update', { screenX, screenY }),
    endResize: () => ipcRenderer.send('desktop-lyric:resize-end'),
    command: (
      command:
        | 'togglePlayback'
        | 'previousTrack'
        | 'nextTrack'
        | 'toggleLyricsMode'
        | 'cycleLyricsMode',
    ) => ipcRenderer.send('desktop-lyric:command', command),
  },
  log: log.functions,
});
