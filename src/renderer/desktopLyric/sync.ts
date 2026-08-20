import { watch, type WatchStopHandle } from 'vue';
import { storeToRefs } from 'pinia';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useDesktopLyricStore } from './store';
import {
  DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_SECONDS,
  isDesktopLyricFullSnapshot,
  mergeDesktopLyricSnapshotMessage,
} from '../../shared/desktop-lyric';
import { buildPlaybackClockSnapshot } from '../../shared/playback';
import type {
  DesktopLyricCommand,
  DesktopLyricPlaybackPayload,
  DesktopLyricSettings,
  DesktopLyricSnapshot,
  LyricLinePayload,
} from '../../shared/desktop-lyric';

const DESKTOP_LYRIC_PROGRESS_SYNC_INTERVAL_MS = 80;
const DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_MS = DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_SECONDS * 1000;
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
    boolKey(settings.showUnlockButton),
    boolKey(settings.autoShow),
    boolKey(settings.alwaysOnTop),
    boolKey(settings.wantTranslation),
    boolKey(settings.wantRomanization),
    boolKey(settings.showRomanizationAsRuby),
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
    boolKey(settings.showNextLinePreview),
    settings.playedColor,
    settings.unplayedColor,
    settings.strokeColor,
    boolKey(settings.strokeEnabled),
    settings.shadowStrength,
    boolKey(settings.bold),
    settings.layout,
    boolKey(settings.filterEnabled),
    settings.filterPattern,
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
    stableNumberKey(playback?.trackSeq ?? 0),
    playback?.lyricHash ?? '',
    playback?.title ?? '',
    playback?.artist ?? '',
    playback?.album ?? '',
    playback?.coverUrl ?? '',
    stableNumberKey(playback?.duration, 1000),
    stableNumberKey(playback?.currentTime, 1000),
    boolKey(playback?.isPlaying),
    stableNumberKey(playback?.playbackRate ?? 1, 1000),
    stableNumberKey(playback?.seekTimestamp ?? 0),
    currentIndex,
    lyricTimeOffset,
    boolKey(lyricSyncWarning),
  ].join('\u001f');

type LyricSignatureLine = Pick<
  LyricLinePayload,
  'time' | 'text' | 'translated' | 'romanized' | 'characters'
>;

const buildLyricsSignature = (
  lyricsTrackId: string | null,
  lyrics: readonly LyricSignatureLine[],
) => {
  let hash = hashText(lyricsTrackId ?? '');
  let characterCount = 0;
  for (const line of lyrics) {
    hash = hashText(
      `${line.time}|${line.text}|${line.translated ?? ''}|${line.romanized ?? ''}`,
      hash,
    );
    for (const character of line.characters ?? []) {
      characterCount++;
      hash = hashText(`${character.startTime}:${character.endTime}:${character.text}`, hash);
    }
  }
  return `${lyricsTrackId ?? ''}\u001f${lyrics.length}\u001f${characterCount}\u001f${hash}`;
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
  ...(line.translatedCharacters?.length
    ? {
        translatedCharacters: line.translatedCharacters.map((char) => ({
          text: String(char.text ?? ''),
          startTime: Number(char.startTime) || 0,
          endTime: Number(char.endTime) || Number(char.startTime) || 0,
        })),
      }
    : {}),
  ...(line.romanizedCharacters?.length
    ? {
        romanizedCharacters: line.romanizedCharacters.map((char) => ({
          text: String(char.text ?? ''),
          startTime: Number(char.startTime) || 0,
          endTime: Number(char.endTime) || Number(char.startTime) || 0,
        })),
      }
    : {}),
  ...(line.rubyUnits?.length
    ? {
        rubyUnits: line.rubyUnits.map((unit) => ({
          text: String(unit.text ?? ''),
          ruby: String(unit.ruby ?? ''),
          startTime: Number(unit.startTime) || 0,
          endTime: Number(unit.endTime) || Number(unit.startTime) || 0,
          charStart: Number(unit.charStart) || 0,
          chars: (unit.chars ?? []).map((char) => ({
            text: String(char.text ?? ''),
            startTime: Number(char.startTime) || 0,
            endTime: Number(char.endTime) || Number(char.startTime) || 0,
          })),
        })),
      }
    : {}),
});

const buildPlaybackPayload = (): DesktopLyricPlaybackPayload | null => {
  const playerStore = usePlayerStore();
  const track = playerStore.currentTrackSnapshot;
  if (!track || !playerStore.currentTrackId) return null;
  const lyricHash = String(track.hash ?? track.id ?? playerStore.currentTrackId ?? '').trim();
  const trackId = String(playerStore.currentTrackId);
  const trackSeq = Number(playerStore.nativeTrackSeq || 0);
  const duration = Number(playerStore.duration || track.duration || 0);
  const currentTime = Number(playerStore.currentTime || 0);
  const isPlaying = Boolean(playerStore.isPlaying);
  const playbackRate = Number(playerStore.playbackRate || 1);
  const updatedAt = Number(playerStore.currentTimeUpdatedAt || Date.now());
  const seekTimestamp = Number(playerStore.seekTimestamp || 0);

  return {
    trackId,
    ...(trackSeq > 0 ? { trackSeq } : {}),
    lyricHash,
    title: String(track.name || '未知歌曲'),
    artist: String(
      track.artist || track.artists?.map((item: any) => item.name).join(' / ') || '未知歌手',
    ),
    album: String(track.album ?? track.albumName ?? ''),
    coverUrl: String(track.coverUrl || track.cover || ''),
    duration,
    currentTime,
    isPlaying,
    playbackRate,
    updatedAt,
    seekTimestamp,
    clock: buildPlaybackClockSnapshot({
      trackId,
      currentTime,
      duration,
      isPlaying,
      playbackRate,
      updatedAt,
      seekTimestamp,
    }),
  };
};

export const initDesktopLyricSync = async () => {
  const desktopLyricStore = useDesktopLyricStore();
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();
  const toastStore = useToastStore();
  if (!window.electron?.desktopLyric) return () => {};

  let latestDesktopLyricSnapshot: DesktopLyricSnapshot | null = await desktopLyricStore.hydrate();

  if (desktopLyricStore.settings.enabled) {
    latestDesktopLyricSnapshot = await window.electron.desktopLyric.show();
    desktopLyricStore.setLocal(latestDesktopLyricSnapshot.settings);
  }

  const stops: WatchStopHandle[] = [];
  const {
    currentTime,
    isPlaying,
    duration,
    playbackRate,
    currentTrackId,
    currentTrackSnapshot,
    nativeTrackSeq,
    seekTimestamp,
  } = storeToRefs(playerStore);
  const { lines, currentIndex, loadedHash, currentTimeOffset } = storeToRefs(lyricStore);
  const settingStore = useSettingStore();

  const buildSyncedSettings = (settings = desktopLyricStore.settings) => {
    return {
      ...settings,
      resolvedFontFamily:
        settings.fontFamily === 'follow' ? settingStore.globalFont : settings.resolvedFontFamily,
      filterEnabled: settingStore.desktopLyricFilterEnabled,
      filterPattern: settingStore.desktopLyricFilterPattern,
    };
  };

  const buildRendererOwnedSettingsPatch = () => ({
    resolvedFontFamily:
      desktopLyricStore.settings.fontFamily === 'follow'
        ? settingStore.globalFont
        : desktopLyricStore.settings.resolvedFontFamily,
    filterEnabled: settingStore.desktopLyricFilterEnabled,
    filterPattern: settingStore.desktopLyricFilterPattern,
  });

  let lastSyncedSettingsKey = buildSettingsSignature(buildSyncedSettings());
  let lastSyncedLyricsKey = latestDesktopLyricSnapshot
    ? buildLyricsSignature(
        latestDesktopLyricSnapshot.lyricsTrackId,
        latestDesktopLyricSnapshot.lyrics,
      )
    : '';
  let lastSyncedPlaybackKey = latestDesktopLyricSnapshot
    ? buildPlaybackSignature(
        latestDesktopLyricSnapshot.playback,
        latestDesktopLyricSnapshot.currentIndex,
        latestDesktopLyricSnapshot.lyricTimeOffset,
        latestDesktopLyricSnapshot.lyricSyncWarning,
      )
    : '';
  let progressSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSyncQueued = false;

  const buildLyricsPayload = () => {
    return lines.value.map(normalizeLinePayload);
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
    const sourceLines = lyricStore.loadedHash === (lyricsTrackId ?? '') ? lines.value : [];
    const nextLyricsKey = buildLyricsSignature(lyricsTrackId, sourceLines);
    if (nextLyricsKey === lastSyncedLyricsKey) return;
    const lyrics = sourceLines.length > 0 ? buildLyricsPayload() : [];

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
    const nextSettingsKey = buildSettingsSignature(nextSettings);
    if (nextSettingsKey === lastSyncedSettingsKey) return;

    window.electron.desktopLyric.syncSnapshot({
      // enabled/locked/layout 等窗口权威状态只能经 updateSettings 修改；同步通道
      // 仅提交由主渲染器持有的数据，避免陈旧全量设置回写主进程。
      settings: buildRendererOwnedSettingsPatch(),
    });
    lastSyncedSettingsKey = nextSettingsKey;
  };

  const disposeSnapshotListener = window.electron.desktopLyric.onSnapshot((message) => {
    const nextSnapshot = mergeDesktopLyricSnapshotMessage(latestDesktopLyricSnapshot, message);
    if (!nextSnapshot) return;
    latestDesktopLyricSnapshot = nextSnapshot;
    const fullSnapshot = isDesktopLyricFullSnapshot(message);
    if (fullSnapshot || message.settings !== undefined) {
      desktopLyricStore.setLocal(nextSnapshot.settings);
      lastSyncedSettingsKey = buildSettingsSignature(buildSyncedSettings(nextSnapshot.settings));
    }
    if (
      fullSnapshot ||
      message.playback !== undefined ||
      message.currentIndex !== undefined ||
      message.lyricTimeOffset !== undefined ||
      message.lyricSyncWarning !== undefined
    ) {
      lastSyncedPlaybackKey = buildPlaybackSignature(
        nextSnapshot.playback,
        nextSnapshot.currentIndex,
        nextSnapshot.lyricTimeOffset,
        nextSnapshot.lyricSyncWarning,
      );
    }
    if (
      fullSnapshot ||
      message.lyricsTrackId !== undefined ||
      message.lyricsRevision !== undefined ||
      message.lyrics !== undefined
    ) {
      lastSyncedLyricsKey = buildLyricsSignature(nextSnapshot.lyricsTrackId, nextSnapshot.lyrics);
    }
  });

  const handleDesktopLyricCommand = (command: DesktopLyricCommand) => {
    const resolveOffsetStepMs = () => {
      const step = Number(desktopLyricStore.settings.offsetStep);
      return Number.isFinite(step) && step > 0
        ? Math.round(step * 1000)
        : DEFAULT_DESKTOP_LYRIC_OFFSET_STEP_MS;
    };
    if (command === 'toggleTranslation') {
      void desktopLyricStore.syncSettings({
        wantTranslation: !desktopLyricStore.settings.wantTranslation,
      });
      return;
    }
    if (command === 'toggleRomanization') {
      void desktopLyricStore.syncSettings({
        wantRomanization: !desktopLyricStore.settings.wantRomanization,
      });
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
        nativeTrackSeq,
        currentTimeOffset,
        seekTimestamp,
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
      [lines, loadedHash, currentTrackId, currentTrackSnapshot, nativeTrackSeq],
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
        void syncSettingsSnapshot();
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
        () => settingStore.desktopLyricFilterEnabled,
        () => settingStore.desktopLyricFilterPattern,
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
