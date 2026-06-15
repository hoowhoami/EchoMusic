export type ShortcutCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'seekForward'
  | 'seekBackward'
  | 'toggleMainLyric'
  | 'toggleDesktopLyric'
  | 'toggleLyricsMode'
  | 'cycleLyricsMode'
  | 'openLyricSource'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMute'
  | 'toggleFavorite'
  | 'togglePlayMode'
  | 'toggleMiniPlayer'
  | 'toggleWindow'
  | 'toggleSidebar';

export type ShortcutMap = Record<ShortcutCommand, string>;

export interface ShortcutRegistrationFailure {
  command: ShortcutCommand;
  accelerator: string;
  reason: 'invalid' | 'conflict';
}

export interface ShortcutRegistrationResult {
  registered: ShortcutMap;
  failures: ShortcutRegistrationFailure[];
}
