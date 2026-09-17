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
  | 'seekBackward'
  // 带参数的播放控制命令：让插件浮窗、独立窗口等场景能精确控制播放位置与音量
  | { type: 'seek'; value: number }
  | { type: 'setVolume'; value: number }
  | { type: 'adjustVolume'; value: number };

/** 所有合法的字符串形式 NowPlayingCommand（来自快捷键与 nowPlaying 扩展命令） */
export const NOW_PLAYING_COMMANDS = new Set<string>([
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

const OBJECT_COMMAND_TYPES = new Set(['seek', 'setVolume', 'adjustVolume']);

/** 判断传入值是否为有效的 NowPlayingCommand（字符串或合法对象命令） */
export const isNowPlayingCommand = (value: unknown): value is NowPlayingCommand => {
  if (typeof value === 'string') return NOW_PLAYING_COMMANDS.has(value);
  if (!value || typeof value !== 'object') return false;
  const cmd = value as { type?: unknown; value?: unknown };
  if (
    typeof cmd.type === 'string' &&
    OBJECT_COMMAND_TYPES.has(cmd.type) &&
    typeof cmd.value === 'number' &&
    Number.isFinite(cmd.value)
  ) {
    return true;
  }
  return false;
};

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
