import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import type { DesktopLyricPlaybackPayload, LyricLinePayload } from '../../shared/desktop-lyric';

const normalizeLinePayload = (line: ReturnType<typeof useLyricStore>['lines'][number]): LyricLinePayload => ({
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
  const { lines, currentIndex, lyricsMode, secondaryEnabled, preferredMode } = storeToRefs(lyricStore);

  const buildSyncedSettings = (settings = settingStore.desktopLyric) => {
    const { locked: _locked, clickThrough: _clickThrough, ...desktopLyricSettings } = settings;
    return {
      ...desktopLyricSettings,
      secondaryEnabled: secondaryEnabled.value,
      secondaryMode: secondaryEnabled.value ? lyricsMode.value : preferredMode.value,
    };
  };

  let lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings());

  const syncPlaybackSnapshot = async () => {
    await window.electron.desktopLyric.syncSnapshot({
      playback: buildPlaybackPayload(),
      lyrics: lines.value.map(normalizeLinePayload),
      currentIndex: currentIndex.value,
    });
  };

  const syncSettingsSnapshot = async () => {
    const nextSettings = buildSyncedSettings();
    const nextSettingsKey = JSON.stringify(nextSettings);
    if (nextSettingsKey === lastSyncedSettingsKey) return;

    await window.electron.desktopLyric.syncSnapshot({
      settings: nextSettings,
    });
    lastSyncedSettingsKey = nextSettingsKey;
  };

  const disposeSnapshotListener = window.electron.desktopLyric.onSnapshot((nextSnapshot) => {
    settingStore.setDesktopLyricLocal(nextSnapshot.settings);
    lastSyncedSettingsKey = JSON.stringify(buildSyncedSettings(nextSnapshot.settings));
  });

  stops.push(
    watch(
      [currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot],
      () => {
        void syncPlaybackSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [lines, currentIndex],
      () => {
        void syncPlaybackSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  stops.push(
    watch(
      [() => settingStore.desktopLyric, lyricsMode, secondaryEnabled],
      () => {
        void syncSettingsSnapshot();
      },
      { immediate: true, deep: true },
    ),
  );

  return () => {
    disposeSnapshotListener();
    stops.forEach((stop) => stop());
  };
};
