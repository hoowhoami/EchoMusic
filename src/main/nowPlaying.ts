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

const NOW_PLAYING_COMMANDS = new Set<NowPlayingCommand>([
  'togglePlayback',
  'previousTrack',
  'nextTrack',
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
  return {
    time: toFiniteNumber(line.time),
    text,
    translated: toOptionalString(line.translated),
    romanized: toOptionalString(line.romanized),
    characters: Array.isArray(line.characters)
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
      : [{ text, startTime: Math.round(toFiniteNumber(line.time) * 1000), endTime: 0 }],
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
  return snapshot;
};

export const registerNowPlayingHandlers = (context: IpcContext) => {
  ipcRegistry.registerHandler('now-playing:get-snapshot', () => getNowPlayingSnapshot());

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
