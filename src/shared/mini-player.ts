export type MiniPlayerSimpleCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'toggleFavorite'
  | 'toggleLyricsMode'
  | 'toggleMute'
  | 'showMainWindow'
  | 'closeMiniPlayer';

// Mini 播放器窗口尺寸：主进程用于窗口 setBounds，渲染层用于卡片高度，保持单一来源。
// 无投影、卡片铺满窗口（仅描边），故折叠高度即控制条高度、无外边距。
export const MINI_PLAYER_DIMENSIONS = {
  width: 400,
  collapsedHeight: 64,
  expandedHeight: 360,
  shellPadding: 0,
  controlsHeight: 64,
} as const;

export type MiniPlayerCommand =
  | MiniPlayerSimpleCommand
  | { type: 'setVolume'; value: number }
  | { type: 'seek'; value: number }
  | { type: 'playQueueTrack'; trackId: string };

export interface MiniPlayerPlaybackPayload {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  isFavorite: boolean;
  lyricsLabel?: string;
  volume?: number;
  updatedAt: number;
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
  queue?: MiniPlayerQueuePayload;
}

export interface MiniPlayerSnapshotPatch {
  playback?: MiniPlayerPlaybackPayload | null;
  appearance?: MiniPlayerAppearancePayload;
  queue?: MiniPlayerQueuePayload;
}

export interface MiniPlayerAppearancePayload {
  isDark: boolean;
  accentColor: string;
  fontFamily?: string;
}
