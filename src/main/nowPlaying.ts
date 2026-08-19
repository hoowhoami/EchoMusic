import { ipcRegistry } from './ipc/registry';
import { BrowserWindow } from 'electron';
import type {
  NowPlayingCommand,
  NowPlayingLyricPayload,
  NowPlayingPlaybackPayload,
  NowPlayingSnapshot,
  NowPlayingSnapshotPatch,
} from '../shared/now-playing';
import { DEFAULT_NOW_PLAYING_APPEARANCE, DEFAULT_NOW_PLAYING_LYRIC } from '../shared/now-playing';
import type { LyricLinePayload } from '../shared/lyrics';
import type { IpcContext } from './ipc/types';
import { getMainWindow } from './window';
import { isCoverPreviewEnabled, setCoverPreviewEnabled } from './taskbarThumbnail';
import { setTaskbarProgressEnabled } from './taskbarProgress';
import { setMainAppSetting } from './storage/settings';

const NOW_PLAYING_COMMANDS = new Set<NowPlayingCommand>([
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
  'toggleTranslation',
  'toggleRomanization',
  'lyricOffsetBackward',
  'lyricOffsetForward',
  'lyricOffsetReset',
]);

let snapshot: NowPlayingSnapshot = {
  playback: null,
  lyric: { ...DEFAULT_NOW_PLAYING_LYRIC },
  appearance: { ...DEFAULT_NOW_PLAYING_APPEARANCE },
  updatedAt: Date.now(),
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toFiniteNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const toOptionalString = (value: unknown) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const sanitizeLyricLine = (line: unknown): LyricLinePayload | null => {
  if (!isPlainRecord(line)) return null;
  const text = String(line.text ?? '');
  const characters = Array.isArray(line.characters)
    ? line.characters
        .map((char) => {
          if (!isPlainRecord(char)) return null;
          return {
            text: String(char.text ?? ''),
            startTime: toFiniteNumber(char.startTime),
            endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
          };
        })
        .filter((char): char is LyricLinePayload['characters'][number] => Boolean(char))
    : [{ text, startTime: Math.round(toFiniteNumber(line.time) * 1000), endTime: 0 }];
  const rubyUnits = Array.isArray(line.rubyUnits)
    ? line.rubyUnits
        .map((unit) => {
          if (!isPlainRecord(unit)) return null;
          const chars = Array.isArray(unit.chars)
            ? unit.chars
                .map((char) => {
                  if (!isPlainRecord(char)) return null;
                  return {
                    text: String(char.text ?? ''),
                    startTime: toFiniteNumber(char.startTime),
                    endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
                  };
                })
                .filter(
                  (
                    char,
                  ): char is NonNullable<LyricLinePayload['rubyUnits']>[number]['chars'][number] =>
                    Boolean(char),
                )
            : [];
          return {
            text: String(unit.text ?? ''),
            ruby: String(unit.ruby ?? ''),
            startTime: toFiniteNumber(unit.startTime),
            endTime: toFiniteNumber(unit.endTime, toFiniteNumber(unit.startTime)),
            charStart: Math.round(toFiniteNumber(unit.charStart)),
            chars,
          };
        })
        .filter((unit): unit is NonNullable<LyricLinePayload['rubyUnits']>[number] => Boolean(unit))
    : undefined;
  const translatedCharacters = Array.isArray(line.translatedCharacters)
    ? line.translatedCharacters
        .map((char) => {
          if (!isPlainRecord(char)) return null;
          return {
            text: String(char.text ?? ''),
            startTime: toFiniteNumber(char.startTime),
            endTime: toFiniteNumber(char.endTime, toFiniteNumber(char.startTime)),
          };
        })
        .filter((char): char is NonNullable<LyricLinePayload['translatedCharacters']>[number] =>
          Boolean(char),
        )
    : undefined;
  return {
    time: toFiniteNumber(line.time),
    text,
    translated: toOptionalString(line.translated),
    romanized: toOptionalString(line.romanized),
    characters,
    ...(translatedCharacters?.length ? { translatedCharacters } : {}),
    ...(rubyUnits?.length ? { rubyUnits } : {}),
  };
};

const sanitizePlayback = (payload: unknown): NowPlayingPlaybackPayload | null => {
  if (payload === null) return null;
  if (!isPlainRecord(payload)) return snapshot.playback;
  const trackId = String(payload.trackId ?? '').trim();
  if (!trackId) return null;
  return {
    trackId,
    lyricHash: String(payload.lyricHash || trackId),
    title: String(payload.title || '未知歌曲'),
    artist: String(payload.artist || '未知歌手'),
    album: toOptionalString(payload.album),
    coverUrl: toOptionalString(payload.coverUrl),
    duration: Math.max(0, toFiniteNumber(payload.duration)),
    currentTime: Math.max(0, toFiniteNumber(payload.currentTime)),
    isPlaying: Boolean(payload.isPlaying),
    isFavorite: Boolean(payload.isFavorite),
    isPersonalFM: Boolean(payload.isPersonalFM),
    playbackRate: Math.max(0.1, toFiniteNumber(payload.playbackRate, 1)),
    updatedAt: toFiniteNumber(payload.updatedAt, Date.now()),
  };
};

const sanitizeLyric = (
  payload: Partial<NowPlayingLyricPayload> | undefined,
): NowPlayingLyricPayload => {
  if (!isPlainRecord(payload)) return snapshot.lyric;
  const lines =
    payload.lines === undefined
      ? snapshot.lyric.lines
      : Array.isArray(payload.lines)
        ? payload.lines
            .map(sanitizeLyricLine)
            .filter((line): line is LyricLinePayload => Boolean(line))
        : [];
  const mode = ['translation', 'romanization', 'both', 'none'].includes(String(payload.mode))
    ? (String(payload.mode) as NowPlayingLyricPayload['mode'])
    : snapshot.lyric.mode;

  return {
    trackId:
      payload.trackId === undefined
        ? snapshot.lyric.trackId
        : String(payload.trackId || '').trim() || null,
    revision: Math.max(0, Math.round(toFiniteNumber(payload.revision, snapshot.lyric.revision))),
    lines,
    currentIndex: Math.round(toFiniteNumber(payload.currentIndex, snapshot.lyric.currentIndex)),
    timeOffset: Math.round(toFiniteNumber(payload.timeOffset, snapshot.lyric.timeOffset)),
    wantTranslation:
      payload.wantTranslation === undefined
        ? snapshot.lyric.wantTranslation
        : Boolean(payload.wantTranslation),
    wantRomanization:
      payload.wantRomanization === undefined
        ? snapshot.lyric.wantRomanization
        : Boolean(payload.wantRomanization),
    hasTranslation:
      payload.hasTranslation === undefined
        ? snapshot.lyric.hasTranslation
        : Boolean(payload.hasTranslation),
    hasRomanization:
      payload.hasRomanization === undefined
        ? snapshot.lyric.hasRomanization
        : Boolean(payload.hasRomanization),
    mode,
    isLoading:
      payload.isLoading === undefined ? snapshot.lyric.isLoading : Boolean(payload.isLoading),
    tips: payload.tips === undefined ? snapshot.lyric.tips : String(payload.tips || ''),
    syncWarning:
      payload.syncWarning === undefined ? snapshot.lyric.syncWarning : Boolean(payload.syncWarning),
  };
};

const sendSnapshot = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send('now-playing:snapshot', snapshot);
    } catch {
      // ignore windows that are closing while broadcasting
    }
  }
};

export const getNowPlayingSnapshot = () => snapshot;

const DEFAULT_WINDOW_TITLE = 'EchoMusic';

/** 根据当前播放信息更新主窗口标题（任务栏/后台任务窗口显示）：歌手-歌名，无有效信息时回退 EchoMusic */
const applyWindowTitle = (playback: NowPlayingPlaybackPayload | null | undefined) => {
  const showTitle = isCoverPreviewEnabled();
  const artist = showTitle ? String(playback?.artist ?? '').trim() : '';
  const title = showTitle ? String(playback?.title ?? '').trim() : '';
  const hasRealInfo = Boolean(
    artist &&
    title &&
    artist !== '未知歌手' &&
    title !== '未知歌曲' &&
    artist !== 'Unknown Artist' &&
    title !== 'Unknown',
  );
  const next = hasRealInfo ? `${artist} - ${title}` : DEFAULT_WINDOW_TITLE;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      // 只更新主窗口（miniPlayer / desktopLyric 等独立窗口保持自己的标题）
      if (win === getMainWindow()) {
        if (win.getTitle() !== next) win.setTitle(next);
        break;
      }
    } catch {
      // ignore windows closing while updating title
    }
  }
};

export const syncNowPlayingSnapshot = (payload: NowPlayingSnapshotPatch) => {
  if (!payload || typeof payload !== 'object') return snapshot;
  snapshot = {
    playback:
      payload.playback === undefined ? snapshot.playback : sanitizePlayback(payload.playback),
    lyric: payload.lyric === undefined ? snapshot.lyric : sanitizeLyric(payload.lyric),
    appearance:
      payload.appearance === undefined
        ? snapshot.appearance
        : {
            isDark: Boolean(payload.appearance.isDark),
            accentColor: String(
              payload.appearance.accentColor || DEFAULT_NOW_PLAYING_APPEARANCE.accentColor,
            ),
            fontFamily: toOptionalString(payload.appearance.fontFamily),
          },
    updatedAt: Date.now(),
  };
  sendSnapshot();
  applyWindowTitle(snapshot.playback);
  return snapshot;
};

export const registerNowPlayingHandlers = (context: IpcContext) => {
  ipcRegistry.registerHandler('now-playing:get-snapshot', () => getNowPlayingSnapshot());

  // 任务栏封面预览开关：关闭时标题固定为 EchoMusic，并让任务栏回退到窗口实时画面
  ipcRegistry.registerListener('update-taskbar-cover-preview', (_event, enabled: boolean) => {
    setCoverPreviewEnabled(Boolean(enabled));
    setMainAppSetting('taskbarCoverPreview', Boolean(enabled));
    applyWindowTitle(snapshot.playback);
  });

  // 任务栏播放进度条开关：关闭时立即移除，开启时按当前播放状态重放
  ipcRegistry.registerListener('update-taskbar-progress', (_event, enabled: boolean) => {
    setTaskbarProgressEnabled(Boolean(enabled));
    setMainAppSetting('taskbarProgress', Boolean(enabled));
  });

  ipcRegistry.registerListener(
    'now-playing:sync-snapshot',
    (event, payload: NowPlayingSnapshotPatch) => {
      const mainWindow = context.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event.sender.id !== mainWindow.webContents.id) return;
      syncNowPlayingSnapshot(payload);
    },
  );

  ipcRegistry.registerListener('now-playing:command', (_event, command: NowPlayingCommand) => {
    if (!NOW_PLAYING_COMMANDS.has(command)) return;
    const mainWindow = context.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('now-playing:command', command);
  });
};
