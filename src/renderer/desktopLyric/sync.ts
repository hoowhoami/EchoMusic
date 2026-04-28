import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { useDesktopLyricStore } from './store';
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
  const desktopLyricStore = useDesktopLyricStore();
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  if (!window.electron?.desktopLyric) return () => {};

  await desktopLyricStore.hydrate();

  if (desktopLyricStore.settings.enabled) {
    const snapshot = await window.electron.desktopLyric.show();
    desktopLyricStore.setLocal(snapshot.settings);
  }

  const stops: WatchStopHandle[] = [];
  const { currentTime, isPlaying, duration, playbackRate, currentTrackId, currentTrackSnapshot } =
    storeToRefs(playerStore);
  const { lines, currentIndex, wantTranslation, wantRomanization } = storeToRefs(lyricStore);

  const buildSyncedSettings = (settings = desktopLyricStore.settings) => {
    return {
      ...settings,
      wantTranslation: wantTranslation.value,
      wantRomanization: wantRomanization.value,
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
    desktopLyricStore.setLocal(nextSnapshot.settings);
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
      [() => desktopLyricStore.settings, wantTranslation, wantRomanization],
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
