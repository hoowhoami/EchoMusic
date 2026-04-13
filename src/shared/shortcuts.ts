export type ShortcutCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'toggleMainLyric'
  | 'toggleDesktopLyric'
  | 'toggleLyricsMode'
  | 'cycleLyricsMode'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMute'
  | 'toggleFavorite'
  | 'togglePlayMode'
  | 'toggleWindow';

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
