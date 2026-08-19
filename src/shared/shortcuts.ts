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

export interface ShortcutRegistrationRequest {
  enabled: boolean;
  shortcutMap: ShortcutMap;
  localEnabled?: boolean;
  localShortcutMap?: ShortcutMap;
}

export interface PluginGlobalShortcutRegistrationPayload {
  pluginId: string;
  registrationId: string;
  accelerator: string;
}

export type PluginGlobalShortcutFailureReason = 'invalid' | 'conflict';

export type PluginGlobalShortcutRegistrationResult =
  | {
      ok: true;
      pluginId: string;
      registrationId: string;
      accelerator: string;
    }
  | {
      ok: false;
      pluginId: string;
      registrationId: string;
      accelerator: string;
      reason: PluginGlobalShortcutFailureReason;
      message?: string;
    };

export interface PluginGlobalShortcutTriggerPayload {
  pluginId: string;
  registrationId: string;
  accelerator: string;
}
