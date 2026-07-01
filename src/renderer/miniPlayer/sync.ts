import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { executeShortcutCommand } from '@/utils/shortcuts';
import { setWithLimit } from '@/utils/lruMap';
import type { Song } from '@/models/song';
import { resolveFavoriteSongKey } from '@/stores/playlist/helpers';
import type {
  MiniPlayerCommand,
  MiniPlayerLyricPayload,
  MiniPlayerPlaybackPayload,
  MiniPlayerQueuePayload,
} from '../../shared/mini-player';
import type { LyricLinePayload } from '../../shared/desktop-lyric';

const MINI_PLAYER_PROGRESS_SYNC_INTERVAL_MS = 120;
// 歌词面板未展开时使用较低的同步频率，减少 IPC 开销
const MINI_PLAYER_IDLE_SYNC_INTERVAL_MS = 500;
const FAVORITES_QUEUE_ID = 'queue:favorites';
// 收藏状态缓存上限，按歌曲键裁剪最旧条目，避免长会话无界增长
const FAVORITE_STATE_CACHE_MAX = 500;

const favoriteStateCache = new Map<string, boolean>();
const favoriteStateOverrides = new Map<string, boolean>();

const resolveSongArtist = (song: Song): string =>
  String(song.artist || song.artists?.map((item) => item.name).join(' / ') || '未知歌手');

const normalizeLyricLinePayload = (
  line: ReturnType<typeof useLyricStore>['lines'][number],
): LyricLinePayload => ({
  time: Number(line.time) || 0,
  text: String(line.text ?? ''),
  translated: line.translated ? String(line.translated) : undefined,
  romanized: line.romanized ? String(line.romanized) : undefined,
  characters: (line.characters ?? []).map((char) => ({
    text: String(char.text ?? ''),
    startTime: Number(char.startTime) || 0,
    endTime: Number(char.endTime) || Number(char.startTime) || 0,
  })),
});

const resolveCurrentPlaybackQueue = () => {
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  return (
    playlistStore.getQueueById(playerStore.currentSourceQueueId) ??
    playlistStore.activeQueue ??
    playlistStore.customPlaybackQueue ??
    null
  );
};

const resolveCurrentTrack = (): Song | null => {
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const currentId = playerStore.currentTrackId ? String(playerStore.currentTrackId) : '';
  if (!currentId) return null;
  // 优先用播放快照；尚未开始播放时（如刚打开应用）从已恢复的队列/收藏中按 id 回退解析，
  // 与主窗口 usePlayerControls.currentTrack 的解析保持一致，确保 mini 打开即显示当前歌曲。
  return (
    playerStore.currentTrackSnapshot ||
    resolveCurrentPlaybackQueue()?.songs.find((song) => String(song.id) === currentId) ||
    playlistStore.defaultList.find((song) => String(song.id) === currentId) ||
    playlistStore.favorites.find((song) => String(song.id) === currentId) ||
    null
  );
};

const resolveFavoriteCacheKey = (track: Song, fallbackId?: string | number | null) =>
  resolveFavoriteSongKey(track) || `id:${String(fallbackId ?? track.id ?? '')}`;

const isCurrentTrackFromFavoritesQueue = (track: Song) => {
  const playerStore = usePlayerStore();
  const queue = resolveCurrentPlaybackQueue();
  if (queue?.id !== FAVORITES_QUEUE_ID) return false;

  const currentId = String(playerStore.currentTrackId ?? track.id ?? '');
  const currentFavoriteKey = resolveFavoriteCacheKey(track, currentId);
  return queue.songs.some(
    (song) =>
      String(song.id) === currentId ||
      resolveFavoriteCacheKey(song, song.id) === currentFavoriteKey,
  );
};

const resolveFavoriteState = (track: Song): boolean => {
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const cacheKey = resolveFavoriteCacheKey(track, playerStore.currentTrackId);
  const override = favoriteStateOverrides.get(cacheKey);
  if (override !== undefined) return override;

  if (playlistStore.isFavoriteSong(track)) {
    setWithLimit(favoriteStateCache, cacheKey, true, FAVORITE_STATE_CACHE_MAX);
    return true;
  }

  if (playlistStore.favoritesLoaded) {
    setWithLimit(favoriteStateCache, cacheKey, false, FAVORITE_STATE_CACHE_MAX);
    return false;
  }

  const cached = favoriteStateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (isCurrentTrackFromFavoritesQueue(track)) {
    setWithLimit(favoriteStateCache, cacheKey, true, FAVORITE_STATE_CACHE_MAX);
    return true;
  }

  return false;
};

const syncPlaybackSnapshotNow = () => {
  window.electron?.miniPlayer?.syncSnapshot({ playback: buildPlaybackPayload() });
};

const buildPlaybackPayload = (): MiniPlayerPlaybackPayload | null => {
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  const track = resolveCurrentTrack();
  if (!track || !playerStore.currentTrackId) return null;

  const trackId = String(playerStore.currentTrackId);

  return {
    trackId,
    title: String(track.name || track.title || '未知歌曲'),
    artist: resolveSongArtist(track),
    album: String(track.album ?? track.albumName ?? ''),
    coverUrl: String(track.coverUrl || track.cover || ''),
    duration: Number(playerStore.duration || track.duration || 0),
    currentTime: Number(playerStore.currentTime || 0),
    playbackRate: Number(playerStore.playbackRate || 1),
    isPlaying: Boolean(playerStore.isPlaying),
    isFavorite: resolveFavoriteState(track),
    lyricsLabel: lyricStore.currentDisplayLabel,
    volume: Number(playerStore.volume || 0),
    lastNonZeroVolume: Number(playerStore.lastNonZeroVolume || 0),
    updatedAt: Date.now(),
  };
};

const buildQueuePayload = (): MiniPlayerQueuePayload => {
  const playerStore = usePlayerStore();
  const queue = resolveCurrentPlaybackQueue();
  const currentTrackId = playerStore.currentTrackId ? String(playerStore.currentTrackId) : null;
  if (!queue) {
    return { queueId: null, title: '', currentTrackId, tracks: [] };
  }
  return {
    queueId: queue.id,
    title: String(queue.title || ''),
    currentTrackId,
    tracks: queue.songs.map((song) => ({
      trackId: String(song.id),
      title: String(song.name || song.title || '未知歌曲'),
      artist: resolveSongArtist(song),
      coverUrl: String(song.coverUrl || song.cover || ''),
    })),
  };
};

const buildLyricPayload = (): MiniPlayerLyricPayload => {
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  const desktopLyricStore = useDesktopLyricStore();
  return {
    trackId: playerStore.currentTrackId ? String(playerStore.currentTrackId) : null,
    lines: lyricStore.lines.map(normalizeLyricLinePayload),
    currentIndex: lyricStore.currentIndex,
    timeOffset: lyricStore.currentTimeOffset,
    wantTranslation: lyricStore.wantTranslation,
    wantRomanization: lyricStore.wantRomanization,
    hasTranslation: lyricStore.hasTranslation,
    hasRomanization: lyricStore.hasRomanization,
    desktopLyricEnabled: desktopLyricStore.settings.enabled,
    isLoading: lyricStore.isLoading,
    tips: lyricStore.tips,
  };
};

const queuePayloadKey = (payload: MiniPlayerQueuePayload | null | undefined): string => {
  if (!payload) return '';
  return [
    payload.queueId ?? '',
    payload.currentTrackId ?? '',
    payload.tracks.map((track) => track.trackId).join(','),
  ].join('|');
};

const lyricLinesPayloadKey = (payload: MiniPlayerLyricPayload): string =>
  JSON.stringify({
    trackId: payload.trackId,
    lines: payload.lines,
    wantTranslation: payload.wantTranslation,
    wantRomanization: payload.wantRomanization,
    hasTranslation: payload.hasTranslation,
    hasRomanization: payload.hasRomanization,
    isLoading: payload.isLoading,
    tips: payload.tips,
  });

const executeMiniPlayerCommand = (command: MiniPlayerCommand) => {
  if (typeof command === 'string') {
    if (command === 'toggleFavorite') {
      const playlistStore = usePlaylistStore();
      const playerStore = usePlayerStore();
      const track = resolveCurrentTrack();
      if (!track) return;
      const cacheKey = resolveFavoriteCacheKey(track, playerStore.currentTrackId);
      const wasFavorite = resolveFavoriteState(track);
      favoriteStateOverrides.set(cacheKey, !wasFavorite);
      syncPlaybackSnapshotNow();

      const request = wasFavorite
        ? playlistStore.removeFavoriteSong(track)
        : playlistStore.addToFavorites(track);
      void Promise.resolve(request)
        .then((success) => {
          favoriteStateOverrides.delete(cacheKey);
          if (success !== false) {
            setWithLimit(favoriteStateCache, cacheKey, !wasFavorite, FAVORITE_STATE_CACHE_MAX);
            syncPlaybackSnapshotNow();
            return;
          }
          setWithLimit(favoriteStateCache, cacheKey, wasFavorite, FAVORITE_STATE_CACHE_MAX);
          syncPlaybackSnapshotNow();
        })
        .catch(() => {
          favoriteStateOverrides.delete(cacheKey);
          setWithLimit(favoriteStateCache, cacheKey, wasFavorite, FAVORITE_STATE_CACHE_MAX);
          syncPlaybackSnapshotNow();
        });
      return;
    }
    if (
      command === 'togglePlayback' ||
      command === 'previousTrack' ||
      command === 'nextTrack' ||
      command === 'toggleDesktopLyric' ||
      command === 'toggleLyricsMode' ||
      command === 'toggleMute'
    ) {
      executeShortcutCommand(command);
    }
    return;
  }

  const playerStore = usePlayerStore();
  if (command.type === 'setVolume') {
    playerStore.setVolume(command.value);
    return;
  }
  if (command.type === 'adjustVolume') {
    playerStore.adjustVolume(command.delta);
    return;
  }
  if (command.type === 'seek') {
    playerStore.seek(command.value);
    return;
  }
  if (command.type === 'playQueueTrack') {
    const queue = resolveCurrentPlaybackQueue();
    const trackId = String(command.trackId);
    if (trackId === String(playerStore.currentTrackId)) {
      playerStore.togglePlay();
      return;
    }
    void playerStore.playTrack(trackId, queue?.songs ?? [], {
      sourceQueueId: queue?.id ?? null,
    });
  }
};

export const initMiniPlayerSync = async () => {
  if (!window.electron?.miniPlayer) return () => {};

  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();
  const desktopLyricStore = useDesktopLyricStore();
  const stops: WatchStopHandle[] = [];
  const {
    currentTime,
    isPlaying,
    duration,
    playbackRate,
    currentTrackId,
    currentTrackSnapshot,
    volume,
    currentSourceQueueId,
  } = storeToRefs(playerStore);
  const { favorites, favoritesLoaded } = storeToRefs(playlistStore);
  const {
    lines,
    wantTranslation,
    wantRomanization,
    hasTranslation,
    hasRomanization,
    tips,
    currentTimeOffset,
  } = storeToRefs(lyricStore);

  let lastSyncedPlaybackKey = '';
  let lastSyncedQueueKey = '';
  let lastSyncedLyricLinesKey = '';
  let lastSyncedLyricStateKey = '';
  let lastStableLyricTrackId: string | null = null;
  let lastStableLyricIndex = -1;
  let lastStableLyricTime = 0;
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;
  // mini 窗口歌词面板是否展开中（由 mini 窗口通过 IPC 通知主渲染进程）
  let miniLyricPanelVisible = false;

  // 监听 mini 窗口歌词面板状态变更，动态调整同步频率
  const disposeLyricVisibilityListener = window.electron.miniPlayer.onLyricVisibility?.(
    (visible: boolean) => {
      miniLyricPanelVisible = visible;
    },
  );

  const getProgressSyncInterval = () =>
    miniLyricPanelVisible
      ? MINI_PLAYER_PROGRESS_SYNC_INTERVAL_MS
      : MINI_PLAYER_IDLE_SYNC_INTERVAL_MS;

  const stabilizeLyricPayload = (payload: MiniPlayerLyricPayload): MiniPlayerLyricPayload => {
    const trackId = payload.trackId;
    const time = Number(currentTime.value || 0);
    if (trackId !== lastStableLyricTrackId) {
      lastStableLyricTrackId = trackId;
      lastStableLyricIndex = payload.currentIndex;
      lastStableLyricTime = time;
      return payload;
    }

    const isPlaybackJitterBackwards =
      Boolean(trackId) &&
      isPlaying.value &&
      payload.currentIndex < lastStableLyricIndex &&
      lastStableLyricIndex - payload.currentIndex <= 2 &&
      time >= lastStableLyricTime - 0.35;

    const currentIndex = isPlaybackJitterBackwards ? lastStableLyricIndex : payload.currentIndex;

    lastStableLyricIndex = currentIndex;
    lastStableLyricTime = time;

    if (currentIndex === payload.currentIndex) return payload;
    return { ...payload, currentIndex };
  };

  const syncPlaybackSnapshot = () => {
    const playback = buildPlaybackPayload();
    const nextPlaybackKey = JSON.stringify({ playback });
    if (nextPlaybackKey === lastSyncedPlaybackKey) return;

    window.electron.miniPlayer?.syncSnapshot({ playback });
    lastSyncedPlaybackKey = nextPlaybackKey;
  };

  const syncQueueSnapshot = () => {
    const queue = buildQueuePayload();
    const nextQueueKey = queuePayloadKey(queue);
    if (nextQueueKey === lastSyncedQueueKey) return;

    window.electron.miniPlayer?.syncSnapshot({ queue });
    lastSyncedQueueKey = nextQueueKey;
  };

  const syncLyricLinesSnapshot = () => {
    const lyric = stabilizeLyricPayload(buildLyricPayload());
    const nextLinesKey = lyricLinesPayloadKey(lyric);
    const nextStateKey = JSON.stringify({
      currentIndex: lyric.currentIndex,
      timeOffset: lyric.timeOffset,
      desktopLyricEnabled: lyric.desktopLyricEnabled,
    });
    if (nextLinesKey === lastSyncedLyricLinesKey && nextStateKey === lastSyncedLyricStateKey) {
      return;
    }

    window.electron.miniPlayer?.syncSnapshot({ lyric });
    lastSyncedLyricLinesKey = nextLinesKey;
    lastSyncedLyricStateKey = nextStateKey;
  };

  const syncLyricStateSnapshot = () => {
    lyricStore.updateCurrentIndex(currentTime.value);
    const lyric = stabilizeLyricPayload(buildLyricPayload());
    const nextStateKey = JSON.stringify({
      currentIndex: lyric.currentIndex,
      timeOffset: lyric.timeOffset,
      desktopLyricEnabled: lyric.desktopLyricEnabled,
    });
    if (nextStateKey === lastSyncedLyricStateKey) return;

    window.electron.miniPlayer?.syncSnapshot({
      lyric: {
        currentIndex: lyric.currentIndex,
        timeOffset: lyric.timeOffset,
        desktopLyricEnabled: lyric.desktopLyricEnabled,
      },
    });
    lastSyncedLyricStateKey = nextStateKey;
  };

  const syncAppearanceSnapshot = () => {
    window.electron.miniPlayer?.syncSnapshot({
      appearance: {
        isDark: themeStore.isDark,
        accentColor: themeStore.sourceColor || '#0071e3',
        fontFamily: settingStore.buildGlobalFontFamily(),
      },
    });
  };

  const scheduleProgressSync = () => {
    progressSyncQueued = true;
    if (progressSyncTimer) return;

    progressSyncTimer = setTimeout(() => {
      progressSyncTimer = null;
      if (!progressSyncQueued) return;
      progressSyncQueued = false;
      syncPlaybackSnapshot();
      syncLyricStateSnapshot();
    }, getProgressSyncInterval());
  };

  const disposeSnapshotListener = window.electron.miniPlayer.onSnapshot(() => {
    // 仅用于保持注册（主进程不再广播给主渲染进程），无需处理
  });

  const disposeCommandListener = window.electron.miniPlayer.onCommand(executeMiniPlayerCommand);

  stops.push(
    watch(
      [
        currentTime,
        isPlaying,
        duration,
        playbackRate,
        currentTrackId,
        currentTrackSnapshot,
        volume,
        favorites,
        favoritesLoaded,
        // 启动恢复后快照可能为空，需在队列歌曲加载完成时按 id 重新解析当前曲
        () => resolveCurrentPlaybackQueue()?.songs?.length ?? 0,
      ],
      scheduleProgressSync,
      { immediate: true },
    ),
  );

  stops.push(
    watch(
      [
        lines,
        wantTranslation,
        wantRomanization,
        hasTranslation,
        hasRomanization,
        currentTimeOffset,
        tips,
        () => desktopLyricStore.settings.enabled,
      ],
      syncLyricLinesSnapshot,
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [
        currentSourceQueueId,
        currentTrackId,
        () => resolveCurrentPlaybackQueue()?.songs?.length ?? 0,
        () => resolveCurrentPlaybackQueue()?.songCount,
      ],
      syncQueueSnapshot,
      { immediate: true },
    ),
  );

  stops.push(
    watch(
      [
        () => settingStore.theme,
        () => settingStore.globalFont,
        () => themeStore.isDark,
        () => themeStore.sourceColor,
        () => themeStore.accentMode,
        () => themeStore.presetId,
        () => themeStore.customColor,
      ],
      syncAppearanceSnapshot,
      { immediate: true },
    ),
  );

  return () => {
    disposeSnapshotListener();
    disposeCommandListener();
    disposeLyricVisibilityListener?.();
    if (progressSyncTimer) {
      clearTimeout(progressSyncTimer);
      progressSyncTimer = null;
    }
    stops.forEach((stop) => stop());
  };
};
