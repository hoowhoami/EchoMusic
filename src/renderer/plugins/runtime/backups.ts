import type {
  PluginBackupCreateResult,
  PluginBackupInspectResult,
  PluginBackupRestoreResult,
  PluginBackupScopeOptions,
} from '../../../shared/settingsBackup';
import type { EchoPluginDescriptor } from '../../../shared/plugins';

export interface PluginBackupsApi {
  /** Create an in-memory backup that can be uploaded with ctx.net.request. */
  create: (options?: PluginBackupScopeOptions) => Promise<PluginBackupCreateResult>;
  /** Validate backup bytes and return a short-lived restore token plus its summary. */
  inspect: (data: ArrayBuffer | ArrayBufferView) => Promise<PluginBackupInspectResult>;
  /** Restore a previously inspected backup after host confirmation, then restart EchoMusic. */
  restore: (
    token: string,
    options?: PluginBackupScopeOptions,
  ) => Promise<PluginBackupRestoreResult>;
}

export const createPluginBackupsApi = (descriptor: EchoPluginDescriptor): PluginBackupsApi => {
  const requireCapability = () => {
    if (descriptor.manifest.capabilities?.backups !== true) {
      throw new Error('插件未声明备份与恢复能力');
    }
  };
  const getApi = () => window.electron.plugins?.backups;

  return {
    create: (options) => {
      requireCapability();
      return (
        getApi()?.create(descriptor.id, options) ??
        Promise.resolve({ ok: false, canceled: false, error: '插件备份 API 不可用' })
      );
    },
    inspect: (data) => {
      requireCapability();
      return (
        getApi()?.inspect(descriptor.id, data) ??
        Promise.resolve({ ok: false, error: '插件备份 API 不可用' })
      );
    },
    restore: async (token, options) => {
      requireCapability();
      const result = await (getApi()?.restore(descriptor.id, token, options) ??
        Promise.resolve({ ok: false as const, canceled: false, error: '插件备份 API 不可用' }));
      if (result.ok) {
        window.setTimeout(() => {
          void window.electron.appInfo.relaunch();
        }, 450);
      }
      return result;
    },
  };
};
