import { app, type WebContents } from 'electron';
import { ipcRegistry } from './registry';
import { PluginTcpError, pluginTcpManager } from '../plugins/tcp';
import { normalizePluginId } from '../plugins/common';
import type { PluginTcpNativeConnectOptions } from '../../shared/plugin-tcp';

const owners = new WeakSet<WebContents>();
const trackOwner = (owner: WebContents) => {
  if (owner.isDestroyed()) throw new PluginTcpError('TCP 所属窗口已销毁');
  if (owners.has(owner)) return;
  owners.add(owner);
  const close = () => pluginTcpManager.closeAll({ ownerId: owner.id });
  owner.once('destroyed', close);
  owner.on('render-process-gone', close);
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) close();
  });
};

app.once('before-quit', () => pluginTcpManager.closeAll());

export const registerPluginTcpHandlers = (authorize: (pluginId: string) => void) => {
  const options = { isExpectedError: (error: unknown) => error instanceof PluginTcpError };
  ipcRegistry.registerHandler(
    'plugins:tcp:connect',
    (event, pluginId: string, id: string, connectOptions: PluginTcpNativeConnectOptions) => {
      const normalizedId = normalizePluginId(pluginId);
      authorize(normalizedId);
      trackOwner(event.sender);
      return pluginTcpManager.connect(event.sender.id, normalizedId, id, connectOptions);
    },
    options,
  );
  // Existing handles carry authorization. Lifecycle hooks revoke them without disk reads
  // on each audio frame, and every operation is scoped to the actual IPC sender.
  ipcRegistry.registerHandler(
    'plugins:tcp:read',
    (event, pluginId: string, id: string) =>
      pluginTcpManager.read(event.sender.id, normalizePluginId(pluginId), id),
    options,
  );
  ipcRegistry.registerHandler(
    'plugins:tcp:write',
    (event, pluginId: string, id: string, data: ArrayBuffer | Uint8Array) =>
      pluginTcpManager.write(event.sender.id, normalizePluginId(pluginId), id, data),
    options,
  );
  ipcRegistry.registerHandler(
    'plugins:tcp:end',
    (event, pluginId: string, id: string) =>
      pluginTcpManager.end(event.sender.id, normalizePluginId(pluginId), id),
    options,
  );
  ipcRegistry.registerHandler(
    'plugins:tcp:close',
    (event, pluginId: string, id: string) =>
      pluginTcpManager.close(event.sender.id, normalizePluginId(pluginId), id),
    options,
  );
};
