import type { ShortcutCommand } from '../shared/shortcuts';
import type { PlayMode } from '../shared/playback';

export type { PlayMode };

export type AudioQualityValue = '128' | '320' | 'flac' | 'high';

export type AudioEffectValue =
  | 'none'
  | 'piano'
  | 'vocal'
  | 'accompaniment'
  | 'subwoofer'
  | 'ancient'
  | 'surnay'
  | 'dj'
  | 'viper_tape'
  | 'viper_atmos'
  | 'viper_clear';

export type OutputDeviceOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

export type OutputDeviceDisconnectBehavior = 'pause' | 'fallback';

export type OutputDeviceStatus =
  | 'idle'
  | 'ready'
  | 'unsupported'
  | 'permission'
  | 'fallback'
  | 'error';

export type ShortcutScope = 'local' | 'global';

export interface ShortcutItem {
  command: ShortcutCommand;
  title: string;
  desc: string;
}

export interface ShortcutRecordingState {
  scope: ShortcutScope;
  command: ShortcutCommand;
}
