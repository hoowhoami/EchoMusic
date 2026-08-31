export const SETTINGS_BACKUP_FORMAT = 'echomusic-settings-backup' as const;
export const SETTINGS_BACKUP_VERSION = 1 as const;
export const SETTINGS_BACKUP_EXTENSION = 'echomusic-backup';

export interface SettingsBackupScope {
  settings: boolean;
  plugins: boolean;
}

export interface SettingsBackupExportRequest extends SettingsBackupScope {
  settingsData?: Record<string, unknown>;
}

export interface SettingsBackupSummary {
  createdAt: string;
  appVersion: string;
  includes: SettingsBackupScope;
  settingCount: number;
  pluginCount: number;
  pluginNames: string[];
}

export type SettingsBackupExportResult =
  | {
      ok: true;
      canceled: false;
      filePath: string;
      summary: SettingsBackupSummary;
    }
  | { ok: false; canceled: boolean; error?: string };

export type SettingsBackupInspectResult =
  | {
      ok: true;
      canceled: false;
      token: string;
      summary: SettingsBackupSummary;
    }
  | { ok: false; canceled: boolean; error?: string };

export interface SettingsBackupImportRequest extends SettingsBackupScope {
  token: string;
}

export type SettingsBackupImportResult =
  | {
      ok: true;
      settingsImported: boolean;
      pluginsImported: number;
      summary: SettingsBackupSummary;
    }
  | {
      ok: false;
      error: string;
      settingsImported?: boolean;
      pluginsImported?: number;
    };

/**
 * These fields are runtime-only, tied to local hardware/files, or should be
 * confirmed independently on every installation. They are intentionally not
 * portable even though some of them live in the persisted settings store.
 */
export const NON_PORTABLE_APP_SETTING_KEYS = new Set([
  'appVersion',
  'isPrerelease',
  'appIsPackaged',
  'outputDevice',
  'outputDevices',
  'outputDeviceType',
  'exclusiveAudioDevice',
  'outputDeviceStatus',
  'outputDeviceStatusMessage',
  'inputDevice',
  'dspProviderId',
  'dspProviderPath',
  'dspProviderPresetJson',
  'dspProviderPresetBank',
  'impulseResponseEnabled',
  'selectedImpulseResponseId',
  'impulseResponseFiles',
  'impulseResponseMixById',
  'searchHistory',
  'userAgreementAccepted',
  'logDiagnosticUntil',
]);

const cloneJsonObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
      ? (cloned as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const sanitizePortableAppSettings = (value: unknown): Record<string, unknown> => {
  const source = cloneJsonObject(value);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        key.length > 0 &&
        key.length <= 100 &&
        !isBlockedObjectKey(key) &&
        !NON_PORTABLE_APP_SETTING_KEYS.has(key),
    ),
  );
};
import { isBlockedObjectKey } from './objectSafety';
