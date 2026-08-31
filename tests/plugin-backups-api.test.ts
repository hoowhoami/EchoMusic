import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';
import {
  createPluginBackupsApi,
  pluginBackupProviders,
} from '../src/renderer/plugins/runtime/backups.ts';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
});

const createDescriptor = (backups: boolean) =>
  ({
    id: 'backup-sync',
    manifest: {
      id: 'backup-sync',
      name: 'Backup Sync',
      version: '1.0.0',
      capabilities: { backups },
    },
  }) as EchoPluginDescriptor;

test('ctx.backups keeps binary data intact and scopes calls to the current plugin', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let relaunches = 0;
  const calls: unknown[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        appInfo: { relaunch: async () => void (relaunches += 1) },
        plugins: {
          backups: {
            create: async (...args: unknown[]) => {
              calls.push(args);
              return { ok: false, canceled: true };
            },
            inspect: async (...args: unknown[]) => {
              calls.push(args);
              return { ok: false, error: 'test' };
            },
            restore: async (...args: unknown[]) => {
              calls.push(args);
              return {
                ok: true,
                canceled: false,
                restartScheduled: true,
                settingsImported: true,
                pluginsImported: 0,
                summary: {
                  createdAt: '',
                  appVersion: '',
                  includes: { settings: true, plugins: false },
                  settingCount: 1,
                  pluginCount: 0,
                  pluginNames: [],
                },
              };
            },
          },
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    },
    writable: true,
  });

  const api = createPluginBackupsApi(createDescriptor(true));
  await api.create({ settings: true, plugins: false });
  await api.inspect(bytes);
  await api.restore('restore-token', { settings: true, plugins: false });

  assert.deepEqual(calls[0], ['backup-sync', { settings: true, plugins: false }, undefined]);
  assert.equal(calls[1][0], 'backup-sync');
  assert.equal(calls[1][1], bytes);
  assert.deepEqual(calls[2], ['backup-sync', 'restore-token', { settings: true, plugins: false }]);
  assert.equal(relaunches, 1);
});

test('ctx.backups rejects plugins without the backups capability', () => {
  const api = createPluginBackupsApi(createDescriptor(false));
  assert.throws(() => api.create(), /未声明备份与恢复能力/);
});

test('ctx.backups providers register with plugin identity and dispose with the runtime', async () => {
  const disposables: Array<() => void> = [];
  const loaded = new Uint8Array([9, 8, 7]);
  const api = createPluginBackupsApi(createDescriptor(true), {
    addDisposable: (dispose) => {
      disposables.push(dispose);
      return dispose;
    },
  });

  const dispose = api.registerProvider({
    id: 'webdav',
    name: 'WebDAV',
    description: '远端备份',
    save: async () => {},
    list: async () => [
      { id: 'latest', name: '最新备份', size: 42 },
      { id: 'latest', name: '重复项' },
      { id: '', name: '无效项' },
    ],
    load: async () => loaded,
  });

  try {
    assert.equal(disposables.length, 1);
    assert.equal(pluginBackupProviders.value.length, 1);
    const provider = pluginBackupProviders.value[0];
    assert.equal(provider.key, 'backup-sync:webdav');
    assert.equal(provider.pluginId, 'backup-sync');
    assert.deepEqual(await provider.list({ signal: new AbortController().signal }), [
      { id: 'latest', name: '最新备份', size: 42 },
    ]);
    assert.equal(
      await provider.load({ id: 'latest', signal: new AbortController().signal }),
      loaded,
    );
  } finally {
    dispose();
  }

  assert.equal(pluginBackupProviders.value.length, 0);
});
