import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import type { DesktopLyricPlaybackPayload, LyricLinePayload } from '../../shared/desktop-lyric';

const DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS = 80;

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

  return {
    trackId: String(playerStore.currentTrackId),
    title: String(track.title || track.name || '未知歌曲'),
    artist: String(
      track.artist || track.artists?.map((item) => item.name).join(' / ') || '未知歌手',
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
  const settingStore = useSettingStore();
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  if (!window.electron?.desktopLyric) return () => {};

  await settingStore.hydrateDesktopLyric();

  if (settingStore.desktopLyric.enabled) {
    const snapshot = await window.electron.desktopLyric.show();
    settingStore.setDesktopLyricLocal(snapshot.settings);
  }

  const stops: WatchStopHandle[] = [];
  const { currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot } =
    storeToRefs(playerStore);
  const { lines, currentIndex, lyricsMode, secondaryEnabled, preferredMode } =
    storeToRefs(lyricStore);

  const buildSyncedSettings = (settings = settingStore.desktopLyric) => {
    const { locked: _locked, clickThrough: _clickThrough, ...desktopLyricSettings } = settings;
    return {
      ...desktopLyricSettings,
      secondaryEnabled: secondaryEnabled.value,
      secondaryMode: secondaryEnabled.value ? lyricsMode.value : preferredMode.value,
    };
  };

  let lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings());
  let lastSyncedLyricsKey = '';
  let lastSyncedPlaybackKey = '';
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;

  const buildLyricsPayload = () => lines.value.map(normalizeLinePayload);

  const syncPlaybackSnapshot = async () => {
    const playback = buildPlaybackPayload();
    const nextPlaybackKey = JSON.stringify({
      playback,
      currentIndex: currentIndex.value,
    });
    if (nextPlaybackKey === lastSyncedPlaybackKey) return;

    window.electron.desktopLyric.syncSnapshot({
      playback,
      currentIndex: currentIndex.value,
    });
    lastSyncedPlaybackKey = nextPlaybackKey;
  };

  const syncLyricsSnapshot = async () => {
    const lyrics = buildLyricsPayload();
    const nextLyricsKey = JSON.stringify({ lyrics });
    if (nextLyricsKey === lastSyncedLyricsKey) return;

    window.electron.desktopLyric.syncSnapshot({
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
    settingStore.setDesktopLyricLocal(nextSnapshot.settings);
    lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings(nextSnapshot.settings));
    lastSyncedPlaybackKey = JSON.stringify({
      playback: nextSnapshot.playback,
      currentIndex: nextSnapshot.currentIndex,
    });
    lastSyncedLyricsKey = JSON.stringify({
      lyrics: nextSnapshot.lyrics,
    });
  });

  stops.push(
    watch(
      [currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot],
      () => {
        scheduleProgressSync();
      },
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [lines],
      () => {
        void syncLyricsSnapshot();
      },
      { immediate: true, deep: true },
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
      [() => settingStore.desktopLyric, lyricsMode, secondaryEnabled, preferredMode],
      () => {
        void syncSettingsSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  return () => {
    disposeSnapshotListener();
    if (progressSyncTimer) {
      clearTimeout(progressSyncTimer);
      progressSyncTimer = null;
    }
    stops.forEach((stop) => stop());
  };
};
