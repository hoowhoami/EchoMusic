export type LyricCharacterPayload = {
  text: string;
  startTime: number;
  endTime: number;
};

export type LyricLinePayload = {
  time: number;
  text: string;
  translated?: string;
  romanized?: string;
  characters: LyricCharacterPayload[];
};

export type DesktopLyricPlaybackPayload = {
  trackId: string;
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
  bold: boolean;
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
  fontFamily: 'system-ui',
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
  bold: false,
};

export type DesktopLyricLockPhase = 'idle' | 'locking' | 'unlocking';

export type DesktopLyricSnapshot = {
  playback: DesktopLyricPlaybackPayload | null;
  lyrics: LyricLinePayload[];
  currentIndex: number;
  settings: DesktopLyricSettings;
  lockPhase: DesktopLyricLockPhase;
  /** 歌词同步警告（实际播放时长与歌词时长差异过大） */
  lyricSyncWarning?: boolean;
};

export type DesktopLyricSnapshotPatch = Partial<
  Pick<DesktopLyricSnapshot, 'playback' | 'lyrics' | 'currentIndex' | 'lyricSyncWarning'>
> & {
  settings?: Partial<DesktopLyricSettings>;
};
