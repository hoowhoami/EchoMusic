import { computed } from 'vue';
import type { Pinia } from 'pinia';
import type { EchoPluginDescriptor } from '../../../shared/plugins';
import type { PluginTaskApi } from '../../../shared/tasks';
import { createFontApi } from '../../../shared/font';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../../../shared/audio-spectrum';
import type {
  DesktopLyricCommand,
  DesktopLyricSettings,
  DesktopLyricSnapshotMessage,
  DesktopLyricWindowBoundsUpdate,
} from '../../../shared/desktop-lyric';
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../../shared/mini-player';
import type {
  NowPlayingAppearancePayload,
  NowPlayingCommand,
  NowPlayingLyricPayload,
  NowPlayingSnapshot,
} from '../../../shared/now-playing';
import type { IconifyIcon } from '@iconify/types';
import * as icons from '@/icons';
import type { Song } from '@/models/song';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore, type SetPlaybackQueueOptions } from '@/stores/playlist';
import { useToastStore } from '@/stores/toast';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '@/types';
import request from '@/utils/request';
import { requestKugouVerification } from '@/utils/kugouVerification';
import { createThemedIconCoverUrl } from '@/utils/themedCover';
import {
  addSongToPlayLast,
  addSongToPlayNext,
  queueAndPlaySong,
  replaceQueueAndPlay,
} from '@/utils/playback';
import {
  registerPluginAudioSourceResolver,
  type PluginAudioSourceResolverContribution,
} from '../audioSource';
import { registerPluginLyricResolver, type PluginLyricResolverContribution } from '../lyrics';
import { registerPluginLyricEffect, type PluginLyricEffectContribution } from '../lyricEffects';
import {
  registerTask,
  updateTask,
  dismissTask,
  taskPanelState,
  type TaskActionRuntime,
} from '../taskPanel';
import logger from '@/utils/logger';

export const createTaskApi = (pluginId: string, deps: RuntimeApiDeps): PluginTaskApi => {
  const taskActionRuntime: TaskActionRuntime = {
    runAction: (action, invoke) =>
      deps.runPluginCallback(
        pluginId,
        `任务面板操作: ${action.label || action.id}`,
        invoke,
        undefined,
      ),
  };

  return {
    register: (task) => {
      // 内置保留命名空间：echo: 前缀的任务 id 不允许插件注册（即使内置任务处于非活动空窗期）
      if (task.id.startsWith('echo:')) {
        logger.warn('PluginTask', '拒绝注册保留任务 id（echo: 前缀）', {
          pluginId,
          taskId: task.id,
        });
        return () => {};
      }
      // 归属保护：任务 id 已被其他插件或内置任务占用时不覆盖，仅本插件可重注册同 id
      const existing = taskPanelState.entries[task.id];
      if (existing && existing.pluginId !== pluginId) {
        logger.warn('PluginTask', '拒绝覆盖其他插件或内置任务', {
          pluginId,
          taskId: task.id,
          owner: existing.pluginId,
        });
        return () => {};
      }
      return registerTask({ ...task, pluginId }, taskActionRuntime);
    },
    update: (id, patch) => {
      // 作用域隔离：只能更新本插件注册的任务，避免影响其他插件或内置任务
      const entry = taskPanelState.entries[id];
      if (entry && entry.pluginId === pluginId) {
        updateTask(id, patch, taskActionRuntime);
      }
    },
    dismiss: (id) => {
      // 作用域隔离：只能移除本插件注册的任务
      const entry = taskPanelState.entries[id];
      if (entry && entry.pluginId === pluginId) dismissTask(id);
    },
  };
};

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

interface RuntimeApiDeps {
  addDisposable: (dispose: () => void) => () => void;
  runPluginCallback: PluginCallbackRunner;
  reportPluginRuntimeError: PluginRuntimeErrorReporter;
}

export interface PluginThemedIconCoverOptions {
  icon: Pick<IconifyIcon, 'body'>;
  color?: string;
}

export interface PluginCoverApi {
  createThemedIconCoverUrl: (options: PluginThemedIconCoverOptions) => string;
}

export type PluginPlayTrackOptions = {
  playlist?: Song[];
  autoPlay?: boolean;
  sourceQueueId?: string | null;
};

export type PluginPlaybackQueueOptions = SetPlaybackQueueOptions & {
  filteredInvalidCount?: number;
  requestedSong?: Song;
};

export type PluginLyricCommand = Extract<
  NowPlayingCommand,
  | 'toggleTranslation'
  | 'toggleRomanization'
  | 'lyricOffsetBackward'
  | 'lyricOffsetForward'
  | 'lyricOffsetReset'
  | 'seekForward'
  | 'seekBackward'
>;

export type PluginKugouVerificationChallenge =
  | string
  | number
  | {
      eventId?: string | number;
      ssaCode?: string | number;
    };

export type PluginKugouVerificationResult =
  | {
      ok: true;
      eventId: string;
    }
  | {
      ok: false;
      error: string;
      canceled?: boolean;
    };

const clonePlaybackQueue = (queue: ReturnType<typeof usePlaylistStore>['activeQueue']) =>
  queue
    ? {
        ...queue,
        songs: queue.songs.slice(),
        queuedNextTrackIds: queue.queuedNextTrackIds.slice(),
        meta: { ...queue.meta },
      }
    : null;

const createFallbackLyricSnapshot = (): NowPlayingLyricPayload => ({
  trackId: null,
  revision: 0,
  lines: [],
  currentIndex: -1,
  timeOffset: 0,
  wantTranslation: false,
  wantRomanization: false,
  hasTranslation: false,
  hasRomanization: false,
  mode: 'none',
  tips: '暂无歌词',
});

const createFallbackAppearanceSnapshot = (): NowPlayingAppearancePayload => ({
  isDark: document.documentElement.classList.contains('dark'),
  accentColor: '#31cfa1',
});

const createFallbackNowPlayingSnapshot = (): NowPlayingSnapshot => ({
  playback: null,
  lyric: createFallbackLyricSnapshot(),
  appearance: createFallbackAppearanceSnapshot(),
  updatedAt: Date.now(),
});

const getNowPlayingSnapshot = () =>
  window.electron.nowPlaying?.getSnapshot?.() ??
  Promise.resolve(createFallbackNowPlayingSnapshot());

export const createPlayerApi = (
  descriptor: EchoPluginDescriptor,
  deps: RuntimeApiDeps,
  pinia?: Pinia,
) => {
  let playerStore: ReturnType<typeof usePlayerStore> | null = null;
  let playlistStore: ReturnType<typeof usePlaylistStore> | null = null;
  const getPlayer = () => {
    playerStore ??= usePlayerStore(pinia);
    return playerStore;
  };
  const getPlaylist = () => {
    playlistStore ??= usePlaylistStore(pinia);
    return playlistStore;
  };

  return {
    get store() {
      return getPlayer();
    },
    currentTrack: computed(() => getPlayer().currentTrackSnapshot),
    currentTrackId: computed(() => getPlayer().currentTrackId),
    currentTime: computed(() => getPlayer().currentTime),
    duration: computed(() => getPlayer().duration),
    isPlaying: computed(() => getPlayer().isPlaying),
    isLoading: computed(() => getPlayer().isLoading),
    playbackState: computed(() => getPlayer().playbackDisplayState),
    playbackTargetTrackId: computed(() => getPlayer().playbackTargetTrackId),
    playbackRate: computed(() => getPlayer().playbackRate),
    volume: computed(() => getPlayer().volume),
    playMode: computed(() => getPlayer().playMode),
    audioQuality: computed(() => ({
      effective: getPlayer().getEffectiveAudioQuality(),
      resolved: getPlayer().currentResolvedAudioQuality,
      override: getPlayer().currentAudioQualityOverride,
    })),
    audioEffect: computed(() => ({
      current: getPlayer().audioEffect,
      resolved: getPlayer().currentResolvedAudioEffect,
    })),
    play: (trackId?: string | number, options?: PluginPlayTrackOptions) => {
      const player = getPlayer();
      const resolvedTrackId = String(trackId ?? '').trim();
      if (resolvedTrackId) {
        return player.playTrack(resolvedTrackId, options?.playlist, {
          autoPlay: options?.autoPlay,
          sourceQueueId: options?.sourceQueueId,
        });
      }
      if (!player.isPlaying) return player.togglePlay();
      return undefined;
    },
    pause: () => {
      const player = getPlayer();
      if (player.isPlaying) void player.togglePlay();
    },
    toggle: () => getPlayer().togglePlay(),
    stop: () => getPlayer().stop(),
    playTrack: (trackId: string | number, options?: PluginPlayTrackOptions) =>
      getPlayer().playTrack(String(trackId), options?.playlist, {
        autoPlay: options?.autoPlay,
        sourceQueueId: options?.sourceQueueId,
      }),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(getPlaylist(), getPlayer(), song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(getPlaylist(), getPlayer(), song, options),
    playLast: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayLast(getPlaylist(), getPlayer(), song, options),
    replaceQueueAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        getPlaylist(),
        getPlayer(),
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    next: () => getPlayer().next(),
    prev: () => getPlayer().prev(),
    dislikePersonalFm: () => getPlayer().dislikePersonalFm(),
    seek: (time: number) => getPlayer().seek(time),
    setVolume: (volume: number) => getPlayer().setVolume(volume),
    setPlaybackRate: (rate: number) => getPlayer().setPlaybackRate(rate),
    setPlayMode: (mode: PlayMode) => getPlayer().setPlayMode(mode),
    setAudioQuality: (quality: AudioQualityValue | null, options?: { refresh?: boolean }) =>
      getPlayer().setCurrentAudioQualityOverride(quality, options),
    setAudioEffect: (effect: AudioEffectValue) => getPlayer().setAudioEffect(effect),
    toggleLyricView: (open?: boolean) => getPlayer().toggleLyricView(open),
    audioSource: {
      register: (contribution: PluginAudioSourceResolverContribution) => {
        if (descriptor.manifest.capabilities?.audioSource !== true) {
          throw new Error('插件未声明音源解析能力');
        }
        return deps.addDisposable(
          registerPluginAudioSourceResolver(descriptor.id, contribution, (source, error) => {
            void deps.reportPluginRuntimeError(descriptor.id, error, source);
          }),
        );
      },
    },
  };
};

export const createAudioApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => {
  const requireAudioSpectrumCapability = () => {
    if (descriptor.manifest.capabilities?.audioSpectrum !== true) {
      throw new Error('插件未声明音频频谱能力');
    }
  };

  return {
    spectrum: {
      getStatus: () => {
        requireAudioSpectrumCapability();
        return (
          window.electron.audioSpectrum?.getStatus() ??
          Promise.resolve({
            available: false,
            running: false,
            provider: 'unavailable' as const,
            reason: '频谱 API 不可用',
          })
        );
      },
      getSnapshot: () => {
        requireAudioSpectrumCapability();
        return window.electron.audioSpectrum?.getSnapshot() ?? Promise.resolve(null);
      },
      subscribe: (options: AudioSpectrumOptions, handler: (frame: AudioSpectrumFrame) => void) => {
        requireAudioSpectrumCapability();
        const dispose =
          window.electron.audioSpectrum?.subscribe(
            options,
            (frame) =>
              deps.runPluginCallback(
                descriptor.id,
                '音频频谱事件',
                () => handler(frame),
                undefined,
              ),
            { pluginId: descriptor.id },
          ) ?? (() => undefined);
        return deps.addDisposable(dispose);
      },
    },
  };
};

const normalizeKugouVerificationEventId = (challenge: PluginKugouVerificationChallenge) => {
  if (typeof challenge === 'string' || typeof challenge === 'number') {
    return String(challenge || '').trim();
  }

  return String(challenge?.eventId ?? challenge?.ssaCode ?? '').trim();
};

export const createKugouVerificationApi = (descriptor: EchoPluginDescriptor) => {
  const requireKugouVerificationCapability = () => {
    if (descriptor.manifest.capabilities?.kugouVerification !== true) {
      throw new Error('插件未声明酷狗安全验证能力');
    }
  };

  return {
    request: async (
      challenge: PluginKugouVerificationChallenge,
    ): Promise<PluginKugouVerificationResult> => {
      requireKugouVerificationCapability();

      const eventId = normalizeKugouVerificationEventId(challenge);
      if (!eventId) return { ok: false, error: '缺少安全验证事件标识' };

      try {
        await requestKugouVerification({ eventId }, (verifyUrl, verifyParams) =>
          request.get(verifyUrl, {
            params: verifyParams,
            skipKugouVerification: true,
          }),
        );
        return { ok: true, eventId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '安全验证失败');
        return {
          ok: false,
          error: message,
          canceled: message.includes('已取消安全验证'),
        };
      }
    },
  };
};

export const createLyricsApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => ({
  registerResolver: (contribution: PluginLyricResolverContribution) => {
    if (descriptor.manifest.capabilities?.lyrics !== true) {
      throw new Error('插件未声明歌词解析能力');
    }
    return deps.addDisposable(
      registerPluginLyricResolver(descriptor.id, contribution, (source, error) => {
        void deps.reportPluginRuntimeError(descriptor.id, error, source);
      }),
    );
  },
  getSnapshot: async () => (await getNowPlayingSnapshot()).lyric,
  onSnapshot: (handler: (lyric: NowPlayingLyricPayload, snapshot: NowPlayingSnapshot) => void) => {
    const dispose =
      window.electron.nowPlaying?.onSnapshot?.((snapshot) =>
        deps.runPluginCallback(
          descriptor.id,
          '歌词快照事件',
          () => handler(snapshot.lyric, snapshot),
          undefined,
        ),
      ) ?? (() => undefined);
    return deps.addDisposable(dispose);
  },
  command: (command: PluginLyricCommand) => window.electron.nowPlaying?.command?.(command),
});

export const createLyricEffectsApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => ({
  register: (contribution: PluginLyricEffectContribution) => {
    if (descriptor.manifest.capabilities?.lyricEffects !== true) {
      throw new Error('插件未声明歌词动效能力');
    }
    return deps.addDisposable(
      registerPluginLyricEffect(descriptor.id, contribution, (source, error) => {
        void deps.reportPluginRuntimeError(descriptor.id, error, source);
      }),
    );
  },
});

export const createDesktopLyricApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => ({
  getSnapshot: () => window.electron.desktopLyric.getSnapshot(),
  getWindow: () => window.electron.desktopLyric.getWindow(),
  show: () => window.electron.desktopLyric.show(),
  hide: () => window.electron.desktopLyric.hide(),
  toggleLock: () => window.electron.desktopLyric.toggleLock(),
  updateSettings: (payload: Partial<DesktopLyricSettings>) =>
    window.electron.desktopLyric.updateSettings(payload),
  updateWindow: (payload: DesktopLyricWindowBoundsUpdate) =>
    window.electron.desktopLyric.updateWindow(payload),
  onSnapshot: (handler: (message: DesktopLyricSnapshotMessage) => void) => {
    const dispose = window.electron.desktopLyric.onSnapshot((message) =>
      deps.runPluginCallback(descriptor.id, '桌面歌词快照事件', () => handler(message), undefined),
    );
    return deps.addDisposable(dispose);
  },
  command: (command: DesktopLyricCommand) => window.electron.desktopLyric.command(command),
});

export const createMiniPlayerApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => {
  const miniPlayer = window.electron.miniPlayer;

  return {
    getSnapshot: () => miniPlayer.getSnapshot(),
    show: () => miniPlayer.show(),
    hide: () => miniPlayer.hide(),
    toggle: () => miniPlayer.toggle(),
    setExpanded: (expanded: boolean) => miniPlayer.setExpanded(expanded),
    setAlwaysOnTop: (alwaysOnTop: boolean) => miniPlayer.setAlwaysOnTop(alwaysOnTop),
    getBounds: () => miniPlayer.getBounds(),
    onSnapshot: (handler: (snapshot: MiniPlayerSnapshot) => void) => {
      const dispose = miniPlayer.onSnapshot((snapshot) =>
        deps.runPluginCallback(
          descriptor.id,
          'Mini 播放器快照事件',
          () => handler(snapshot),
          undefined,
        ),
      );
      return deps.addDisposable(dispose);
    },
    command: (command: MiniPlayerCommand) => miniPlayer.command(command),
  };
};

export const createAppearanceApi = (pluginId: string, deps: RuntimeApiDeps) => ({
  getSnapshot: async () => (await getNowPlayingSnapshot()).appearance,
  onSnapshot: (
    handler: (appearance: NowPlayingAppearancePayload, snapshot: NowPlayingSnapshot) => void,
  ) => {
    const dispose =
      window.electron.nowPlaying?.onSnapshot?.((snapshot) =>
        deps.runPluginCallback(
          pluginId,
          '外观快照事件',
          () => handler(snapshot.appearance, snapshot),
          undefined,
        ),
      ) ?? (() => undefined);
    return deps.addDisposable(dispose);
  },
});

export const createFontsApi = () =>
  createFontApi(() => window.electron.fonts?.getAll?.() ?? Promise.resolve([]));

export const createCoverApi = (getSourceColor: () => string): PluginCoverApi => ({
  createThemedIconCoverUrl: (options) => {
    const iconBody =
      options?.icon && typeof options.icon.body === 'string'
        ? options.icon.body
        : icons.iconMusic.body;
    return createThemedIconCoverUrl(options?.color || getSourceColor(), { body: iconBody });
  },
});

export const createPlaylistApi = (pinia?: Pinia) => {
  let playlistStore: ReturnType<typeof usePlaylistStore> | null = null;
  let playerStore: ReturnType<typeof usePlayerStore> | null = null;
  const getPlaylist = () => {
    playlistStore ??= usePlaylistStore(pinia);
    return playlistStore;
  };
  const getPlayer = () => {
    playerStore ??= usePlayerStore(pinia);
    return playerStore;
  };

  return {
    get store() {
      return getPlaylist();
    },
    activeQueue: computed(() => clonePlaybackQueue(getPlaylist().activeQueue)),
    queues: computed(() => getPlaylist().playbackQueueList.map(clonePlaybackQueue).filter(Boolean)),
    getActiveQueue: () => clonePlaybackQueue(getPlaylist().activeQueue),
    getQueue: (queueId: string | number) => clonePlaybackQueue(getPlaylist().getQueueById(queueId)),
    getQueueSongs: (queueId?: string | number | null) =>
      queueId === undefined || queueId === null
        ? (getPlaylist().activeQueue?.songs ?? getPlaylist().defaultList).slice()
        : getPlaylist().getPlaybackQueueSongs(queueId),
    setActiveQueue: (queueId: string | number) => getPlaylist().setActiveQueue(queueId),
    setPlaybackQueue: (songs: Song[], filteredInvalidCount = 0) =>
      getPlaylist().setPlaybackQueue(songs, filteredInvalidCount),
    setPlaybackQueueWithOptions: (
      songs: Song[],
      filteredInvalidCount = 0,
      options?: SetPlaybackQueueOptions,
    ) => getPlaylist().setPlaybackQueueWithOptions(songs, filteredInvalidCount, options),
    replace: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      getPlaylist().setPlaybackQueueWithOptions(songs, options.filteredInvalidCount, options),
    replaceAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        getPlaylist(),
        getPlayer(),
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    append: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      getPlaylist().appendToPlaybackQueue(songs, options),
    appendToPlaybackQueue: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      getPlaylist().appendToPlaybackQueue(songs, options),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(getPlaylist(), getPlayer(), song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(getPlaylist(), getPlayer(), song, options),
    playLast: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayLast(getPlaylist(), getPlayer(), song, options),
    enqueuePlayNext: (songId: string | number) => getPlaylist().enqueuePlayNext(songId),
    enqueuePlayNextSequential: (songId: string | number) =>
      getPlaylist().enqueuePlayNextSequential(songId),
    clear: (queueId?: string | number) => getPlaylist().clearPlaybackQueue(queueId),
    remove: (songId: string | number, queueId?: string | number) =>
      getPlaylist().removeFromQueue(songId, queueId),
    reorder: (fromIndex: number, toIndex: number, queueId?: string | number) =>
      getPlaylist().reorderPlaybackQueue(fromIndex, toIndex, queueId),
  };
};

export const createToastApi = () => {
  const toast = useToastStore();
  return {
    info: toast.info,
    success: toast.success,
    warning: toast.warning,
    danger: toast.danger,
    show: toast.show,
  };
};
