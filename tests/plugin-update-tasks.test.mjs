import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ref, reactive, computed } from 'vue';
import { transformSync } from 'esbuild';

const compile = (path, start) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  return transformSync(source.slice(source.indexOf(start)).replaceAll('export const ', 'const '), {
    loader: 'ts',
  }).code;
};
const load = (code, names, deps) =>
  new Function(...Object.keys(deps), `${code}; return { ${names.join(',')} };`)(
    ...Object.values(deps),
  );
const panelCode = compile('../src/renderer/plugins/taskPanel.ts', 'const TASK_STATUS_LABELS');
const storeCode = compile(
  '../src/renderer/stores/pluginUpdates.ts',
  'export const isCheckingPluginUpdates',
);
const plugin = (id = 'one') => ({
  id,
  sourceId: 'official',
  version: '2.0.0',
  installedVersion: '1.0.0',
  installed: true,
  updateAvailable: true,
  compatibility: { compatible: true },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('pending tasks persist, start once and use existing completion retention', () => {
  const panel = load(
    panelCode,
    ['registerTask', 'createTaskOwner', 'invalidateTaskOwner', 'taskPanelState'],
    { ref, reactive, computed, logger: { error() {} } },
  );
  const owner = panel.createTaskOwner('test');
  const handle = panel.registerTask(owner, {
    id: 'test:one',
    name: 'one',
    status: 'pending',
    retention: 'transient',
  });
  assert.equal(panel.taskPanelState.entries['test:one'].expiresAt, undefined);
  assert.equal(handle.start(), true);
  assert.equal(handle.start(), false);
  assert.equal(handle.finish('completed'), true);
  assert.ok(panel.taskPanelState.entries['test:one'].expiresAt > Date.now());
  panel.invalidateTaskOwner(owner);
  assert.equal(handle.start(), false);
  assert.equal(handle.update({ name: 'stale' }), false);
});

test('row actions use plugin callback runtime and disabled actions cannot execute', () => {
  const calls = [];
  const panel = load(panelCode, ['registerTask', 'createTaskOwner', 'taskPanelState'], {
    ref,
    reactive,
    computed,
    logger: { error() {} },
  });
  const handle = panel.registerTask(
    panel.createTaskOwner('test'),
    {
      id: 'test:rows',
      name: 'rows',
      status: 'pending',
      retention: 'transient',
      items: [
        {
          id: 'one',
          name: 'one',
          actions: [
            { id: 'go', label: 'go', onClick: () => calls.push('clicked') },
            {
              id: 'disabled',
              label: 'disabled',
              disabled: true,
              onClick: () => assert.fail('disabled'),
            },
          ],
        },
      ],
    },
    {
      runAction: (_action, invoke) => {
        calls.push('runtime');
        invoke();
      },
    },
  );
  const actions = panel.taskPanelState.entries['test:rows'].items[0].actions;
  actions.forEach((action) => action.onClick());
  assert.deepEqual(calls, ['runtime', 'clicked']);
  handle.cancel();
  assert.equal(handle.start(), false);
  assert.equal(handle.finish('aborted'), true);
  handle.dismiss();
});

function setup(install) {
  const calls = [];
  const listeners = new Map();
  let timer;
  const navigator = { onLine: true };
  const api = load(
    storeCode,
    [
      'marketplacePlugins',
      'isCheckingPluginUpdates',
      'pluginUpdateEntries',
      'pluginUpdateJobs',
      'dismissPluginUpdates',
      'installMarketplaceUpdate',
      'updateMarketplaceBatch',
      'setupStartupPluginUpdateCheck',
      'isUpdatingAllMarketplace',
      'acceptMarketplaceCatalog',
    ],
    {
      ref,
      computed,
      navigator,
      logger: { info() {}, warn() {} },
      useSettingStore: () => ({ githubProxyUrl: 'proxy' }),
      refreshPlugins: async () => calls.push('reload'),
      reloadOtherPluginRuntimes: async () => calls.push('other'),
      getPluginInstallErrorMessage: (error) => error.message,
      window: {
        electron: {
          plugins: {
            marketplace: {
              install: (...args) => {
                calls.push(args);
                return install(...args);
              },
              list: async (options) => {
                calls.push(options);
                return { ok: true, plugins: [plugin()], sources: [] };
              },
            },
          },
        },
        setTimeout: (fn) => {
          timer = fn;
          return 1;
        },
        clearTimeout: () => {},
        addEventListener: (event, fn) => listeners.set(event, fn),
        removeEventListener: (event) => listeners.delete(event),
      },
    },
  );
  return { ...api, calls, navigator, listeners, timer: () => timer() };
}

test('duplicate update clicks share an install and preserve enable state', async () => {
  let finish;
  const t = setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  t.marketplacePlugins.value = [plugin()];
  const first = t.installMarketplaceUpdate(plugin());
  const second = t.installMarketplaceUpdate(plugin());
  assert.equal(first, second);
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][2].enableAfterInstall, false);
  finish({ ok: true, plugin: { version: '2.0.0' } });
  assert.equal(await first, true);
  assert.equal(t.marketplacePlugins.value[0].updateAvailable, false);
  assert.equal(t.pluginUpdateEntries.value[0].status, 'completed');
  t.acceptMarketplaceCatalog([plugin()], 0);
  assert.equal(t.marketplacePlugins.value[0].updateAvailable, false);
});

test('batch continues after failure, retries failed entry and ignores incompatible plugins', async () => {
  let fail = true;
  const t = setup(async (_source, id) =>
    id === 'one' && fail
      ? { ok: false, error: 'offline' }
      : { ok: true, plugin: { version: '2.0.0' } },
  );
  const incompatible = { ...plugin('three'), compatibility: { compatible: false } };
  t.marketplacePlugins.value = [plugin(), plugin('two'), incompatible];
  await t.updateMarketplaceBatch(t.marketplacePlugins.value);
  assert.equal(t.isUpdatingAllMarketplace.value, false);
  assert.equal(
    t.pluginUpdateEntries.value.find((entry) => entry.plugin.id === 'one').status,
    'error',
  );
  assert.equal(
    t.pluginUpdateEntries.value.find((entry) => entry.plugin.id === 'two').status,
    'completed',
  );
  assert.equal(t.calls.filter(Array.isArray).length, 2);
  fail = false;
  await t.updateMarketplaceBatch(
    t.pluginUpdateEntries.value
      .filter((entry) => entry.status === 'error')
      .map((entry) => entry.plugin),
  );
  assert.equal(t.calls.filter(Array.isArray).length, 3);
});

test('later suppresses this version for this session while new versions appear', () => {
  const t = setup(async () => ({}));
  t.marketplacePlugins.value = [plugin()];
  t.dismissPluginUpdates();
  assert.equal(t.pluginUpdateEntries.value.length, 0);
  t.marketplacePlugins.value = [{ ...plugin(), version: '3.0.0' }];
  assert.equal(t.pluginUpdateEntries.value.length, 1);
});

test('startup waits for online then forces exactly one successful check and disposes', async () => {
  const t = setup(async () => ({}));
  t.navigator.onLine = false;
  const dispose = t.setupStartupPluginUpdateCheck();
  t.timer();
  await tick();
  assert.equal(t.calls.length, 0);
  t.navigator.onLine = true;
  const pending = t.listeners.get('online')();
  assert.equal(t.isCheckingPluginUpdates.value, true);
  await pending;
  assert.equal(t.isCheckingPluginUpdates.value, false);
  await t.listeners.get('online')();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].refresh, true);
  assert.equal(t.calls[0].installedOnly, true);
  dispose();
  assert.equal(t.listeners.size, 0);
});

test('task bridge keeps the pending run when starting and does not resurrect dismissed results', () => {
  const panel = load(
    panelCode,
    [
      'registerTask',
      'createTaskOwner',
      'invalidateTaskOwner',
      'taskPanelState',
      'dismissTaskEntry',
      'BUILTIN_PLUGIN_ID',
    ],
    { ref, reactive, computed, logger: { error() {} } },
  );
  const bridgeCode = compile(
    '../src/renderer/tasks/taskBridge.ts',
    'export const createTaskBridge',
  );
  const { createTaskBridge } = load(bridgeCode, ['createTaskBridge'], panel);
  const bridge = createTaskBridge('echo:test-update', 'transient');
  const task = (status) => ({ name: '更新', status });
  bridge.set(task('pending'));
  const generation = panel.taskPanelState.entries['echo:test-update'].generation;
  bridge.set(task('running'));
  assert.equal(panel.taskPanelState.entries['echo:test-update'].generation, generation);
  bridge.set(task('completed'));
  panel.dismissTaskEntry('echo:test-update', generation);
  bridge.set(task('completed'));
  assert.equal(panel.taskPanelState.entries['echo:test-update'], undefined);
  bridge.set(task('pending'));
  assert.ok(panel.taskPanelState.entries['echo:test-update']);
  bridge.dispose();
});

test('catalog refresh after uninstall removes completed update feedback', async () => {
  const t = setup(async () => ({ ok: true, plugin: { version: '2.0.0' } }));
  t.marketplacePlugins.value = [plugin()];
  await t.installMarketplaceUpdate(plugin());
  t.acceptMarketplaceCatalog([{ ...plugin(), installed: false, updateAvailable: false }]);
  assert.equal(t.marketplacePlugins.value[0].installed, false);
  assert.equal(t.pluginUpdateEntries.value.length, 0);
});

test('startup checker is registered independently of plugin activation', () => {
  const app = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');
  const registration = app.indexOf('disposePluginUpdateCheck = setupStartupPluginUpdateCheck();');
  assert.ok(registration > 0);
  assert.ok(app.indexOf('void refreshPlugins();', registration) > registration);
  assert.equal(app.includes('refreshPlugins().then('), false);
});
