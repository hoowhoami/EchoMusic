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
    getChangelog: () => ipcRenderer.invoke('app:get-changelog') as Promise<string>,
  },
  fonts: {
    getAll: () => ipcRenderer.invoke('get-all-fonts') as Promise<string[]>,
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
    }) => ipcRenderer.invoke('api:request', config),
    clearCache: () => ipcRenderer.invoke('api:cache-clear'),
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
  },
});
