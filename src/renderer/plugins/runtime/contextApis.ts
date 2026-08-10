import { computed } from 'vue';
import type { EchoPluginDescriptor } from '../../../shared/plugins';
import type { PluginTaskApi } from '../../../shared/tasks';
import { createFontApi } from '../../../shared/font';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../../../shared/audio-spectrum';
import type {
  DesktopLyricSettings,
  DesktopLyricWindowBoundsUpdate,
} from '../../../shared/desktop-lyric';
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

export const createPlayerApi = (descriptor: EchoPluginDescriptor, deps: RuntimeApiDeps) => {
  const player = usePlayerStore();
  const playlist = usePlaylistStore();
  return {
    store: player,
    currentTrack: computed(() => player.currentTrackSnapshot),
    currentTrackId: computed(() => player.currentTrackId),
    currentTime: computed(() => player.currentTime),
    duration: computed(() => player.duration),
    isPlaying: computed(() => player.isPlaying),
    isLoading: computed(() => player.isLoading),
    playbackState: computed(() => player.playbackDisplayState),
    playbackTargetTrackId: computed(() => player.playbackTargetTrackId),
    playbackRate: computed(() => player.playbackRate),
    volume: computed(() => player.volume),
    playMode: computed(() => player.playMode),
    audioQuality: computed(() => ({
      effective: player.getEffectiveAudioQuality(),
      resolved: player.currentResolvedAudioQuality,
      override: player.currentAudioQualityOverride,
    })),
    audioEffect: computed(() => ({
      current: player.audioEffect,
      resolved: player.currentResolvedAudioEffect,
    })),
    play: (trackId?: string | number, options?: PluginPlayTrackOptions) => {
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
      if (player.isPlaying) void player.togglePlay();
    },
    toggle: () => player.togglePlay(),
    stop: () => player.stop(),
    playTrack: (trackId: string | number, options?: PluginPlayTrackOptions) =>
      player.playTrack(String(trackId), options?.playlist, {
        autoPlay: options?.autoPlay,
        sourceQueueId: options?.sourceQueueId,
      }),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(playlist, player, song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(playlist, player, song, options),
    playLast: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayLast(playlist, player, song, options),
    replaceQueueAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        playlist,
        player,
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    next: () => player.next(),
    prev: () => player.prev(),
    dislikePersonalFm: () => player.dislikePersonalFm(),
    seek: (time: number) => player.seek(time),
    setVolume: (volume: number) => player.setVolume(volume),
    setPlaybackRate: (rate: number) => player.setPlaybackRate(rate),
    setPlayMode: (mode: PlayMode) => player.setPlayMode(mode),
    setAudioQuality: (quality: AudioQualityValue | null, options?: { refresh?: boolean }) =>
      player.setCurrentAudioQualityOverride(quality, options),
    setAudioEffect: (effect: AudioEffectValue) => player.setAudioEffect(effect),
    toggleLyricView: (open?: boolean) => player.toggleLyricView(open),
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

export const createDesktopLyricApi = () => ({
  getSnapshot: () => window.electron.desktopLyric.getSnapshot(),
  getWindow: () => window.electron.desktopLyric.getWindow(),
  show: () => window.electron.desktopLyric.show(),
  hide: () => window.electron.desktopLyric.hide(),
  updateSettings: (payload: Partial<DesktopLyricSettings>) =>
    window.electron.desktopLyric.updateSettings(payload),
  updateWindow: (payload: DesktopLyricWindowBoundsUpdate) =>
    window.electron.desktopLyric.updateWindow(payload),
});

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

export const createPlaylistApi = () => {
  const playlist = usePlaylistStore();
  const player = usePlayerStore();
  return {
    store: playlist,
    activeQueue: computed(() => clonePlaybackQueue(playlist.activeQueue)),
    queues: computed(() => playlist.playbackQueueList.map(clonePlaybackQueue).filter(Boolean)),
    getActiveQueue: () => clonePlaybackQueue(playlist.activeQueue),
    getQueue: (queueId: string | number) => clonePlaybackQueue(playlist.getQueueById(queueId)),
    getQueueSongs: (queueId?: string | number | null) =>
      queueId === undefined || queueId === null
        ? (playlist.activeQueue?.songs ?? playlist.defaultList).slice()
        : playlist.getPlaybackQueueSongs(queueId),
    setActiveQueue: (queueId: string | number) => playlist.setActiveQueue(queueId),
    setPlaybackQueue: (songs: Song[], filteredInvalidCount = 0) =>
      playlist.setPlaybackQueue(songs, filteredInvalidCount),
    setPlaybackQueueWithOptions: (
      songs: Song[],
      filteredInvalidCount = 0,
      options?: SetPlaybackQueueOptions,
    ) => playlist.setPlaybackQueueWithOptions(songs, filteredInvalidCount, options),
    replace: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      playlist.setPlaybackQueueWithOptions(songs, options.filteredInvalidCount, options),
    replaceAndPlay: (songs: Song[], options: PluginPlaybackQueueOptions = {}) =>
      replaceQueueAndPlay(
        playlist,
        player,
        songs,
        options.filteredInvalidCount,
        options.requestedSong,
        options,
      ),
    append: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      playlist.appendToPlaybackQueue(songs, options),
    appendToPlaybackQueue: (songs: Song[], options?: SetPlaybackQueueOptions) =>
      playlist.appendToPlaybackQueue(songs, options),
    playSong: (song: Song, options?: SetPlaybackQueueOptions) =>
      queueAndPlaySong(playlist, player, song, options),
    playNext: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayNext(playlist, player, song, options),
    playLast: (song: Song, options?: SetPlaybackQueueOptions) =>
      addSongToPlayLast(playlist, player, song, options),
    enqueuePlayNext: (songId: string | number) => playlist.enqueuePlayNext(songId),
    enqueuePlayNextSequential: (songId: string | number) =>
      playlist.enqueuePlayNextSequential(songId),
    clear: (queueId?: string | number) => playlist.clearPlaybackQueue(queueId),
    remove: (songId: string | number, queueId?: string | number) =>
      playlist.removeFromQueue(songId, queueId),
    reorder: (fromIndex: number, toIndex: number, queueId?: string | number) =>
      playlist.reorderPlaybackQueue(fromIndex, toIndex, queueId),
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
