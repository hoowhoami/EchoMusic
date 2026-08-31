import type {
  SettingsBackupExportRequest,
  SettingsBackupExportResult,
  SettingsBackupImportRequest,
  SettingsBackupImportResult,
  SettingsBackupInspectResult,
} from '../../shared/settingsBackup';
import {
  exportSettingsBackup,
  importSettingsBackup,
  inspectSettingsBackup,
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
};
