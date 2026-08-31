import type {
  PluginBackupCreateRequest,
  PluginBackupCreateResult,
  PluginBackupInspectRequest,
  PluginBackupInspectResult,
  PluginBackupRestoreRequest,
  PluginBackupRestoreResult,
  SettingsBackupExportRequest,
  SettingsBackupExportResult,
  SettingsBackupImportRequest,
  SettingsBackupImportResult,
  SettingsBackupInspectResult,
} from '../../shared/settingsBackup';
import {
  createPluginBackup,
  exportSettingsBackup,
  importSettingsBackup,
  inspectPluginBackup,
  inspectSettingsBackup,
  restorePluginBackup,
} from '../settingsBackup';
import { ipcRegistry } from './registry';

export const registerSettingsBackupHandlers = () => {
  ipcRegistry.registerHandler(
    'settings-backup:export',
    (_event, request: SettingsBackupExportRequest): Promise<SettingsBackupExportResult> =>
      exportSettingsBackup(request),
  );
  ipcRegistry.registerHandler(
    'settings-backup:inspect',
    (): Promise<SettingsBackupInspectResult> => inspectSettingsBackup(),
  );
  ipcRegistry.registerHandler(
    'settings-backup:import',
    (_event, request: SettingsBackupImportRequest): Promise<SettingsBackupImportResult> =>
      importSettingsBackup(request),
  );
  ipcRegistry.registerHandler(
    'plugins:backups:create',
    (_event, request: PluginBackupCreateRequest): Promise<PluginBackupCreateResult> =>
      createPluginBackup(request),
  );
  ipcRegistry.registerHandler(
    'plugins:backups:inspect',
    (_event, request: PluginBackupInspectRequest): Promise<PluginBackupInspectResult> =>
      inspectPluginBackup(request),
  );
  ipcRegistry.registerHandler(
    'plugins:backups:restore',
    (_event, request: PluginBackupRestoreRequest): Promise<PluginBackupRestoreResult> =>
      restorePluginBackup(request),
  );
};
