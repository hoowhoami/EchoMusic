import { app, dialog, session, type Session } from 'electron';
import { ipcRegistry } from './registry';
import type { IpcContext } from './types';
import type { ResourceMethod } from '../../shared/pluginFiles';
import { PluginResources, setPluginResources } from '../plugins/resources';
import { getPluginDescriptor, isPluginAccessCurrent, onPluginAccessRevoked } from '../plugins';
import { resourceError, ResourceError } from '../downloads/files';
import { getManagedNetworkSession } from '../networkPolicy';
import type { EchoPluginDescriptor } from '../../shared/plugins';

export function registerPluginResourceHandlers(context: IpcContext) {
  const service = new PluginResources({
    root: app.getPath('userData'),
    find: getPluginDescriptor,
    current: isPluginAccessCurrent,
    fetch: async (url, init) =>
      (await getManagedNetworkSession('echo-plugin-downloads')).fetch(url, init),
    selectDirectory: async (plugin, request) => {
      const options: Electron.OpenDialogOptions = {
        title: `${plugin.name} · ${request.access === 'read' ? '读取目录' : '读写目录'} · ${request.purpose}`,
        properties: ['openDirectory', 'createDirectory'],
      };
      const win = context.getMainWindow();
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
    selectFiles: async (plugin, request) => {
      const options: Electron.OpenDialogOptions = {
        title: `${plugin.name} · 读取文件 · ${request.purpose}`,
        properties: ['openFile', ...(request.multiple ? ['multiSelections' as const] : [])],
        filters: request.filters,
      };
      const win = context.getMainWindow();
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
  });
  setPluginResources(service);
  onPluginAccessRevoked((ids) => service.revoke(ids));
  const sessions = new WeakSet<Session>();
  const register = (s: Session) => {
    if (sessions.has(s)) return;
    sessions.add(s);
    s.protocol.handle('echo-plugin-media', (request) => service.mediaResponse(request));
  };
  app.on('session-created', register);
  void app.whenReady().then(() => register(session.defaultSession));
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void service.downloads
      .shutdown()
      .catch(() => {})
      .finally(() => app.quit());
  });
  const subscriptions = new Map<
    number,
    Map<
      string,
      {
        pluginId: string;
        owner: string;
        plugin: EchoPluginDescriptor;
        sender: Electron.WebContents;
      }
    >
  >();
  service.downloads.subscribe((owner, snapshot) => {
    for (const entries of subscriptions.values()) {
      const matched = [...entries.values()].find((s) => s.owner === owner);
      if (matched && !matched.sender.isDestroyed())
        matched.sender.send('plugins:resources:download', { pluginId: matched.pluginId, snapshot });
    }
  });
  ipcRegistry.registerHandler(
    'plugins:resources:subscribe',
    async (event, pluginId: string, subscriptionId: string) => {
      try {
        const { owner, plugin } = await service.capture(pluginId);
        if (event.sender.isDestroyed()) throw new ResourceError('PLUGIN_UNAVAILABLE', '窗口已关闭');
        let entries = subscriptions.get(event.sender.id);
        if (!entries) {
          entries = new Map();
          subscriptions.set(event.sender.id, entries);
          event.sender.once('destroyed', () => {
            for (const key of entries!.keys()) service.releaseContext(`${event.sender.id}:${key}`);
            subscriptions.delete(event.sender.id);
          });
        }
        if (entries.size >= 100) throw new Error('订阅数量过多');
        if (entries.has(subscriptionId))
          throw new ResourceError('INVALID_ARGUMENT', '上下文已登记');
        entries.set(subscriptionId, { pluginId, owner, plugin, sender: event.sender });
        return { ok: true, value: true };
      } catch (error) {
        return { ok: false, error: resourceError(error) };
      }
    },
  );
  ipcRegistry.registerHandler('plugins:resources:unsubscribe', (event, subscriptionId: string) => {
    service.releaseContext(`${event.sender.id}:${subscriptionId}`);
    return subscriptions.get(event.sender.id)?.delete(subscriptionId);
  });
  ipcRegistry.registerHandler(
    'plugins:resources:call',
    async (event, pluginId: string, method: ResourceMethod, input: unknown, contextId: string) => {
      try {
        const context = subscriptions.get(event.sender.id)?.get(contextId);
        if (!context || context.pluginId !== pluginId || !isPluginAccessCurrent(context.plugin))
          throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
        const key = `${event.sender.id}:${contextId}`;
        const value = await service.call(pluginId, method, input, context.plugin, key);
        if (
          subscriptions.get(event.sender.id)?.get(contextId) !== context ||
          !isPluginAccessCurrent(context.plugin)
        ) {
          service.releaseContext(key);
          throw new ResourceError('PLUGIN_UNAVAILABLE', '插件运行上下文已失效');
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: resourceError(error) };
      }
    },
  );
  ipcRegistry.registerHandler(
    'plugins:resources:grants',
    async (_event, pluginId?: string, grantId?: string, action?: string) => {
      if (pluginId !== undefined && !getPluginDescriptor(pluginId))
        return { ok: false, error: { code: 'PLUGIN_UNAVAILABLE', message: '插件不存在' } };
      try {
        if (action !== undefined && !['revoke', 'remove', 'reauthorize'].includes(action))
          throw new ResourceError('INVALID_ARGUMENT', '授权管理操作无效');
        if (grantId) {
          if (!pluginId) throw new ResourceError('INVALID_ARGUMENT', '请指定授权所属插件');
          if (action === 'remove') await service.manageRemove(pluginId, grantId);
          else if (action === 'reauthorize') await service.manageReauthorize(pluginId, grantId);
          else await service.manageRevoke(pluginId, grantId);
        } else if (action !== undefined)
          throw new ResourceError('INVALID_ARGUMENT', '请指定授权记录');
        return { ok: true, value: await service.manageAllGrants() };
      } catch (error) {
        return { ok: false, error: resourceError(error) };
      }
    },
  );
}
