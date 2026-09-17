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
  // 带参数的播放控制命令：让插件浮窗、独立窗口等场景能精确控制播放位置与音量。
  // seek/setVolume 的 value 为绝对目标值；adjustVolume 的 delta 为相对增量，
  // 与 MiniPlayerCommand（./miniPlayer）的 adjustVolume 语义一致——两者是独立通道，字段名保持统一。
  | { type: 'seek'; value: number }
  | { type: 'setVolume'; value: number }
  | { type: 'adjustVolume'; delta: number };

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

/** 对象命令的参数形态：value 类为绝对目标值，delta 类为相对增量 */
const VALUE_COMMAND_TYPES = new Set(['seek', 'setVolume']);
const DELTA_COMMAND_TYPES = new Set(['adjustVolume']);

/** 判断传入值是否为有效的 NowPlayingCommand（字符串或合法对象命令） */
export const isNowPlayingCommand = (value: unknown): value is NowPlayingCommand => {
  if (typeof value === 'string') return NOW_PLAYING_COMMANDS.has(value);
  if (!value || typeof value !== 'object') return false;
  const cmd = value as { type?: unknown; value?: unknown; delta?: unknown };
  if (
    typeof cmd.type === 'string' &&
    VALUE_COMMAND_TYPES.has(cmd.type) &&
    typeof cmd.value === 'number' &&
    Number.isFinite(cmd.value)
  ) {
    return true;
  }
  if (
    typeof cmd.type === 'string' &&
    DELTA_COMMAND_TYPES.has(cmd.type) &&
    typeof cmd.delta === 'number' &&
    Number.isFinite(cmd.delta)
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
