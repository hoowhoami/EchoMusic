import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore, testLyricFilter } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useDesktopLyricStore } from './store';
import {
  DESKTOP_LYRIC_LINE_LOOKAHEAD_MS,
  mergeDesktopLyricSnapshotMessage,
} from '../../shared/desktop-lyric';
import type {
  DesktopLyricCommand,
  DesktopLyricPlaybackPayload,
  DesktopLyricSettings,
  LyricLinePayload,
} from '../../shared/desktop-lyric';

const DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS = 80;
const DESKTOP_LYRIC_DETAILS_SYNC_DELAY_MS = 700;
const DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_MS = 500;
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

const boolKey = (value: unknown) => (value ? '1' : '0');

const stableNumberKey = (value: unknown, scale = 1) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * scale));
};

const hashText = (value: string, seed = 5381) => {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const buildSettingsSignature = (settings: DesktopLyricSettings) =>
  [
    boolKey(settings.enabled),
    boolKey(settings.locked),
    boolKey(settings.autoShow),
    boolKey(settings.alwaysOnTop),
    boolKey(settings.wantTranslation),
    boolKey(settings.wantRomanization),
    settings.theme,
    stableNumberKey(settings.opacity, 1000),
    stableNumberKey(settings.scale, 1000),
    settings.fontFamily,
    settings.resolvedFontFamily ?? '',
    settings.inactiveFontSize,
    settings.activeFontSize,
    settings.secondaryFontSize,
    settings.lineGap,
    settings.alignment,
    boolKey(settings.doubleLine),
    settings.playedColor,
    settings.unplayedColor,
    settings.strokeColor,
    boolKey(settings.strokeEnabled),
    settings.shadowStrength,
    boolKey(settings.bold),
    stableNumberKey(settings.offsetStep, 1000),
  ].join('\u001f');

const buildPlaybackSignature = (
  playback: DesktopLyricPlaybackPayload | null,
  currentIndex: number,
  lyricTimeOffset: number,
  lyricSyncWarning: boolean | undefined,
) =>
  [
    playback?.trackId ?? '',
    playback?.lyricHash ?? '',
    playback?.title ?? '',
    playback?.artist ?? '',
    playback?.album ?? '',
    playback?.coverUrl ?? '',
    stableNumberKey(playback?.duration, 1000),
    stableNumberKey(playback?.currentTime, 1000),
    boolKey(playback?.isPlaying),
    stableNumberKey(playback?.playbackRate ?? 1, 1000),
    currentIndex,
    lyricTimeOffset,
    boolKey(lyricSyncWarning),
  ].join('\u001f');

const hashLyricLine = (hash: number, line: LyricLinePayload) => {
  let nextHash = hashText(
    `${line.time}|${line.text}|${line.translated ?? ''}|${line.romanized ?? ''}`,
    hash,
  );
  for (const character of line.characters ?? []) {
    nextHash = hashText(`${character.startTime}:${character.endTime}:${character.text}`, nextHash);
  }
  return nextHash;
};

const buildLyricsSignature = (lyricsTrackId: string | null, lyrics: LyricLinePayload[]) => {
  let hash = hashText(lyricsTrackId ?? '');
  let characterCount = 0;
  for (const line of lyrics) {
    characterCount += line.characters?.length ?? 0;
    hash = hashLyricLine(hash, line);
  }
  return `${lyricsTrackId ?? ''}\u001f${lyrics.length}\u001f${characterCount}\u001f${hash}`;
};

const buildLyricDetailsSignature = (
  lyricsTrackId: string | null,
  lyricDetails: Record<number, LyricLinePayload>,
) => {
  let hash = hashText(lyricsTrackId ?? '');
  const indexes = Object.keys(lyricDetails)
    .map((key) => Number(key))
    .filter((index) => Number.isInteger(index))
    .sort((a, b) => a - b);
  let characterCount = 0;
  for (const index of indexes) {
    const line = lyricDetails[index];
    if (!line) continue;
    characterCount += line.characters?.length ?? 0;
    hash = hashText(String(index), hashLyricLine(hash, line));
  }
  return `${lyricsTrackId ?? ''}\u001f${indexes.join(',')}\u001f${characterCount}\u001f${hash}`;
};

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

const toTimelineLinePayload = (line: LyricLinePayload): LyricLinePayload => {
  const firstCharacter = line.characters?.[0];
  const lastCharacter = line.characters?.[line.characters.length - 1];
  const startTime = firstCharacter?.startTime ?? Math.round(line.time * 1000);
  const endTime = lastCharacter?.endTime ?? firstCharacter?.endTime ?? startTime;
  return {
    ...line,
    characters: [
      {
        text: line.text,
        startTime,
        endTime,
      },
    ],
  };
};

const buildVisibleLyricDetails = (lyrics: LyricLinePayload[], activeIndexes: number[]) => {
  const details: Record<number, LyricLinePayload> = {};
  const centers = activeIndexes.filter((index) => Number.isInteger(index) && index >= 0);
  if (centers.length === 0 && lyrics.length > 0) centers.push(0);
  for (const activeIndex of centers) {
    const start = Math.max(0, activeIndex - 1);
    const end = Math.min(lyrics.length - 1, activeIndex + 4);
    for (let index = start; index <= end; index++) {
      const line = lyrics[index];
      if (line && (line.characters?.length ?? 0) > 1) details[index] = line;
    }
  }
  return details;
};

const buildPlaybackPayload = (): DesktopLyricPlaybackPayload | null => {
  const playerStore = usePlayerStore();
  const track = playerStore.currentTrackSnapshot;
  if (!track || !playerStore.currentTrackId) return null;
  const lyricHash = String(track.hash ?? track.id ?? playerStore.currentTrackId ?? '').trim();

  return {
    trackId: String(playerStore.currentTrackId),
    lyricHash,
    title: String(track.name || '未知歌曲'),
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

  let lastSyncedSettingsKey = buildSettingsSignature(buildSyncedSettings());
  let lastSyncedLyricsKey = '';
  let lastSyncedLyricDetailsKey = '';
  let lastSyncedPlaybackKey = '';
  let lastFullLyricsTrackId: string | null = null;
  let lastFullLyricsPayload: LyricLinePayload[] = [];
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;
  let lyricDetailsSyncTimer: ReturnType<typeof setTimeout> | null = null;

  const buildFullLyricsPayload = () => {
    const enabled = settingStore.desktopLyricFilterEnabled;
    const pattern = settingStore.desktopLyricFilterPattern;
    const raw = lines.value.map(normalizeLinePayload);
    if (!enabled) return raw;

    // 被过滤的行替换为上一个有效行的内容（保持时间索引不变）
    let lastValidLine: LyricLinePayload | null = null;
    const playerStore = usePlayerStore();
    const track = playerStore.currentTrackSnapshot;
    const fallbackText = track ? `${track.name || '未知歌曲'} - ${track.artist || '未知歌手'}` : '';

    return raw.map((line) => {
      const lineStart = line.characters?.[0]?.startTime ?? Math.round(line.time * 1000);
      const lineEnd = line.characters?.[line.characters.length - 1]?.endTime ?? lineStart;
      if (!testLyricFilter(line.text, enabled, pattern)) {
        lastValidLine = line;
        return line;
      }

      // 被过滤：用上一个有效行替代，保留时间
      if (lastValidLine) {
        return {
          ...lastValidLine,
          time: line.time,
          characters: [{ text: lastValidLine.text, startTime: lineStart, endTime: lineEnd }],
        };
      }
      // 首行即过滤：显示歌曲标题
      return {
        time: line.time,
        text: fallbackText,
        characters: [
          {
            text: fallbackText,
            startTime: lineStart,
            endTime: lineEnd,
          },
        ],
      };
    });
  };

  const calculateDesktopLyricVisualIndex = (playback: DesktopLyricPlaybackPayload | null) => {
    const currentTimeMs = Math.round(
      (playback?.currentTime ?? playerStore.currentTime ?? 0) * 1000,
    );
    return lyricStore.findIndexAtTimeMs(
      currentTimeMs + currentTimeOffset.value + DESKTOP_LYRIC_LINE_LOOKAHEAD_MS,
    );
  };

  const buildLyricDetailsPayload = (
    fullLyrics?: LyricLinePayload[],
    playback: DesktopLyricPlaybackPayload | null = buildPlaybackPayload(),
  ) => {
    const visual = calculateDesktopLyricVisualIndex(playback);
    return buildVisibleLyricDetails(fullLyrics ?? buildFullLyricsPayload(), [
      currentIndex.value,
      visual,
    ]);
  };

  const syncLyricDetailsSnapshot = async (fullLyrics?: LyricLinePayload[]) => {
    const playback = buildPlaybackPayload();
    const lyricsTrackId = playback?.lyricHash || playback?.trackId || null;
    const detailSource =
      fullLyrics ??
      (lastFullLyricsTrackId === lyricsTrackId ? lastFullLyricsPayload : buildFullLyricsPayload());
    const lyricDetails =
      lyricStore.loadedHash === (lyricsTrackId ?? '')
        ? buildLyricDetailsPayload(detailSource, playback)
        : {};
    const nextLyricDetailsKey = buildLyricDetailsSignature(lyricsTrackId, lyricDetails);
    if (nextLyricDetailsKey === lastSyncedLyricDetailsKey) return;

    window.electron.desktopLyric.syncSnapshot({
      lyricsTrackId,
      lyricDetails,
    });
    lastSyncedLyricDetailsKey = nextLyricDetailsKey;
  };

  const syncPlaybackSnapshot = async () => {
    const playback = buildPlaybackPayload();
    const nextPlaybackKey = buildPlaybackSignature(
      playback,
      currentIndex.value,
      currentTimeOffset.value,
      lyricStore.lyricSyncWarning,
    );
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
    const fullLyrics =
      lyricStore.loadedHash === (lyricsTrackId ?? '') ? buildFullLyricsPayload() : [];
    lastFullLyricsTrackId = lyricsTrackId;
    lastFullLyricsPayload = fullLyrics;
    const lyrics = fullLyrics.map(toTimelineLinePayload);
    const nextLyricsKey = buildLyricsSignature(lyricsTrackId, lyrics);
    const lyricDetails = buildLyricDetailsPayload(fullLyrics, playback);
    const nextLyricDetailsKey = buildLyricDetailsSignature(lyricsTrackId, lyricDetails);
    if (nextLyricsKey === lastSyncedLyricsKey && nextLyricDetailsKey === lastSyncedLyricDetailsKey)
      return;

    if (nextLyricsKey !== lastSyncedLyricsKey) {
      window.electron.desktopLyric.syncSnapshot({
        playback,
        lyricsTrackId,
        lyrics,
        lyricDetails,
      });
      lastSyncedLyricsKey = nextLyricsKey;
      lastSyncedLyricDetailsKey = nextLyricDetailsKey;
      return;
    }

    await syncLyricDetailsSnapshot(fullLyrics);
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

  const scheduleLyricDetailsSync = (delayMs = DESKTOP_LYRIC_DETAILS_SYNC_DELAY_MS) => {
    if (lyricDetailsSyncTimer) clearTimeout(lyricDetailsSyncTimer);
    lyricDetailsSyncTimer = setTimeout(() => {
      lyricDetailsSyncTimer = null;
      if (!desktopLyricStore.settings.enabled || lines.value.length === 0) return;
      void syncLyricDetailsSnapshot();
    }, delayMs);
  };

  const syncSettingsSnapshot = async () => {
    const nextSettings = buildSyncedSettings();
    const nextSettingsKey = buildSettingsSignature(nextSettings);
    if (nextSettingsKey === lastSyncedSettingsKey) return;

    window.electron.desktopLyric.syncSnapshot({
      settings: nextSettings,
    });
    lastSyncedSettingsKey = nextSettingsKey;
  };

  const disposeSnapshotListener = window.electron.desktopLyric.onSnapshot((message) => {
    const nextSnapshot = mergeDesktopLyricSnapshotMessage(null, message);
    if (!nextSnapshot) return;
    desktopLyricStore.setLocal(nextSnapshot.settings);
    lastSyncedSettingsKey = buildSettingsSignature(buildSyncedSettings(nextSnapshot.settings));
    lastSyncedPlaybackKey = buildPlaybackSignature(
      nextSnapshot.playback,
      nextSnapshot.currentIndex,
      nextSnapshot.lyricTimeOffset,
      nextSnapshot.lyricSyncWarning,
    );
    lastSyncedLyricsKey = buildLyricsSignature(nextSnapshot.lyricsTrackId, nextSnapshot.lyrics);
    lastSyncedLyricDetailsKey = buildLyricDetailsSignature(
      nextSnapshot.lyricsTrackId,
      nextSnapshot.lyricDetails,
    );
  });

  const handleDesktopLyricCommand = (command: DesktopLyricCommand) => {
    const resolveOffsetStepMs = () => {
      const step = Number(desktopLyricStore.settings.offsetStep);
      return Number.isFinite(step) && step > 0
        ? Math.round(step * 1000)
        : DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_MS;
    };
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
      const nextOffset = lyricStore.adjustTimeOffset(-resolveOffsetStepMs());
      const sign = nextOffset >= 0 ? '+' : '';
      toastStore.success(`歌词偏移: ${sign}${(nextOffset / 1000).toFixed(1)}s`);
      lyricStore.updateCurrentIndex(playerStore.currentTime);
      void syncPlaybackSnapshot();
      return;
    }
    if (command === 'lyricOffsetForward') {
      const nextOffset = lyricStore.adjustTimeOffset(resolveOffsetStepMs());
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
        scheduleLyricDetailsSync();
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
    if (lyricDetailsSyncTimer) {
      clearTimeout(lyricDetailsSyncTimer);
      lyricDetailsSyncTimer = null;
    }
    stops.forEach((stop) => stop());
  };
};
