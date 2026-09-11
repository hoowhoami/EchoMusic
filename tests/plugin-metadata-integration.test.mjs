import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * from './src/main/plugins/index'; export { getKvStorage } from './src/main/storage/kv'; export { getPlaybackQueueStorage } from './src/main/storage/playbackQueues';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'host-fixture',
      setup(builder) {
        builder.onResolve({ filter: /logger$/ }, () => ({ path: 'logger', namespace: 'fixture' }));
        builder.onResolve({ filter: /storage\/native$|^\.\/native$/ }, () => ({
          path: 'native',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /networkPolicy$/ }, () => ({
          path: 'policy',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /media\/audioMetadata$/ }, () => ({
          path: 'audio',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /^\.\/(windows|network)$/ }, (args) => {
          if (args.importer.endsWith('/plugins/index.ts'))
            return { path: args.path.slice(2), namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: {
            logger: `export default { info(){}, warn(){}, error(){}, debug(){} };`,
            native: `export const getNativeStorage = () => harness.native;`,
            policy: `export const networkFetch = () => { throw new Error('Unexpected network request'); };`,
            audio: `export const readAudioMetadata = async () => ({}); export const resolveAudioTitleAndArtist = () => ({});`,
            windows: `export const closePluginWindows = async (id) => { harness.closedWindows.push(id); };`,
            network: `export const requestPluginNetwork = async () => ({ status: 200, data: {} });`,
          }[args.path],
        }));
      },
    },
  ],
});

const allCapabilities = {
  tcp: true,
  unrestrictedNetwork: true,
  sqlite: true,
  localFiles: true,
  process: true,
  webServer: true,
  backups: true,
};
const writePlugin = async (directory, version = '1.0.0', capabilities = allCapabilities) => {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ id: 'rgb', name: 'RGB', version, capabilities }),
  );
  await fs.writeFile(join(directory, 'index.js'), 'export function activate() {}');
};

async function fixture(t) {
  const userData = await fs.mkdtemp(join(tmpdir(), 'echo-metadata-test-'));
  const pluginDirectory = join(userData, 'plugins', 'rgb');
  await writePlugin(pluginDirectory);
  const store = new Map([['plugins:enabled', JSON.stringify({ rgb: true })]]);
  const harness = {
    reads: 0,
    scans: 0,
    syncReads: 0,
    closedWindows: [],
    failCopy: false,
    failScan: false,
    confirm: async () => ({ response: 1 }),
  };
  harness.native = {
    kvGet(key) {
      harness.reads++;
      return store.get(key) ?? null;
    },
    kvSet(key, value) {
      store.set(key, value);
    },
    kvDelete(key) {
      store.delete(key);
    },
    kvApplyBatch(payload) {
      for (const item of JSON.parse(payload)) {
        if (item.valueJson === null) store.delete(item.key);
        else store.set(item.key, item.valueJson);
      }
    },
    resetAll() {
      store.clear();
    },
    pluginSqliteCloseByPrefix() {},
    pluginSqliteAll() {
      return JSON.stringify({ rows: [{ n: 1 }], rowCount: 1, truncated: false });
    },
  };
  const app = Object.assign(new EventEmitter(), {
    getPath: (name) => (name === 'temp' ? tmpdir() : userData),
    getVersion: () => '2.3.2',
    isPackaged: false,
  });
  const wrappedFs = { ...syncFs };
  for (const key of ['readdirSync', 'readFileSync', 'statSync', 'existsSync']) {
    wrappedFs[key] = (...args) => {
      harness.syncReads++;
      return syncFs[key](...args);
    };
  }
  const wrappedPromises = {
    ...fs,
    async readdir(path, ...args) {
      if (path === join(userData, 'plugins')) {
        harness.scans++;
        if (harness.failScan) throw new Error('scan failed');
      }
      return fs.readdir(path, ...args);
    },
    async cp(source, target, ...args) {
      if (harness.failCopy && target === pluginDirectory) throw new Error('copy failed');
      return fs.cp(source, target, ...args);
    },
  };
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (id === 'electron')
      return {
        app,
        shell: {},
        BrowserWindow: {},
        dialog: { showMessageBox: (...args) => harness.confirm(...args) },
      };
    if (id === 'fs') return wrappedFs;
    if (id === 'fs/promises') return wrappedPromises;
    return require(id);
  };
  new Function('require', 'module', 'exports', 'harness', bundle.outputFiles[0].text)(
    mockRequire,
    module,
    module.exports,
    harness,
  );
  const api = module.exports;
  t.after(async () => {
    await api.setPluginSafeMode(true);
    await fs.rm(userData, { recursive: true, force: true });
  });
  await api.refreshPluginMetadata();
  return { api, harness, pluginDirectory, userData };
}

test('HTTP, TCP, SQLite, filesystem and window metadata checks perform no metadata I/O after initialization', async (t) => {
  const { api, harness, pluginDirectory } = await fixture(t);
  const before = { reads: harness.reads, scans: harness.scans, syncReads: harness.syncReads };
  for (let i = 0; i < 100; i++) {
    api.assertPluginTcpAccess('rgb');
    assert.equal(
      (await api.requestPluginNetworkForPlugin('rgb', { url: 'http://localhost' })).status,
      200,
    );
    assert.equal(api.allPluginSqliteForPlugin('rgb', 'rgb:main', 'select 1').ok, true);
    assert.equal((await api.readPluginTextFile('rgb', join(pluginDirectory, 'index.js'))).ok, true);
    assert.equal(api.getPluginDescriptor('rgb').enabled, true);
    assert.equal(api.getPluginDescriptor('missing'), null);
    api.getPluginWindowDescriptor('rgb', 'missing');
    api.listPlugins();
    api.getPluginSafeMode();
  }
  assert.deepEqual(
    { reads: harness.reads, scans: harness.scans, syncReads: harness.syncReads },
    before,
  );
});

test('explicit refresh applies manual capability changes, while an unchanged refresh preserves access', async (t) => {
  const { api, pluginDirectory } = await fixture(t);
  const original = api.getPluginDescriptor('rgb');
  await api.refreshPluginMetadata();
  assert.equal(api.getPluginDescriptor('rgb'), original);
  await writePlugin(pluginDirectory, '2.0.0', {});
  api.assertPluginTcpAccess('rgb'); // Disk changes take effect at the documented refresh boundary.
  await api.refreshPluginMetadata();
  assert.equal(api.getPluginDescriptor('rgb').version, '2.0.0');
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /未声明/);
  await assert.rejects(api.requestPluginNetworkForPlugin('rgb', {}), /未声明/);
  assert.equal(api.allPluginSqliteForPlugin('rgb', 'rgb:main', 'select 1').ok, false);
  assert.equal(api.isPluginAccessCurrent(original), false);
});

test('enabled preferences, raw KV mutations, batches and reset revoke immediately without scans', async (t) => {
  const { api, harness } = await fixture(t);
  const scans = harness.scans;
  const revoked = [];
  api.onPluginAccessRevoked((ids) => revoked.push(...ids));
  assert.equal((await api.setPluginEnabled('rgb', false)).ok, true);
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /未启用/);
  api.replacePluginEnabledPreference('rgb', true);
  api.assertPluginTcpAccess('rgb');
  api.getKvStorage().set('plugins:safe-mode', true);
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /安全模式/);
  api.getKvStorage().delete('plugins:safe-mode');
  api.getKvStorage().applyBatch([{ key: 'plugins:enabled', value: { rgb: false } }]);
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /未启用/);
  api.replacePluginEnabledPreference('rgb', true);
  api.getPlaybackQueueStorage().resetAll();
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /未启用/);
  assert.equal(harness.scans, scans);
  assert(revoked.length >= 4);
});

test('real local install/update and uninstall publish current metadata before returning', async (t) => {
  const { api, userData } = await fixture(t);
  const source = join(userData, 'source');
  await writePlugin(source, '2.0.0', { localFiles: true });
  const result = await api.installPluginsFromLocal([source], { enableAfterInstall: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(api.getPluginDescriptor('rgb').version, '2.0.0');
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /未声明/);
  assert.equal((await api.uninstallPlugin('rgb')).ok, true);
  assert.equal(api.getPluginDescriptor('rgb'), null);
  await api.refreshPluginMetadata();
  assert.equal(api.getPluginDescriptor('rgb'), null);
});

test('failed installation cannot reuse stale privileges; rollback reloads restored files and preferences', async (t) => {
  const { api, harness, pluginDirectory, userData } = await fixture(t);
  const source = join(userData, 'source');
  const old = api.getPluginDescriptor('rgb');
  await writePlugin(source, '2.0.0');
  harness.failCopy = true;
  const failed = await api.installPluginsFromLocal([source], { enableAfterInstall: true });
  assert.equal(failed.ok, false);
  assert.throws(() => api.assertPluginTcpAccess('rgb'), /不存在|未启用/);
  harness.failCopy = false;
  await api.withPluginMetadataMutation('rgb', async () => {
    await writePlugin(pluginDirectory);
    api.replacePluginEnabledPreference('rgb', true);
  });
  api.assertPluginTcpAccess('rgb');
  assert.equal(api.getPluginDescriptor('rgb').version, '1.0.0');
  assert.equal(api.isPluginAccessCurrent(old), false);
});

test(
  'permission revoked while the process consent dialog is open prevents a late launch',
  { skip: process.platform === 'win32' ? 'POSIX helper fixture' : false },
  async (t) => {
    const { api, harness, pluginDirectory } = await fixture(t);
    const helper = join(pluginDirectory, 'helper.sh');
    await fs.writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let confirm;
    let opened;
    const waiting = new Promise((resolve) => {
      opened = resolve;
    });
    harness.confirm = () => {
      opened();
      return new Promise((resolve) => {
        confirm = resolve;
      });
    };
    const launch = api.launchPluginProcess('rgb', { executable: 'helper.sh' });
    await waiting;
    await api.setPluginEnabled('rgb', false);
    confirm({ response: 0 });
    const result = await launch;
    assert.equal(result.ok, false);
    assert.match(result.error, /权限已失效/);
  },
);
