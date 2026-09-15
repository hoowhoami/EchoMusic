import type { LyricLinePayload } from './lyrics';
import type { PlaybackClockSnapshot } from './playback';
import type { ShortcutCommand } from './shortcuts';

export type NowPlayingLyricsMode = 'none' | 'translation' | 'romanization' | 'both';

export type NowPlayingCommand =
  | ShortcutCommand
  | 'toggleTranslation'
  | 'toggleRomanization'
  | 'lyricOffsetBackward'
  | 'lyricOffsetForward'
  | 'lyricOffsetReset'
  | 'seekForward'
  | 'seekBackward';

export interface NowPlayingPlaybackPayload {
  trackId: string;
  lyricHash: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  isFavorite: boolean;
  isPersonalFM: boolean;
  playbackRate: number;
  updatedAt: number;
  seekTimestamp?: number;
  clock?: PlaybackClockSnapshot;
}

export interface NowPlayingLyricPayload {
  trackId: string | null;
  revision: number;
  lines: LyricLinePayload[];
  currentIndex: number;
  timeOffset: number;
  wantTranslation: boolean;
  wantRomanization: boolean;
  hasTranslation: boolean;
  hasRomanization: boolean;
  mode: NowPlayingLyricsMode;
  isLoading?: boolean;
  tips?: string;
  syncWarning?: boolean;
}

export interface NowPlayingAppearancePayload {
  isDark: boolean;
  accentColor: string;
  fontFamily?: string;
}

export interface NowPlayingSnapshot {
  playback: NowPlayingPlaybackPayload | null;
  lyric: NowPlayingLyricPayload;
  appearance: NowPlayingAppearancePayload;
  updatedAt: number;
}

export type NowPlayingSnapshotPatch = Partial<
  Pick<NowPlayingSnapshot, 'playback' | 'appearance'>
> & {
  lyric?: Partial<NowPlayingLyricPayload>;
};

export const DEFAULT_NOW_PLAYING_LYRIC: NowPlayingLyricPayload = {
  trackId: null,
  revision: 0,
  lines: [],
  currentIndex: -1,
  timeOffset: 0,
  wantTranslation: false,
  wantRomanization: false,
  hasTranslation: false,
  hasRomanization: false,
  mode: 'none',
  tips: '暂无歌词',
};

export const DEFAULT_NOW_PLAYING_APPEARANCE: NowPlayingAppearancePayload = {
  isDark: false,
  accentColor: '#31cfa1',
};
