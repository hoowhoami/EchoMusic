import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as policy from '../src/shared/manual-update.ts';
import * as updateErrors from '../src/shared/update-error.ts';
import * as accelerator from '../src/shared/github-accelerator.ts';
import * as pinia from 'pinia';

const require = createRequire(import.meta.url);
const compile = (path, imports, processValue = process) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', code)(
    (id) => imports[id] ?? (id.startsWith('.') ? {} : require(id)),
    module,
    module.exports,
    processValue,
  );
  return module.exports;
};
const asset = (arch) => ({
  name: `EchoMusic-2.3.1-beta.27-macOS-${arch}.dmg`,
  browser_download_url: `https://github.com/hoowhoami/EchoMusic/releases/download/v2.3.1-beta.27/EchoMusic-2.3.1-beta.27-macOS-${arch}.dmg`,
});
const release = {
  tag_name: 'v2.3.1-beta.27',
  prerelease: true,
  html_url: 'https://github.com/hoowhoami/EchoMusic/releases/tag/v2.3.1-beta.27',
  body: '更新日志',
  assets: [asset('x64'), asset('arm64')],
};
const loadMain = ({ platform = 'darwin', arch = 'arm64', response = [release], error } = {}) => {
  const handlers = new Map();
  const events = [];
  const calls = [];
  const updater = {
    on() {},
    setFeedURL() {},
    checkForUpdates: async () => {
      calls.push('check');
    },
    downloadUpdate: async () => {
      calls.push('download');
    },
    quitAndInstall: () => {
      calls.push('install');
    },
  };
  const module = compile(
    '../src/main/ipc/settings.ts',
    {
      './registry': {
        ipcRegistry: {
          registerHandler: (name, fn) => handlers.set(name, fn),
          registerListener: (name, fn) => handlers.set(name, fn),
        },
      },
      electron: { app: { isPackaged: true, getVersion: () => '2.3.0' } },
      'electron-log': { info() {}, warn() {}, error() {} },
      'electron-updater': { autoUpdater: updater, CancellationToken: class {} },
      'font-list': {},
      '../../shared/manual-update': policy,
      '../../shared/update-error': updateErrors,
      '../../shared/github-accelerator': accelerator,
      '../networkPolicy': {
        networkFetch: async (url) => {
          calls.push(url);
          if (error) throw error;
          return { ok: true, json: async () => response };
        },
      },
    },
    { ...process, platform, arch, resourcesPath: '/nonexistent/echo-update-test-resources' },
  );
  module.registerSettingsHandlers({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, data) => events.push({ channel, data }),
      },
    }),
    playerRef: { current: null },
  });
  return {
    handlers,
    events,
    updater,
    calls,
    async check(payload = {}) {
      handlers.get('check-for-updates')(null, { prerelease: true, ...payload });
      await new Promise(setImmediate);
      return events.findLast((event) => event.channel === 'update-check-result')?.data;
    },
  };
};

test('DMG selection never falls back to the wrong architecture or a ZIP', () => {
  assert.equal(policy.getMacDmgAsset([asset('x64')], 'arm64'), null);
  assert.equal(policy.getMacDmgAsset([asset('universal')], 'arm64')?.name, asset('universal').name);
  assert.equal(policy.getMacDmgAsset([null, { name: 'EchoMusic-arm64.zip' }], 'arm64'), null);
  assert.equal(policy.getMacDmgAsset(undefined, 'x64'), null);
});

for (const arch of ['arm64', 'x64']) {
  test(`packaged macOS ${arch} checks beta releases and offers matching DMG without Squirrel`, async () => {
    const main = loadMain({ arch });
    const result = await main.check({ silent: true, githubProxyUrl: 'https://proxy.example' });
    assert.equal(result.status, 'available');
    assert.equal(result.manualDownload, true);
    assert.equal(result.silent, true);
    assert.equal(result.body, '更新日志');
    assert.equal(result.downloadUrl, `https://proxy.example/${asset(arch).browser_download_url}`);
    assert.equal(main.updater.autoInstallOnAppQuit, false);
    main.handlers.get('update:download')();
    assert.equal(main.handlers.get('update:install')().ok, false);
    assert.equal(
      main.calls.some((call) => ['check', 'download', 'install'].includes(call)),
      false,
    );
    assert.equal(main.handlers.get('update:get-state')().checkResult.manualDownload, true);
  });
}

test('missing DMG and network failures retain a manual release-page link', async () => {
  const missing = loadMain({ response: [{ ...release, assets: [asset('x64')] }] });
  assert.equal((await missing.check()).downloadUrl, release.html_url);
  const failed = loadMain({ error: new Error('GitHub API returned HTTP 403') });
  const result = await failed.check();
  assert.equal(result.status, 'error');
  assert.equal(result.manualDownload, true);
  assert.ok(result.releaseUrl.endsWith('/releases'));
  assert.deepEqual(failed.handlers.get('update:get-state')().checkResult, result);
});

test('manual update handles stable channel, newest version, and already-current state', async () => {
  const stable = loadMain({ response: { ...release, tag_name: 'v2.3.1', prerelease: false } });
  assert.equal((await stable.check({ prerelease: false })).latestVersion, '2.3.1');
  assert.ok(stable.calls[0].endsWith('/releases/latest'));
  const newest = loadMain({
    response: [
      release,
      { ...release, tag_name: 'v2.3.1', prerelease: false },
      { ...release, tag_name: 'v2.4.0', draft: true },
    ],
  });
  assert.equal((await newest.check()).latestVersion, '2.3.1');
  const current = loadMain({ response: [{ ...release, tag_name: 'v2.3.0' }] });
  assert.equal((await current.check()).status, 'latest');
});

test('Windows continues to use electron-updater', async () => {
  const main = loadMain({ platform: 'win32' });
  await main.check();
  main.handlers.get('update:download')();
  await new Promise(setImmediate);
  assert.equal(main.updater.autoInstallOnAppQuit, true);
  assert.deepEqual(main.calls, ['check', 'check', 'download']);
});

test('signature errors recover the dialog and manual buttons never call download/install IPC', async (t) => {
  const original = globalThis.window;
  const calls = [];
  globalThis.window = {
    electron: {
      platform: 'darwin',
      ipcRenderer: { send: (...args) => calls.push(args) },
      updater: {
        download: () => assert.fail('automatic download'),
        install: () => assert.fail('automatic install'),
      },
    },
  };
  t.after(() => {
    globalThis.window = original;
  });
  pinia.setActivePinia(pinia.createPinia());
  const { useUpdateStore } = compile('../src/renderer/stores/update.ts', {
    pinia,
    './setting': { useSettingStore: () => ({ appVersion: '2.3.0' }) },
    '../../shared/update-error': updateErrors,
  });
  const store = useUpdateStore();
  store.handleCheckResult({
    status: 'available',
    currentVersion: '2.3.0',
    latestVersion: '2.3.1-beta.27',
    releaseUrl: release.html_url,
  });
  store.applyDownloadStatus({
    status: 'error',
    error: 'Code signature at URL file:///test.app did not pass validation',
  });
  assert.equal(store.checkResult.manualDownload, true);
  assert.equal(store.checkResult.message, updateErrors.UPDATE_SIGNATURE_ERROR);
  assert.equal(store.downloadStatus, 'idle');
  store.download();
  await store.install();
  assert.deepEqual(calls, [
    ['open-external', release.html_url],
    ['open-external', release.html_url],
  ]);
  store.handleCheckResult({
    status: 'error',
    currentVersion: '2.3.0',
    message: updateErrors.UPDATE_SIGNATURE_ERROR,
  });
  assert.equal(store.checkResult.manualDownload, true);
  assert.ok(store.checkResult.releaseUrl.endsWith('/releases'));
});
