import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { PERSONAL_FM_QUEUE_ID, usePlaylistStore } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { useToastStore } from '@/stores/toast';
import { executeShortcutCommand } from '@/utils/shortcuts';
import { setWithLimit } from '@/utils/lruMap';
import type { Song } from '@/models/song';
import { resolveFavoriteSongKey } from '@/stores/playlist/helpers';
import type {
  NowPlayingCommand,
  NowPlayingPlaybackPayload,
  NowPlayingSnapshotPatch,
} from '../../shared/now-playing';
import type { LyricLinePayload } from '../../shared/lyrics';
import type { ShortcutCommand } from '../../shared/shortcuts';

const NOW_PLAYING_PROGRESS_SYNC_INTERVAL_MS = 120;
const LYRIC_OFFSET_STEP_MS = 500;
const FAVORITES_QUEUE_ID = 'queue:favorites';
// 收藏状态缓存上限，按歌曲键裁剪最旧条目，避免长会话无界增长
const FAVORITE_STATE_CACHE_MAX = 500;

const favoriteStateCache = new Map<string, boolean>();

const SHORTCUT_COMMANDS = new Set<ShortcutCommand>([
  'togglePlayback',
  'previousTrack',
  'nextTrack',
  'seekForward',
  'seekBackward',
  'toggleMainLyric',
  'toggleDesktopLyric',
  'toggleLyricsMode',
  'cycleLyricsMode',
  'openLyricSource',
  'volumeUp',
  'volumeDown',
  'toggleMute',
  'toggleFavorite',
  'togglePlayMode',
  'toggleMiniPlayer',
  'toggleWindow',
  'toggleSidebar',
]);

const NOW_PLAYING_COMMANDS = new Set<NowPlayingCommand>([
  ...SHORTCUT_COMMANDS,
  'toggleTranslation',
  'toggleRomanization',
  'lyricOffsetBackward',
  'lyricOffsetForward',
  'lyricOffsetReset',
]);

const isNowPlayingCommand = (value: unknown): value is NowPlayingCommand =>
  typeof value === 'string' && NOW_PLAYING_COMMANDS.has(value as NowPlayingCommand);

const normalizeLinePayload = (
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

const buildPlaybackPayload = (): NowPlayingPlaybackPayload | null => {
  const playerStore = usePlayerStore();
  const track = playerStore.currentTrackSnapshot;
  if (!track || !playerStore.currentTrackId) return null;
  const lyricHash = String(track.hash ?? track.id ?? playerStore.currentTrackId ?? '').trim();

  return {
    trackId: String(playerStore.currentTrackId),
    lyricHash,
    title: String(track.title || track.name || '未知歌曲'),
    artist: String(
      track.artist || track.artists?.map((item: any) => item.name).join(' / ') || '未知歌手',
    ),
    album: String(track.album ?? track.albumName ?? ''),
    coverUrl: String(track.coverUrl || track.cover || ''),
    duration: Number(playerStore.duration || track.duration || 0),
    currentTime: Number(playerStore.currentTime || 0),
    isPlaying: Boolean(playerStore.isPlaying),
    isFavorite: resolveFavoriteState(track as Song),
    isPersonalFM: resolveCurrentPlaybackQueue()?.id === PERSONAL_FM_QUEUE_ID,
    playbackRate: Number(playerStore.playbackRate || 1),
    updatedAt: Date.now(),
  };
};

export const initNowPlayingSync = async () => {
  if (!window.electron?.nowPlaying) return () => {};

  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const settingStore = useSettingStore();
  const themeStore = useThemeStore();
  const toastStore = useToastStore();
  const stops: WatchStopHandle[] = [];
  const { currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot } =
    storeToRefs(playerStore);
  const { favorites, favoritesLoaded } = storeToRefs(playlistStore);
  const {
    lines,
    currentIndex,
    loadedHash,
    currentTimeOffset,
    wantTranslation,
    wantRomanization,
    hasTranslation,
    hasRomanization,
    isLoading,
    tips,
  } = storeToRefs(lyricStore);

  let lyricRevision = 0;
  let lastSyncedPlaybackKey = '';
  let lastSyncedLyricKey = '';
  let lastSyncedAppearanceKey = '';
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;

  const sendPatch = (patch: NowPlayingSnapshotPatch) => {
    window.electron?.nowPlaying?.syncSnapshot(patch);
  };

  const buildLyricPayload = (includeLines: boolean) => {
    const playback = buildPlaybackPayload();
    const trackId = playback?.lyricHash || playback?.trackId || null;
    const activeLines =
      trackId && loadedHash.value === trackId ? lines.value.map(normalizeLinePayload) : [];
    return {
      trackId,
      revision: lyricRevision,
      ...(includeLines ? { lines: activeLines } : {}),
      currentIndex: currentIndex.value,
      timeOffset: currentTimeOffset.value,
      wantTranslation: wantTranslation.value,
      wantRomanization: wantRomanization.value,
      hasTranslation: hasTranslation.value,
      hasRomanization: hasRomanization.value,
      mode: lyricStore.lyricsMode,
      isLoading: isLoading.value,
      tips: tips.value,
      syncWarning: lyricStore.lyricSyncWarning,
    };
  };

  const syncPlaybackSnapshot = () => {
    const playback = buildPlaybackPayload();
    const lyric = buildLyricPayload(false);
    const nextKey = JSON.stringify({
      playback,
      currentIndex: lyric.currentIndex,
      timeOffset: lyric.timeOffset,
      syncWarning: lyric.syncWarning,
    });
    if (nextKey === lastSyncedPlaybackKey) return;
    sendPatch({ playback, lyric });
    lastSyncedPlaybackKey = nextKey;
  };

  const syncLyricSnapshot = () => {
    const nextLyricBody = buildLyricPayload(true);
    const nextKey = JSON.stringify(nextLyricBody);
    if (nextKey === lastSyncedLyricKey) return;
    lyricRevision += 1;
    const lyric = { ...nextLyricBody, revision: lyricRevision };
    sendPatch({ playback: buildPlaybackPayload(), lyric });
    lastSyncedLyricKey = JSON.stringify(lyric);
    lastSyncedPlaybackKey = '';
  };

  const syncAppearanceSnapshot = () => {
    const appearance = {
      isDark: themeStore.isDark,
      accentColor: themeStore.sourceColor || themeStore.coverColor || '#31cfa1',
      fontFamily: settingStore.buildGlobalFontFamily(),
    };
    const nextKey = JSON.stringify(appearance);
    if (nextKey === lastSyncedAppearanceKey) return;
    sendPatch({ appearance });
    lastSyncedAppearanceKey = nextKey;
  };

  const scheduleProgressSync = () => {
    progressSyncQueued = true;
    if (progressSyncTimer) return;
    progressSyncTimer = setTimeout(() => {
      progressSyncTimer = null;
      if (!progressSyncQueued) return;
      progressSyncQueued = false;
      syncPlaybackSnapshot();
    }, NOW_PLAYING_PROGRESS_SYNC_INTERVAL_MS);
  };

  const handleCommand = (command: NowPlayingCommand) => {
    if (SHORTCUT_COMMANDS.has(command as ShortcutCommand)) {
      executeShortcutCommand(command as ShortcutCommand);
      syncPlaybackSnapshot();
      return;
    }
    if (command === 'toggleTranslation') {
      lyricStore.wantTranslation = !lyricStore.wantTranslation;
      syncLyricSnapshot();
      return;
    }
    if (command === 'toggleRomanization') {
      lyricStore.wantRomanization = !lyricStore.wantRomanization;
      syncLyricSnapshot();
      return;
    }
    if (command === 'lyricOffsetBackward' || command === 'lyricOffsetForward') {
      const delta =
        command === 'lyricOffsetBackward' ? -LYRIC_OFFSET_STEP_MS : LYRIC_OFFSET_STEP_MS;
      const nextOffset = lyricStore.adjustTimeOffset(delta);
      const sign = nextOffset >= 0 ? '+' : '';
      toastStore.success(`歌词偏移: ${sign}${(nextOffset / 1000).toFixed(1)}s`);
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      syncPlaybackSnapshot();
      return;
    }
    if (command === 'lyricOffsetReset') {
      lyricStore.resetTimeOffset();
      toastStore.success('歌词偏移已重置');
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      syncPlaybackSnapshot();
    }
  };

  const disposeCommandListener = window.electron.nowPlaying.onCommand((command) => {
    if (isNowPlayingCommand(command)) handleCommand(command);
  });

  stops.push(
    watch(
      [
        currentTime,
        isPlaying,
        duration,
        playbackRate,
        currentTrackId,
        currentTrackSnapshot,
        favorites,
        favoritesLoaded,
        () => resolveCurrentPlaybackQueue()?.songs?.length ?? 0,
      ],
      scheduleProgressSync,
      { deep: true },
    ),
    watch(
      [
        lines,
        loadedHash,
        wantTranslation,
        wantRomanization,
        hasTranslation,
        hasRomanization,
        isLoading,
        tips,
      ],
      syncLyricSnapshot,
      { deep: true, immediate: true },
    ),
    watch([currentIndex, currentTimeOffset], syncPlaybackSnapshot),
    watch(
      () => [
        themeStore.isDark,
        themeStore.sourceColor,
        themeStore.coverColor,
        settingStore.globalFont,
      ],
      syncAppearanceSnapshot,
      { immediate: true },
    ),
  );

  syncLyricSnapshot();
  syncPlaybackSnapshot();
  syncAppearanceSnapshot();

  return () => {
    if (progressSyncTimer) clearTimeout(progressSyncTimer);
    progressSyncTimer = null;
    disposeCommandListener();
    stops.forEach((stop) => stop());
  };
};
