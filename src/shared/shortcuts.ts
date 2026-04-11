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
