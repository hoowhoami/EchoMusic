import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore, testLyricFilter } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useDesktopLyricStore } from './store';
import type {
  DesktopLyricCommand,
  DesktopLyricPlaybackPayload,
  LyricLinePayload,
} from '../../shared/desktop-lyric';

const DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS = 80;
const DESKTOP_LYRIC_OFFSET_STEP_MS = 500;
const DESKTOP_LYRIC_COMMANDS = new Set<DesktopLyricCommand>([
  'togglePlayback',
  'previousTrack',
  'nextTrack',
  'toggleLyricsMode',
  'cycleLyricsMode',
  'openLyricSource',
  'toggleTranslation',
  'toggleRomanization',
  'lyricOffsetBackward',
  'lyricOffsetForward',
  'lyricOffsetReset',
]);

const isDesktopLyricCommand = (value: unknown): value is DesktopLyricCommand =>
  typeof value === 'string' && DESKTOP_LYRIC_COMMANDS.has(value as DesktopLyricCommand);

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

const buildPlaybackPayload = (): DesktopLyricPlaybackPayload | null => {
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
    playbackRate: Number(playerStore.playbackRate || 1),
    updatedAt: Date.now(),
  };
};

export const initDesktopLyricSync = async () => {
  const desktopLyricStore = useDesktopLyricStore();
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  const toastStore = useToastStore();
  if (!window.electron?.desktopLyric) return () => {};

  await desktopLyricStore.hydrate();

  if (desktopLyricStore.settings.enabled) {
    const snapshot = await window.electron.desktopLyric.show();
    desktopLyricStore.setLocal(snapshot.settings);
  }

  const stops: WatchStopHandle[] = [];
  const { currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot } =
    storeToRefs(playerStore);
  const { lines, currentIndex, wantTranslation, wantRomanization, loadedHash, currentTimeOffset } =
    storeToRefs(lyricStore);
  const settingStore = useSettingStore();

  const buildSyncedSettings = (settings = desktopLyricStore.settings) => {
    return {
      ...settings,
      resolvedFontFamily:
        settings.fontFamily === 'follow' ? settingStore.globalFont : settings.resolvedFontFamily,
      wantTranslation: wantTranslation.value,
      wantRomanization: wantRomanization.value,
    };
  };

  let lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings());
  let lastSyncedLyricsKey = '';
  let lastSyncedPlaybackKey = '';
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;

  const buildLyricsPayload = () => {
    const enabled = settingStore.desktopLyricFilterEnabled;
    const pattern = settingStore.desktopLyricFilterPattern;
    const raw = lines.value.map(normalizeLinePayload);
    if (!enabled) return raw;

    // 被过滤的行替换为上一个有效行的内容（保持时间索引不变）
    let lastValidLine: LyricLinePayload | null = null;
    const playerStore = usePlayerStore();
    const track = playerStore.currentTrackSnapshot;
    const fallbackText = track
      ? `${track.title || '未知歌曲'} - ${track.artist || '未知歌手'}`
      : '';

    return raw.map((line) => {
      if (testLyricFilter(line.text, enabled, pattern)) {
        // 被过滤：用上一个有效行替代，保留时间
        if (lastValidLine) {
          return { ...lastValidLine, time: line.time, characters: lastValidLine.characters };
        }
        // 首行即过滤：显示歌曲标题
        return {
          time: line.time,
          text: fallbackText,
          characters: [{ text: fallbackText, startTime: 0, endTime: 0 }],
        };
      }
      lastValidLine = line;
      return line;
    });
  };

  const syncPlaybackSnapshot = async () => {
    const playback = buildPlaybackPayload();
    const nextPlaybackKey = JSON.stringify({
      playback,
      currentIndex: currentIndex.value,
      lyricTimeOffset: currentTimeOffset.value,
      lyricSyncWarning: lyricStore.lyricSyncWarning,
    });
    if (nextPlaybackKey === lastSyncedPlaybackKey) return;

    window.electron.desktopLyric.syncSnapshot({
      playback,
      currentIndex: currentIndex.value,
      lyricTimeOffset: currentTimeOffset.value,
      lyricSyncWarning: lyricStore.lyricSyncWarning,
    });
    lastSyncedPlaybackKey = nextPlaybackKey;
  };

  const syncLyricsSnapshot = async () => {
    const playback = buildPlaybackPayload();
    const lyricsTrackId = playback?.lyricHash || playback?.trackId || null;
    const lyrics = lyricStore.loadedHash === (lyricsTrackId ?? '') ? buildLyricsPayload() : [];
    const nextLyricsKey = JSON.stringify({ lyricsTrackId, lyrics });
    if (nextLyricsKey === lastSyncedLyricsKey) return;

    window.electron.desktopLyric.syncSnapshot({
      playback,
      lyricsTrackId,
      lyrics,
    });
    lastSyncedLyricsKey = nextLyricsKey;
  };

  const scheduleProgressSync = () => {
    progressSyncQueued = true;
    if (progressSyncTimer) return;

    progressSyncTimer = setTimeout(() => {
      progressSyncTimer = null;
      if (!progressSyncQueued) return;
      progressSyncQueued = false;
      void syncPlaybackSnapshot();
    }, DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS);
  };

  const syncSettingsSnapshot = async () => {
    const nextSettings = buildSyncedSettings();
    const nextSettingsKey = JSON.stringify(nextSettings);
    if (nextSettingsKey === lastSyncedSettingsKey) return;

    window.electron.desktopLyric.syncSnapshot({
      settings: nextSettings,
    });
    lastSyncedSettingsKey = nextSettingsKey;
  };

  const disposeSnapshotListener = window.electron.desktopLyric.onSnapshot((nextSnapshot) => {
    desktopLyricStore.setLocal(nextSnapshot.settings);
    lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings(nextSnapshot.settings));
    lastSyncedPlaybackKey = JSON.stringify({
      playback: nextSnapshot.playback,
      currentIndex: nextSnapshot.currentIndex,
      lyricTimeOffset: nextSnapshot.lyricTimeOffset,
      lyricSyncWarning: nextSnapshot.lyricSyncWarning,
    });
    lastSyncedLyricsKey = JSON.stringify({
      lyricsTrackId: nextSnapshot.lyricsTrackId,
      lyrics: nextSnapshot.lyrics,
    });
  });

  const handleDesktopLyricCommand = (command: DesktopLyricCommand) => {
    if (command === 'toggleTranslation') {
      lyricStore.wantTranslation = !lyricStore.wantTranslation;
      void syncSettingsSnapshot();
      return;
    }
    if (command === 'toggleRomanization') {
      lyricStore.wantRomanization = !lyricStore.wantRomanization;
      void syncSettingsSnapshot();
      return;
    }
    if (command === 'lyricOffsetBackward') {
      const nextOffset = lyricStore.adjustTimeOffset(-DESKTOP_LYRIC_OFFSET_STEP_MS);
      const sign = nextOffset >= 0 ? '+' : '';
      toastStore.success(`歌词偏移: ${sign}${(nextOffset / 1000).toFixed(1)}s`);
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      void syncPlaybackSnapshot();
      return;
    }
    if (command === 'lyricOffsetForward') {
      const nextOffset = lyricStore.adjustTimeOffset(DESKTOP_LYRIC_OFFSET_STEP_MS);
      const sign = nextOffset >= 0 ? '+' : '';
      toastStore.success(`歌词偏移: ${sign}${(nextOffset / 1000).toFixed(1)}s`);
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      void syncPlaybackSnapshot();
      return;
    }
    if (command === 'lyricOffsetReset') {
      lyricStore.resetTimeOffset();
      toastStore.success('歌词偏移已重置');
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      void syncPlaybackSnapshot();
    }
  };
  const handleDesktopLyricIpcCommand = (...args: unknown[]) => {
    const command = args[0];
    if (isDesktopLyricCommand(command)) handleDesktopLyricCommand(command);
  };

  window.electron.ipcRenderer.on('desktop-lyric:command', handleDesktopLyricIpcCommand);

  stops.push(
    watch(
      [
        currentTime,
        isPlaying,
        duration,
        playbackRate,
        currentTrackId,
        currentTrackSnapshot,
        currentTimeOffset,
      ],
      () => {
        // 桌面歌词启用时自驱动歌词行索引（不更新逐字高亮，桌面歌词窗口自己处理）
        if (desktopLyricStore.settings.enabled) {
          lyricStore.updateCurrentIndex(currentTime.value);
        }
        scheduleProgressSync();
      },
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [lines, loadedHash, currentTrackId, currentTrackSnapshot],
      () => {
        void syncLyricsSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  // 桌面歌词过滤设置变化时重新同步歌词
  stops.push(
    watch(
      () => [settingStore.desktopLyricFilterEnabled, settingStore.desktopLyricFilterPattern],
      () => {
        void syncLyricsSnapshot();
      },
    ),
  );

  stops.push(
    watch(
      [currentIndex],
      () => {
        scheduleProgressSync();
      },
      { immediate: true },
    ),
  );

  stops.push(
    watch(
      [
        () => desktopLyricStore.settings,
        () => settingStore.globalFont,
        wantTranslation,
        wantRomanization,
      ],
      () => {
        void syncSettingsSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  return () => {
    disposeSnapshotListener();
    window.electron?.ipcRenderer?.off('desktop-lyric:command', handleDesktopLyricIpcCommand);
    if (progressSyncTimer) {
      clearTimeout(progressSyncTimer);
      progressSyncTimer = null;
    }
    stops.forEach((stop) => stop());
  };
};
