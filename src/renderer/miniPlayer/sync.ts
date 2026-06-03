import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { executeShortcutCommand } from '@/utils/shortcuts';
import type { Song } from '@/models/song';
import type {
  MiniPlayerCommand,
  MiniPlayerPlaybackPayload,
  MiniPlayerQueuePayload,
} from '../../shared/mini-player';

const MINI_PLAYER_PROGRESS_SYNC_INTERVAL_MS = 120;

// 记录上次「收藏列表已加载时」算出的收藏态：收藏列表在登录刷新等流程中可能被瞬时清空，
// 导致 isFavoriteSong 短暂返回 false 让爱心闪烁。空列表时沿用此缓存，避免误判未收藏。
let lastKnownFavorite: { trackId: string; isFavorite: boolean } | null = null;

const resolveSongArtist = (song: Song): string =>
  String(song.artist || song.artists?.map((item) => item.name).join(' / ') || '未知歌手');

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

const buildPlaybackPayload = (): MiniPlayerPlaybackPayload | null => {
  const playerStore = usePlayerStore();
  const playlistStore = usePlaylistStore();
  const lyricStore = useLyricStore();
  const track = resolveCurrentTrack();
  if (!track || !playerStore.currentTrackId) return null;

  const trackId = String(playerStore.currentTrackId);
  // 收藏列表非空时以实际计算为准并缓存；为空（未加载/瞬时清空）时沿用同曲的上次结果，避免爱心闪烁
  let isFavorite: boolean;
  if (playlistStore.favorites.length > 0) {
    isFavorite = playlistStore.isFavoriteSong(track);
    lastKnownFavorite = { trackId, isFavorite };
  } else if (lastKnownFavorite && lastKnownFavorite.trackId === trackId) {
    isFavorite = lastKnownFavorite.isFavorite;
  } else {
    isFavorite = playlistStore.isFavoriteSong(track);
  }

  return {
    trackId,
    title: String(track.title || track.name || '未知歌曲'),
    artist: resolveSongArtist(track),
    album: String(track.album ?? track.albumName ?? ''),
    coverUrl: String(track.coverUrl || track.cover || ''),
    duration: Number(playerStore.duration || track.duration || 0),
    currentTime: Number(playerStore.currentTime || 0),
    isPlaying: Boolean(playerStore.isPlaying),
    isFavorite,
    lyricsLabel: lyricStore.currentDisplayLabel,
    volume: Number(playerStore.volume || 0),
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
      title: String(song.title || song.name || '未知歌曲'),
      artist: resolveSongArtist(song),
      coverUrl: String(song.coverUrl || song.cover || ''),
    })),
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

const executeMiniPlayerCommand = (command: MiniPlayerCommand) => {
  if (typeof command === 'string') {
    if (command === 'toggleFavorite') {
      // 单独处理收藏：用 resolveCurrentTrack（含来源队列回退）解析当前曲，
      // 避免 executeShortcutCommand 仅查 activeQueue 在「未播放/来源队列≠活动队列」时找不到曲
      const playlistStore = usePlaylistStore();
      const track = resolveCurrentTrack();
      if (!track) return;
      if (playlistStore.isFavoriteSong(track)) {
        playlistStore.removeFromFavorites(track.id);
      } else {
        playlistStore.addToFavorites(track);
      }
      return;
    }
    if (
      command === 'togglePlayback' ||
      command === 'previousTrack' ||
      command === 'nextTrack' ||
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
  const stops: WatchStopHandle[] = [];
  const {
    currentTime,
    isPlaying,
    duration,
    currentTrackId,
    currentTrackSnapshot,
    volume,
    currentSourceQueueId,
  } = storeToRefs(playerStore);
  const { favorites } = storeToRefs(playlistStore);
  const { wantTranslation, wantRomanization, hasTranslation, hasRomanization } =
    storeToRefs(lyricStore);

  let lastSyncedPlaybackKey = '';
  let lastSyncedQueueKey = '';
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;

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

  const syncAppearanceSnapshot = () => {
    const isDark =
      settingStore.theme === 'dark' ||
      (settingStore.theme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    window.electron.miniPlayer?.syncSnapshot({
      appearance: {
        isDark,
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
    }, MINI_PLAYER_PROGRESS_SYNC_INTERVAL_MS);
  };

  const disposeSnapshotListener = window.electron.miniPlayer.onSnapshot((nextSnapshot) => {
    lastSyncedPlaybackKey = JSON.stringify({
      playback: nextSnapshot.playback,
    });
    lastSyncedQueueKey = queuePayloadKey(nextSnapshot.queue);
  });

  const disposeCommandListener = window.electron.miniPlayer.onCommand(executeMiniPlayerCommand);

  stops.push(
    watch(
      [
        currentTime,
        isPlaying,
        duration,
        currentTrackId,
        currentTrackSnapshot,
        volume,
        favorites,
        wantTranslation,
        wantRomanization,
        hasTranslation,
        hasRomanization,
        // 启动恢复后快照可能为空，需在队列歌曲加载完成时按 id 重新解析当前曲
        () => resolveCurrentPlaybackQueue()?.songs,
      ],
      scheduleProgressSync,
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [
        currentSourceQueueId,
        currentTrackId,
        () => resolveCurrentPlaybackQueue()?.songs,
        () => resolveCurrentPlaybackQueue()?.songCount,
      ],
      syncQueueSnapshot,
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [
        () => settingStore.theme,
        () => settingStore.globalFont,
        () => themeStore.sourceColor,
        () => themeStore.accentMode,
        () => themeStore.presetId,
        () => themeStore.customColor,
      ],
      syncAppearanceSnapshot,
      { immediate: true },
    ),
  );

  // 系统主题切换（theme=system 时跟随）：媒体查询变化不会触发上面的 store watch，需单独监听
  const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleColorSchemeChange = () => syncAppearanceSnapshot();
  colorSchemeQuery.addEventListener('change', handleColorSchemeChange);

  return () => {
    disposeSnapshotListener();
    disposeCommandListener();
    colorSchemeQuery.removeEventListener('change', handleColorSchemeChange);
    if (progressSyncTimer) {
      clearTimeout(progressSyncTimer);
      progressSyncTimer = null;
    }
    stops.forEach((stop) => stop());
  };
};
