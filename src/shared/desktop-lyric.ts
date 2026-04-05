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
export type DesktopLyricSecondaryMode = 'none' | 'translation' | 'romanization';
export type DesktopLyricAlign = 'left' | 'center' | 'right';

export type DesktopLyricSettings = {
  enabled: boolean;
  locked: boolean;
  clickThrough: boolean;
  autoShow: boolean;
  alwaysOnTop: boolean;
  secondaryEnabled: boolean;
  theme: DesktopLyricThemeMode;
  opacity: number;
  scale: number;
  fontFamily: string;
  inactiveFontSize: number;
  activeFontSize: number;
  secondaryFontSize: number;
  lineGap: number;
  width: number;
  height: number;
  secondaryMode: DesktopLyricSecondaryMode;
  alignment: DesktopLyricAlign;
  fontSize: number;
  doubleLine: boolean;
  playedColor: string;
  unplayedColor: string;
  strokeColor: string;
  strokeEnabled: boolean;
  bold: boolean;
};


export type DesktopLyricLockPhase = 'idle' | 'locking' | 'unlocking';

export type DesktopLyricPointerState = {
  insideWindow: boolean;
  insideUnlockHotzone: boolean;
  insideToolbarHotzone: boolean;
};

export type DesktopLyricSnapshot = {
  playback: DesktopLyricPlaybackPayload | null;
  lyrics: LyricLinePayload[];
  currentIndex: number;
  settings: DesktopLyricSettings;
  lockPhase: DesktopLyricLockPhase;
};

export type DesktopLyricSnapshotPatch = Partial<
  Pick<DesktopLyricSnapshot, 'playback' | 'lyrics' | 'currentIndex'>
> & {
  settings?: Partial<DesktopLyricSettings>;
};
