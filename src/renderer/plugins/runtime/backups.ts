import { readonly, shallowRef } from 'vue';
import type {
  PluginBackupCreateResult,
  PluginBackupInspectResult,
  PluginBackupProvider,
  PluginBackupProviderEntry,
  PluginBackupProviderLoadRequest,
  PluginBackupProviderListRequest,
  PluginBackupProviderRemoveRequest,
  PluginBackupProviderSaveRequest,
  PluginBackupRestoreResult,
  PluginBackupScopeOptions,
} from '../../../shared/settingsBackup';
import type { EchoPluginDescriptor } from '../../../shared/plugins';

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_PROVIDER_ENTRIES = 500;

export interface PluginBackupProviderOperations {
  create: (
    options?: PluginBackupScopeOptions,
    settingsData?: Record<string, unknown>,
  ) => Promise<PluginBackupCreateResult>;
  inspect: (data: ArrayBuffer | ArrayBufferView) => Promise<PluginBackupInspectResult>;
  restore: (
    token: string,
    options?: PluginBackupScopeOptions,
  ) => Promise<PluginBackupRestoreResult>;
}

export interface RegisteredPluginBackupProvider {
  key: string;
  id: string;
  name: string;
  description: string;
  pluginId: string;
  pluginName: string;
  create: PluginBackupProviderOperations['create'];
  inspect: PluginBackupProviderOperations['inspect'];
  restore: PluginBackupProviderOperations['restore'];
  save: (request: PluginBackupProviderSaveRequest) => Promise<void>;
  list: (request: PluginBackupProviderListRequest) => Promise<PluginBackupProviderEntry[]>;
  load: (request: PluginBackupProviderLoadRequest) => Promise<ArrayBuffer | ArrayBufferView>;
  remove?: (request: PluginBackupProviderRemoveRequest) => Promise<void>;
}

type PluginRuntimeErrorReporter = (
  pluginId: string,
  error: unknown,
  source?: string,
  fallback?: string,
) => unknown;

const providerState = shallowRef<RegisteredPluginBackupProvider[]>([]);

export const pluginBackupProviders = readonly(providerState);

const normalizeEntries = (value: unknown): PluginBackupProviderEntry[] => {
  if (!Array.isArray(value)) throw new Error('备份存储提供方返回了无效列表');
  const entries: PluginBackupProviderEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of value.slice(0, MAX_PROVIDER_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? '').trim();
    if (!id || id.length > 512 || seenIds.has(id)) continue;
    seenIds.add(id);
    const size = Number(record.size);
    entries.push({
      id,
      name:
        String(record.name || id)
          .trim()
          .slice(0, 200) || id,
      ...(record.createdAt ? { createdAt: String(record.createdAt).slice(0, 80) } : {}),
      ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      ...(record.description
        ? { description: String(record.description).trim().slice(0, 300) }
        : {}),
    });
  }
  return entries;
};

const registerPluginBackupProvider = (
  descriptor: EchoPluginDescriptor,
  provider: PluginBackupProvider,
  operations: PluginBackupProviderOperations,
  reportPluginRuntimeError?: PluginRuntimeErrorReporter,
) => {
  const id = String(provider?.id || '').trim();
  const name = String(provider?.name || '').trim();
  if (!PROVIDER_ID_RE.test(id)) {
    throw new Error(
      '备份存储提供方 id 必须以字母或数字开头，且只能包含字母、数字、点、下划线和短横线',
    );
  }
  if (!name || name.length > 80) throw new Error('备份存储提供方名称无效');
  if (typeof provider.save !== 'function') throw new Error('备份存储提供方缺少 save()');
  if (typeof provider.list !== 'function') throw new Error('备份存储提供方缺少 list()');
  if (typeof provider.load !== 'function') throw new Error('备份存储提供方缺少 load()');

  const key = `${descriptor.id}:${id}`;
  if (providerState.value.some((item) => item.key === key)) {
    throw new Error(`备份存储提供方已注册：${id}`);
  }

  const invoke = async <T>(source: string, callback: () => T | Promise<T>): Promise<T> => {
    try {
      return await callback();
    } catch (error) {
      reportPluginRuntimeError?.(descriptor.id, error, source);
      throw error;
    }
  };

  const registered: RegisteredPluginBackupProvider = {
    key,
    id,
    name,
    description: String(provider.description || '')
      .trim()
      .slice(0, 240),
    pluginId: descriptor.id,
    pluginName: descriptor.name,
    ...operations,
    save: (request) =>
      invoke(`备份存储提供方 ${name}: 保存`, async () => void (await provider.save(request))),
    list: (request) =>
      invoke(`备份存储提供方 ${name}: 列表`, async () =>
        normalizeEntries(await provider.list(request)),
      ),
    load: (request) => invoke(`备份存储提供方 ${name}: 读取`, () => provider.load(request)),
    ...(typeof provider.remove === 'function'
      ? {
          remove: (request: PluginBackupProviderRemoveRequest) =>
            invoke(
              `备份存储提供方 ${name}: 删除`,
              async () => void (await provider.remove?.(request)),
            ),
        }
      : {}),
  };

  providerState.value = [...providerState.value, registered];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    providerState.value = providerState.value.filter((item) => item !== registered);
  };
};

interface PluginBackupsApiOptions {
  addDisposable?: (dispose: () => void) => () => void;
  reportPluginRuntimeError?: (
    pluginId: string,
    error: unknown,
    source?: string,
    fallback?: string,
  ) => unknown;
  allowProviderRegistration?: boolean;
}

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
  /** Register a storage backend that is shown in EchoMusic's backup and restore UI. */
  registerProvider: (provider: PluginBackupProvider) => () => void;
}

export const createPluginBackupsApi = (
  descriptor: EchoPluginDescriptor,
  options: PluginBackupsApiOptions = {},
): PluginBackupsApi => {
  const requireCapability = () => {
    if (descriptor.manifest.capabilities?.backups !== true) {
      throw new Error('插件未声明备份与恢复能力');
    }
  };
  const getApi = () => window.electron.plugins?.backups;

  const create = (scope?: PluginBackupScopeOptions, settingsData?: Record<string, unknown>) => {
    requireCapability();
    return (
      getApi()?.create(descriptor.id, scope, settingsData) ??
      Promise.resolve({ ok: false, canceled: false, error: '插件备份 API 不可用' })
    );
  };

  const inspect = (data: ArrayBuffer | ArrayBufferView) => {
    requireCapability();
    return (
      getApi()?.inspect(descriptor.id, data) ??
      Promise.resolve({ ok: false, error: '插件备份 API 不可用' })
    );
  };

  const restore = async (token: string, scope?: PluginBackupScopeOptions) => {
    requireCapability();
    const result = await (getApi()?.restore(descriptor.id, token, scope) ??
      Promise.resolve({ ok: false as const, canceled: false, error: '插件备份 API 不可用' }));
    if (result.ok) {
      window.setTimeout(() => {
        void window.electron.appInfo.relaunch();
      }, 450);
    }
    return result;
  };

  return {
    create,
    inspect,
    restore,
    registerProvider: (provider) => {
      requireCapability();
      if (options.allowProviderRegistration === false) {
        throw new Error('备份存储提供方只能在主窗口插件运行时注册');
      }
      const dispose = registerPluginBackupProvider(
        descriptor,
        provider,
        { create, inspect, restore },
        options.reportPluginRuntimeError,
      );
      return options.addDisposable?.(dispose) ?? dispose;
    },
  };
};
