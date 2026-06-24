import type { LyricLinePayload } from './lyrics';

export type { LyricCharacterPayload, LyricLinePayload } from './lyrics';

export type DesktopLyricPlaybackPayload = {
  trackId: string;
  lyricHash: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  updatedAt: number;
};

export type DesktopLyricThemeMode = 'light' | 'dark' | 'system';
export type DesktopLyricAlign = 'left' | 'center' | 'right' | 'both';
export type DesktopLyricShadowStrength = 'none' | 'soft' | 'normal' | 'strong';

export type DesktopLyricSettings = {
  enabled: boolean;
  locked: boolean;
  autoShow: boolean;
  alwaysOnTop: boolean;
  wantTranslation: boolean;
  wantRomanization: boolean;
  theme: DesktopLyricThemeMode;
  opacity: number;
  scale: number;
  fontFamily: string;
  resolvedFontFamily?: string;
  inactiveFontSize: number;
  activeFontSize: number;
  secondaryFontSize: number;
  lineGap: number;
  alignment: DesktopLyricAlign;
  doubleLine: boolean;
  playedColor: string;
  unplayedColor: string;
  strokeColor: string;
  strokeEnabled: boolean;
  shadowStrength: DesktopLyricShadowStrength;
  bold: boolean;
  /** 歌词对齐微调步长（秒） */
  offsetStep: number;
};

export const DEFAULT_DESKTOP_LYRIC_SETTINGS: DesktopLyricSettings = {
  enabled: false,
  locked: false,
  autoShow: true,
  alwaysOnTop: true,
  wantTranslation: false,
  wantRomanization: false,
  theme: 'system',
  opacity: 0.92,
  scale: 1,
  fontFamily: 'follow',
  inactiveFontSize: 26,
  activeFontSize: 40,
  secondaryFontSize: 18,
  lineGap: 14,
  alignment: 'both',
  doubleLine: true,
  playedColor: '#31cfa1',
  unplayedColor: '#7a7a7a',
  strokeColor: '#f1b8b3',
  strokeEnabled: false,
  shadowStrength: 'normal',
  bold: false,
  offsetStep: 0.1,
};

export type DesktopLyricLockPhase = 'idle' | 'locking' | 'unlocking';

export type DesktopLyricSnapshot = {
  playback: DesktopLyricPlaybackPayload | null;
  lyricsTrackId: string | null;
  lyricsRevision: number;
  lyrics: LyricLinePayload[];
  currentIndex: number;
  lyricTimeOffset: number;
  settings: DesktopLyricSettings;
  lockPhase: DesktopLyricLockPhase;
  /** 歌词同步警告（实际播放时长与歌词时长差异过大） */
  lyricSyncWarning?: boolean;
};

export type DesktopLyricSnapshotPatch = Partial<
  Pick<
    DesktopLyricSnapshot,
    | 'playback'
    | 'lyricsTrackId'
    | 'lyricsRevision'
    | 'lyrics'
    | 'currentIndex'
    | 'lyricTimeOffset'
    | 'lockPhase'
    | 'lyricSyncWarning'
  >
> & {
  settings?: Partial<DesktopLyricSettings>;
};

export type DesktopLyricSnapshotMessage = DesktopLyricSnapshot | DesktopLyricSnapshotPatch;

export const isDesktopLyricFullSnapshot = (
  value: DesktopLyricSnapshotMessage,
): value is DesktopLyricSnapshot =>
  Boolean(
    value &&
    typeof value === 'object' &&
    'playback' in value &&
    'lyricsTrackId' in value &&
    'lyricsRevision' in value &&
    'lyrics' in value &&
    'currentIndex' in value &&
    'lyricTimeOffset' in value &&
    'settings' in value &&
    'lockPhase' in value,
  );

export const mergeDesktopLyricSnapshotMessage = (
  current: DesktopLyricSnapshot | null | undefined,
  message: DesktopLyricSnapshotMessage,
): DesktopLyricSnapshot | null => {
  if (isDesktopLyricFullSnapshot(message)) return message;
  if (!current) return null;

  return {
    ...current,
    ...(message.playback !== undefined ? { playback: message.playback } : {}),
    ...(message.lyricsTrackId !== undefined ? { lyricsTrackId: message.lyricsTrackId } : {}),
    ...(message.lyricsRevision !== undefined ? { lyricsRevision: message.lyricsRevision } : {}),
    ...(message.lyrics !== undefined ? { lyrics: message.lyrics } : {}),
    ...(message.currentIndex !== undefined ? { currentIndex: message.currentIndex } : {}),
    ...(message.lyricTimeOffset !== undefined
      ? { lyricTimeOffset: Number(message.lyricTimeOffset) || 0 }
      : {}),
    ...(message.lockPhase !== undefined ? { lockPhase: message.lockPhase } : {}),
    ...(message.lyricSyncWarning !== undefined
      ? { lyricSyncWarning: message.lyricSyncWarning }
      : {}),
    ...(message.settings ? { settings: { ...current.settings, ...message.settings } } : {}),
  };
};

export type DesktopLyricCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'toggleLyricsMode'
  | 'cycleLyricsMode'
  | 'openLyricSource'
  | 'toggleTranslation'
  | 'toggleRomanization'
  | 'lyricOffsetBackward'
  | 'lyricOffsetForward'
  | 'lyricOffsetReset';
