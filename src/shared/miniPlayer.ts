import type { LyricLinePayload } from './lyrics';
import type { LyricTextConversionMode } from './opencc';
import type { PlaybackClockSnapshot, PlaybackProgressBusyReason } from './playback';

export type MiniPlayerExpandDirection = 'down' | 'up';

export type MiniPlayerSimpleCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'toggleFavorite'
  | 'toggleTranslation'
  | 'toggleRomanization'
  | 'toggleRomanizationAsRuby'
  | 'toggleDesktopLyric'
  | 'toggleMute'
  | 'showMainWindow'
  | 'closeMiniPlayer';

// Mini 播放器窗口尺寸：主进程用于窗口 setBounds，渲染层用于卡片高度，保持单一来源。
// 内容铺满窗口，无外边距；macOS 使用系统圆角，其他平台保留客户端边界。
export const MINI_PLAYER_DIMENSIONS = {
  width: 360,
  collapsedHeight: 64,
  expandedHeight: 360,
  shellPadding: 0,
  controlsHeight: 64,
} as const;

export type MiniPlayerCommand =
  | MiniPlayerSimpleCommand
  | { type: 'setVolume'; value: number; requestId?: string }
  | { type: 'adjustVolume'; delta: number }
  | { type: 'seek'; value: number }
  | { type: 'playQueueTrack'; trackId: string };

export interface MiniPlayerPlaybackPayload {
  trackId: string;
  trackSeq?: number;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  duration: number;
  currentTime: number;
  playbackRate?: number;
  isPlaying: boolean;
  isProgressBusy?: boolean;
  progressBusyReason?: PlaybackProgressBusyReason;
  isFavorite: boolean;
  lyricsLabel?: string;
  volume?: number;
  volumeRequestId?: string;
  lastNonZeroVolume?: number;
  updatedAt: number;
  seekTimestamp?: number;
  clock?: PlaybackClockSnapshot;
}

export interface MiniPlayerQueueTrack {
  trackId: string;
  title: string;
  artist: string;
  coverUrl?: string;
}

export interface MiniPlayerQueuePayload {
  queueId: string | null;
  title: string;
  currentTrackId: string | null;
  tracks: MiniPlayerQueueTrack[];
}

export interface MiniPlayerSnapshot {
  playback: MiniPlayerPlaybackPayload | null;
  appearance?: MiniPlayerAppearancePayload;
  window?: MiniPlayerWindowPayload;
  queue?: MiniPlayerQueuePayload;
  lyric?: MiniPlayerLyricPayload;
}

export interface MiniPlayerSnapshotPatch {
  playback?: MiniPlayerPlaybackPayload | null;
  appearance?: MiniPlayerAppearancePayload;
  queue?: MiniPlayerQueuePayload;
  lyric?: Partial<MiniPlayerLyricPayload>;
}

export interface MiniPlayerAppearancePayload {
  floatingSurfaceFrosted?: boolean;
  colors?: Record<string, string>;
  isDark: boolean;
  accentColor: string;
  /** 只作用于 Mini 歌词，不改变控件主题。 */
  lyricPlayedColor?: string;
  lyricUnplayedColor?: string;
  lyricStyle?: MiniPlayerLyricStyle;
  fontFamily?: string;
}

export type MiniPlayerLyricStyle = {
  fontSize: number;
  secondaryFontSize: number;
  fontWeight: number;
  alignment: 'left' | 'center' | 'right';
  lineGap: number;
  backgroundBlur: boolean;
};

export const DEFAULT_MINI_LYRIC_STYLE: MiniPlayerLyricStyle = {
  fontSize: 14,
  secondaryFontSize: 11,
  fontWeight: 780,
  alignment: 'center',
  lineGap: 2,
  backgroundBlur: true,
};

// 设置恢复、跨窗口同步和渲染使用同一约束，旧快照自动补齐默认值。
export const normalizeMiniLyricStyle = (
  value: Partial<MiniPlayerLyricStyle> = {},
): MiniPlayerLyricStyle => {
  const number = (input: unknown, fallback: number, min: number, max: number) =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.min(max, Math.max(min, Math.round(input)))
      : fallback;
  return {
    fontSize: number(value.fontSize, DEFAULT_MINI_LYRIC_STYLE.fontSize, 12, 22),
    secondaryFontSize: number(
      value.secondaryFontSize,
      DEFAULT_MINI_LYRIC_STYLE.secondaryFontSize,
      10,
      18,
    ),
    fontWeight:
      value.fontWeight === 400 || value.fontWeight === 600 || value.fontWeight === 780
        ? value.fontWeight
        : DEFAULT_MINI_LYRIC_STYLE.fontWeight,
    alignment:
      value.alignment === 'left' || value.alignment === 'right' ? value.alignment : 'center',
    lineGap: number(value.lineGap, DEFAULT_MINI_LYRIC_STYLE.lineGap, 0, 12),
    backgroundBlur: typeof value.backgroundBlur === 'boolean' ? value.backgroundBlur : true,
  };
};

export interface MiniPlayerWindowPayload {
  alwaysOnTop: boolean;
  expandDirection: MiniPlayerExpandDirection;
}

export interface MiniPlayerLyricPayload {
  trackId: string | null;
  lines: LyricLinePayload[];
  currentIndex: number;
  timeOffset?: number;
  wantTranslation: boolean;
  wantRomanization: boolean;
  /** 音译是否使用"逐字标注在原词上方"的注音模式渲染 */
  showRomanizationAsRuby: boolean;
  textConversionMode: LyricTextConversionMode;
  hasTranslation: boolean;
  hasRomanization: boolean;
  desktopLyricEnabled: boolean;
  isLoading?: boolean;
  tips?: string;
}
