import { ipcRenderer } from 'electron';
import type {
  PluginResourcesNativeApi,
  PluginResourceResult,
  ResourceMethod,
  PluginFileGrantGroup,
  PluginGrantManagementAction,
} from '../shared/pluginFiles';
import type { DownloadSnapshot } from '../shared/pluginDownloads';
const contexts = new Map<string, Promise<PluginResourceResult<boolean>>>();
export const pluginResourcesNative: PluginResourcesNativeApi = {
  call: async <T>(pluginId: string, method: ResourceMethod, input: unknown, contextId: string) => {
    const ready = contexts.get(contextId);
    if (!ready)
      return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已销毁' } };
    try {
      const result = await ready;
      if (!result.ok) return result;
    } catch {
      return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '插件上下文已失效' } };
    }
    return ipcRenderer.invoke(
      'plugins:resources:call',
      pluginId,
      method,
      input,
      contextId,
    ) as Promise<PluginResourceResult<T>>;
  },
  onDownload: (pluginId, callback, subscriptionId) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { pluginId: string; snapshot: DownloadSnapshot },
    ) => {
      if (payload.pluginId === pluginId) callback(payload.snapshot);
    };
    ipcRenderer.on('plugins:resources:download', listener);
    const ready = ipcRenderer.invoke('plugins:resources:subscribe', pluginId, subscriptionId);
    contexts.set(subscriptionId, ready);
    void ready.catch(() => {});
    return () => {
      contexts.delete(subscriptionId);
      ipcRenderer.removeListener('plugins:resources:download', listener);
      void ready
        .then(() => ipcRenderer.invoke('plugins:resources:unsubscribe', subscriptionId))
        .catch(() => {});
    };
  },
};
export const managePluginGrants = (
  pluginId?: string,
  grantId?: string,
  action?: PluginGrantManagementAction,
) =>
  ipcRenderer.invoke('plugins:resources:grants', pluginId, grantId, action) as Promise<
    PluginResourceResult<PluginFileGrantGroup[]>
  >;
