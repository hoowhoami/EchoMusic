import type {
  PluginHostWindowTarget,
  PluginProcessLaunchOptions,
  PluginProcessLaunchResult,
  PluginProcessTerminateResult,
  PluginShowOnTopOptions,
  PluginWindowBounds,
  PluginWindowShowOptions,
} from '../../../shared/plugins';
import { serializeForIpc } from './ipc';

export const createPluginWindowsApi = (pluginId: string) => {
  const getWindowsApi = () => window.electron.plugins?.windows;
  const unavailable = () => Promise.reject(new Error('插件窗口 API 不可用'));
  return {
    show: (windowId: string, options?: PluginWindowShowOptions) =>
      getWindowsApi()?.show(pluginId, windowId, options) ?? unavailable(),
    hide: (windowId: string) => getWindowsApi()?.hide(pluginId, windowId) ?? unavailable(),
    close: (windowId: string) => getWindowsApi()?.close(pluginId, windowId) ?? unavailable(),
    move: (windowId: string, bounds: Partial<PluginWindowBounds>) =>
      getWindowsApi()?.move(pluginId, windowId, bounds) ?? unavailable(),
    getBounds: (windowId: string) =>
      getWindowsApi()?.getBounds(pluginId, windowId) ?? unavailable(),
    setIgnoreMouseEvents: (windowId: string, ignore: boolean) =>
      getWindowsApi()?.setIgnoreMouseEvents(pluginId, windowId, ignore) ?? unavailable(),
    showOnTop: (windowId: string, options?: PluginShowOnTopOptions) =>
      getWindowsApi()?.showOnTop(pluginId, windowId, options) ?? unavailable(),
  };
};

export const createPluginHostApi = () => {
  const getHostApi = () => window.electron.plugins?.host;
  const unavailable = () => Promise.reject(new Error('插件宿主窗口 API 不可用'));
  return {
    showOnTop: (target?: PluginHostWindowTarget, options?: PluginShowOnTopOptions) =>
      getHostApi()?.showOnTop(target, options) ?? unavailable(),
  };
};

export const createPluginFsApi = (pluginId: string) => {
  const getFsApi = () => window.electron.plugins?.fs;
  const unavailable = (message = '插件文件 API 不可用') =>
    Promise.resolve({ ok: false as const, error: message });
  return {
    listFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listFiles']>[2],
    ) =>
      getFsApi()?.listFiles(pluginId, directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    listImageFiles: (
      directoryPath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['listImageFiles']>[1],
    ) =>
      getFsApi()?.listImageFiles(directoryPath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    getFileUrl: (filePath: string) => getFsApi()?.getFileUrl(filePath) ?? unavailable(),
    readTextFile: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readTextFile']>[2],
    ) =>
      getFsApi()?.readTextFile(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    readFileBytes: (
      filePath: string,
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['readFileBytes']>[2],
    ) =>
      getFsApi()?.readFileBytes(pluginId, filePath, serializeForIpc(options) as typeof options) ??
      unavailable(),
    readAudioMetadata: (filePath: string) =>
      getFsApi()?.readAudioMetadata(pluginId, filePath) ?? unavailable(),
    writeFile: (
      filePath: string,
      data: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[2],
      options?: Parameters<NonNullable<Window['electron']['plugins']>['fs']['writeFile']>[3],
    ) => {
      const payload =
        data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : serializeForIpc(data);
      return (
        getFsApi()?.writeFile(
          pluginId,
          filePath,
          payload as typeof data,
          serializeForIpc(options) as typeof options,
        ) ?? unavailable()
      );
    },
    deleteFile: (filePath: string) => getFsApi()?.deleteFile(pluginId, filePath) ?? unavailable(),
  };
};

export const createPluginProcessApi = (pluginId: string) => {
  const getProcessApi = () => window.electron.plugins?.process;
  return {
    launch: (options: PluginProcessLaunchOptions): Promise<PluginProcessLaunchResult> =>
      getProcessApi()?.launch(pluginId, serializeForIpc(options) as PluginProcessLaunchOptions) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
    terminate: (pid: number): Promise<PluginProcessTerminateResult> =>
      getProcessApi()?.terminate(pluginId, pid) ??
      Promise.resolve({ ok: false as const, error: '插件进程 API 不可用' }),
  };
};
