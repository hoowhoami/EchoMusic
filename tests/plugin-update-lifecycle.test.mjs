import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const source = readFileSync(
  process.env.ECHOMUSIC_PLUGIN_UPDATE_TEST_SOURCE ||
    new URL('../src/renderer/stores/pluginUpdates.ts', import.meta.url),
  'utf8',
);
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const plugin = (id = 'one', extra = {}) => ({
  id,
  sourceId: 'official',
  name: id,
  version: '2.0.0',
  installedVersion: '1.0.0',
  installed: true,
  updateAvailable: true,
  compatibility: { compatible: true },
  tags: [],
  ...extra,
});
const catalog = (plugins = [plugin()], extra = {}) => ({
  ok: true,
  plugins,
  sources: [],
  fetchedAt: 123,
  ...extra,
});
const flush = async () => {
  await vue.nextTick();
  await new Promise((resolve) => setImmediate(resolve));
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('plugin operation did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

function setup(t, { install, refresh, other, online = true } = {}) {
  const pending = [];
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.push(resolve);
    return { promise, resolve, reject };
  };
  const calls = [];
  const logs = [];
  const lists = [];
  const timers = new Map();
  const allTimers = new Map();
  const events = new Map();
  const disposers = [];
  let nextTimer = 0;
  const settings = { githubProxyUrl: 'https://proxy.example' };
  const navigator = { onLine: online };
  const window = {
    electron: {
      plugins: {
        marketplace: {
          install: (...args) => {
            calls.push(['install', ...args]);
            return install
              ? install(...args)
              : Promise.resolve({ ok: true, plugin: { version: '2.0.0' } });
          },
          list: (options) => {
            calls.push(['list', options]);
            const request = deferred();
            lists.push(request);
            return request.promise;
          },
        },
      },
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      allTimers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener(name, listener) {
      const group = events.get(name) || new Set();
      group.add(listener);
      events.set(name, group);
    },
    removeEventListener: (name, listener) => events.get(name)?.delete(listener),
  };
  const module = { exports: {} };
  const dependencies = {
    vue,
    '@/utils/logger': {
      __esModule: true,
      default: {
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
      },
    },
    './setting': { useSettingStore: () => settings },
    '@/plugins/runtime': {
      refreshPlugins: (...args) => {
        calls.push(['refresh', ...args]);
        return refresh?.(...args) ?? Promise.resolve();
      },
      reloadOtherPluginRuntimes: () => {
        calls.push(['other']);
        return other?.() ?? Promise.resolve();
      },
    },
    '@/views/plugins/pluginInstallErrors': {
      getPluginInstallErrorMessage: (error) => error.message,
    },
  };
  new Function('require', 'module', 'exports', 'window', 'navigator', code)(
    (id) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
    window,
    navigator,
  );
  const api = module.exports;
  const start = () => {
    const dispose = api.setupStartupPluginUpdateCheck();
    disposers.push(dispose);
    return dispose;
  };
  const emitOnline = () =>
    Promise.all([...(events.get('online') || [])].map((listener) => listener()));
  t.after(async () => {
    disposers.forEach((dispose) => dispose());
    pending.forEach((resolve) => resolve(catalog()));
    await flush();
  });
  return {
    ...api,
    calls,
    logs,
    lists,
    timers,
    allTimers,
    events,
    settings,
    navigator,
    window,
    deferred,
    start,
    emitOnline,
    installs: () => calls.filter(([name]) => name === 'install'),
  };
}

for (const installed of [true, false]) {
  for (const failed of ['local', 'other', 'both']) {
    test(`${installed ? 'update' : 'first install'} stays successful when ${failed} runtime refresh fails`, async (t) => {
      const f = setup(t, {
        refresh: async () => {
          if (failed !== 'other') throw new Error('local refresh failed');
        },
        other: async () => {
          if (failed !== 'local') throw new Error('other refresh failed');
        },
      });
      const target = plugin('one', { installed });
      f.marketplacePlugins.value = [target];
      assert.equal(await bounded(f.installMarketplaceUpdate(target)), true);
      assert.equal(f.getMarketplaceRevision(), 1);
      assert.equal(f.marketplacePlugins.value[0].installedVersion, '2.0.0');
      assert.equal(f.marketplacePlugins.value[0].updateAvailable, false);
      assert.equal(f.calls.filter(([name]) => name === 'other').length, 1);
      assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
      if (installed) {
        const job = Object.values(f.pluginUpdateJobs.value)[0];
        assert.equal(job.status, 'completed');
        assert.match(job.error, /运行时刷新失败/);
        assert.equal(f.pluginUpdateEntries.value[0].status, 'completed');
      }
      assert.equal(f.logs.filter(([kind]) => kind === 'warn').length, failed === 'both' ? 2 : 1);
    });
  }
}

test('queued install uses original identity, version and installed status', async (t) => {
  const f = setup(t);
  const first = f.deferred();
  f.window.electron.plugins.marketplace.install = (...args) => {
    f.calls.push(['install', ...args]);
    return args[1] === 'block'
      ? first.promise
      : Promise.resolve({ ok: true, plugin: { version: '2.0.0' } });
  };
  const blocker = f.installMarketplaceUpdate(plugin('block'));
  const target = vue.reactive(plugin());
  const operation = f.installMarketplaceUpdate(target);
  target.id = 'changed';
  target.sourceId = 'another';
  target.version = '9.0.0';
  target.name = 'changed';
  target.installed = false;
  target.compatibility.compatible = false;
  await flush();
  assert.equal(f.installs().length, 1);
  first.resolve({ ok: true, plugin: { version: '2.0.0' } });
  await bounded(Promise.all([blocker, operation]));
  assert.deepEqual(
    f.installs().map(([, source, id]) => [source, id]),
    [
      ['official', 'block'],
      ['official', 'one'],
    ],
  );
  const job = f.pluginUpdateJobs.value['official:one:2.0.0'];
  assert.equal(job.status, 'completed');
  assert.equal(job.plugin.id, 'one');
  assert.equal(job.plugin.version, '2.0.0');
  assert.equal(job.plugin.name, 'one');
  assert.equal(job.plugin.compatibility.compatible, true);
  assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
});

test('batch captures later targets before waiting for earlier installation', async (t) => {
  const f = setup(t);
  const first = f.deferred();
  f.window.electron.plugins.marketplace.install = (...args) => {
    f.calls.push(['install', ...args]);
    return args[1] === 'one'
      ? first.promise
      : Promise.resolve({ ok: true, plugin: { version: '2.0.0' } });
  };
  const second = vue.reactive(plugin('two'));
  const targets = [plugin(), second];
  const operation = f.updateMarketplaceBatch(targets);
  await flush();
  second.id = 'changed';
  second.sourceId = 'another';
  second.compatibility.compatible = false;
  targets.push(plugin('three'));
  first.resolve({ ok: true, plugin: { version: '2.0.0' } });
  await bounded(operation);
  assert.deepEqual(
    f.installs().map(([, , id]) => id),
    ['one', 'two'],
  );
  assert.equal(f.updateAllTotal.value, 2);
  assert.equal(f.updateAllProgress.value, 2);
});

for (const failure of ['response', 'reject', 'throw']) {
  test(`batch continues past a first-install ${failure} failure`, async (t) => {
    const f = setup(t, {
      install: (_source, id) => {
        if (id !== 'one') return Promise.resolve({ ok: true, plugin: { version: '2.0.0' } });
        if (failure === 'response') return Promise.resolve({ ok: false, error: 'offline' });
        if (failure === 'reject') return Promise.reject(new Error('offline'));
        throw new Error('offline');
      },
    });
    await bounded(f.updateMarketplaceBatch([plugin('one', { installed: false }), plugin('two')]));
    assert.deepEqual(
      f.installs().map(([, , id]) => id),
      ['one', 'two'],
    );
    assert.equal(f.updateAllTotal.value, 2);
    assert.equal(f.updateAllProgress.value, 2);
    assert.equal(f.isUpdatingAllMarketplace.value, false);
    assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
    assert.equal(f.getMarketplaceRevision(), 1);
  });
}

test('individual first-install failure still rejects for page feedback and can retry', async (t) => {
  let failed = true;
  const f = setup(t, {
    install: async () =>
      failed ? { ok: false, error: 'offline' } : { ok: true, plugin: { version: '2.0.0' } },
  });
  const target = plugin('one', { installed: false });
  await assert.rejects(bounded(f.installMarketplaceUpdate(target)), /offline/);
  assert.equal(f.getMarketplaceRevision(), 0);
  assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
  failed = false;
  assert.equal(await bounded(f.installMarketplaceUpdate(target)), true);
  assert.equal(f.installs().length, 2);
});

test('update failure preserves failed task and returns false until retry succeeds', async (t) => {
  let failed = true;
  const f = setup(t, {
    install: async () =>
      failed ? { ok: false, error: 'offline' } : { ok: true, plugin: { version: '2.0.0' } },
  });
  const target = plugin();
  f.marketplacePlugins.value = [target];
  assert.equal(await bounded(f.installMarketplaceUpdate(target)), false);
  assert.equal(f.pluginUpdateEntries.value[0].status, 'error');
  failed = false;
  assert.equal(await bounded(f.installMarketplaceUpdate(target)), true);
  assert.equal(f.pluginUpdateEntries.value[0].status, 'completed');
});

test('duplicate IDs across sources share one global install and one enable-state option', async (t) => {
  const f = setup(t);
  const first = f.installMarketplaceUpdate(plugin());
  assert.equal(f.installMarketplaceUpdate(plugin('one', { sourceId: 'mirror' })), first);
  await bounded(first);
  assert.equal(f.installs().length, 1);
  assert.equal(f.installs()[0][3].enableAfterInstall, false);
});

test('queued plugins install serially and an earlier rejection does not break the queue', async (t) => {
  const f = setup(t);
  const gate = f.deferred();
  f.window.electron.plugins.marketplace.install = (...args) => {
    f.calls.push(['install', ...args]);
    return args[1] === 'one'
      ? gate.promise
      : Promise.resolve({ ok: true, plugin: { version: '2.0.0' } });
  };
  const first = f.installMarketplaceUpdate(plugin('one', { installed: false }));
  const firstFailure = assert.rejects(first, /offline/);
  const second = f.installMarketplaceUpdate(plugin('two'));
  await flush();
  assert.equal(f.installs().length, 1);
  assert.equal(f.busyMarketplacePluginKeys.value.size, 2);
  gate.reject(new Error('offline'));
  await bounded(Promise.all([firstFailure, second]));
  assert.equal(f.installs().length, 2);
  assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
});

test('empty or incompatible batch does not start or perform writes', async (t) => {
  const f = setup(t);
  await f.updateMarketplaceBatch([]);
  await f.updateMarketplaceBatch([plugin('one', { compatibility: { compatible: false } })]);
  assert.equal(
    await f.installMarketplaceUpdate(plugin('one', { compatibility: { compatible: false } })),
    false,
  );
  assert.equal(f.installs().length, 0);
  assert.equal(f.updateAllTotal.value, 0);
  assert.equal(f.isUpdatingAllMarketplace.value, false);
});

test('simultaneous batches share existing work and ignore duplicate plugin IDs', async (t) => {
  const f = setup(t);
  const gate = f.deferred();
  f.window.electron.plugins.marketplace.install = (...args) => {
    f.calls.push(['install', ...args]);
    return gate.promise;
  };
  const first = f.updateMarketplaceBatch([
    plugin(),
    plugin(),
    plugin('bad', { compatibility: { compatible: false } }),
  ]);
  await f.updateMarketplaceBatch([plugin('two')]);
  await flush();
  assert.equal(f.installs().length, 1);
  assert.equal(f.updateAllTotal.value, 1);
  gate.resolve({ ok: true, plugin: { version: '2.0.0' } });
  await bounded(first);
  assert.equal(f.updateAllProgress.value, 1);
});

test('successful update changes installation state for all sources without removing newer pending versions', async (t) => {
  const f = setup(t);
  f.marketplacePlugins.value = [
    plugin(),
    plugin('one', { sourceId: 'mirror', version: '3.0.0' }),
    plugin('two'),
  ];
  await bounded(f.installMarketplaceUpdate(plugin()));
  assert.deepEqual(
    f.marketplacePlugins.value.map((p) => [p.installedVersion, p.updateAvailable]),
    [
      ['2.0.0', false],
      ['2.0.0', true],
      ['1.0.0', true],
    ],
  );
  assert.deepEqual(
    f.pluginUpdateEntries.value.map(({ plugin: p, status }) => [p.sourceId, p.id, status]),
    [
      ['mirror', 'one', 'pending'],
      ['official', 'two', 'pending'],
      ['official', 'one', 'completed'],
    ],
  );
});

test('dismissed version stays hidden but a later version remains visible', (t) => {
  const f = setup(t);
  f.marketplacePlugins.value = [plugin()];
  f.dismissPluginUpdates();
  assert.equal(f.pluginUpdateEntries.value.length, 0);
  f.marketplacePlugins.value = [plugin('one', { version: '3.0.0' })];
  assert.equal(f.pluginUpdateEntries.value.length, 1);
});

test('running jobs survive catalog removal; completed jobs disappear after uninstall', async (t) => {
  const f = setup(t);
  const gate = f.deferred();
  f.window.electron.plugins.marketplace.install = () => gate.promise;
  const operation = f.installMarketplaceUpdate(plugin());
  f.marketplacePlugins.value = [];
  assert.equal(f.pluginUpdateEntries.value[0].status, 'running');
  gate.resolve({ ok: true, plugin: { version: '2.0.0' } });
  await bounded(operation);
  assert.equal(f.pluginUpdateEntries.value.length, 0);
});

test('catalog response captured before installation cannot resurrect an update', async (t) => {
  const f = setup(t);
  const revision = f.getMarketplaceRevision();
  f.marketplacePlugins.value = [plugin()];
  await bounded(f.installMarketplaceUpdate(plugin()));
  f.acceptMarketplaceCatalog([plugin()], revision);
  assert.equal(f.marketplacePlugins.value[0].updateAvailable, false);
  f.acceptMarketplaceCatalog([plugin('two')]);
  assert.equal(f.marketplacePlugins.value[0].id, 'two');
});

test('reinitializing startup check removes previous timer and listener', (t) => {
  const f = setup(t);
  const oldDispose = f.start();
  const oldTimer = [...f.timers.keys()][0];
  f.start();
  assert.equal(f.timers.has(oldTimer), false);
  assert.equal(f.timers.size, 1);
  assert.equal(f.events.get('online').size, 1);
  oldDispose();
  assert.equal(f.events.get('online').size, 1);
});

test('queued callback from a replaced startup check cannot start an old list request', async (t) => {
  const f = setup(t);
  f.start();
  const oldTimer = [...f.allTimers.values()][0];
  f.start();
  oldTimer();
  await flush();
  assert.equal(f.lists.length, 0);
});

for (const stale of ['success', 'failure']) {
  test(`old startup ${stale} cannot overwrite catalog, log or release new busy state`, async (t) => {
    const f = setup(t);
    const oldDispose = f.start();
    const oldTimer = [...f.allTimers.values()][0];
    oldTimer();
    await flush();
    f.start();
    const newTimer = [...f.allTimers.values()].at(-1);
    newTimer();
    await flush();
    oldDispose();
    assert.equal(f.isCheckingPluginUpdates.value, true);
    const logCount = f.logs.length;
    if (stale === 'success') f.lists[0].resolve(catalog([plugin('old')]));
    else f.lists[0].reject(new Error('old failure'));
    await flush();
    assert.equal(f.isCheckingPluginUpdates.value, true);
    assert.equal(f.logs.length, logCount);
    assert.equal(f.marketplacePlugins.value.length, 0);
    f.lists[1].resolve(catalog([plugin('new')]));
    await flush();
    assert.equal(f.isCheckingPluginUpdates.value, false);
    assert.equal(f.marketplacePlugins.value[0].id, 'new');
    await f.emitOnline();
    assert.equal(f.lists.length, 2);
  });
}

for (const result of ['failure', 'undefined', 'sourceError', 'reject']) {
  test(`startup ${result} remains retryable on next online event`, async (t) => {
    const f = setup(t);
    f.start();
    const first = f.emitOnline();
    if (result === 'reject') f.lists[0].reject(new Error('offline'));
    else if (result === 'undefined') f.lists[0].resolve(undefined);
    else
      f.lists[0].resolve(
        catalog(
          [],
          result === 'failure'
            ? { ok: false }
            : { sources: [{ enabled: true, lastError: 'offline' }] },
        ),
      );
    await bounded(first);
    assert.equal(f.isCheckingPluginUpdates.value, false);
    const retry = f.emitOnline();
    assert.equal(f.lists.length, 2);
    f.lists[1].resolve(catalog());
    await bounded(retry);
    await f.emitOnline();
    assert.equal(f.lists.length, 2);
  });
}

test('ignored startup snapshot after an install remains retryable', async (t) => {
  const f = setup(t);
  f.marketplacePlugins.value = [plugin()];
  f.start();
  const old = f.emitOnline();
  await bounded(f.installMarketplaceUpdate(plugin()));
  f.lists[0].resolve(catalog());
  await bounded(old);
  assert.equal(f.marketplacePlugins.value[0].updateAvailable, false);
  const retry = f.emitOnline();
  assert.equal(f.lists.length, 2);
  f.lists[1].resolve(
    catalog([plugin('one', { installedVersion: '2.0.0', updateAvailable: false })]),
  );
  await bounded(retry);
  await f.emitOnline();
  assert.equal(f.lists.length, 2);
});

test('offline startup waits for reconnection and in-flight events do not duplicate requests', async (t) => {
  const f = setup(t, { online: false });
  f.start();
  assert.equal([...f.timers.values()][0].delay, 5000);
  [...f.timers.values()][0].callback();
  await f.emitOnline();
  assert.equal(f.lists.length, 0);
  f.navigator.onLine = true;
  const check = f.emitOnline();
  await f.emitOnline();
  assert.equal(f.lists.length, 1);
  assert.equal(f.calls[0][1].installedOnly, true);
  assert.equal(f.calls[0][1].refresh, true);
  assert.equal(f.calls[0][1].githubProxyUrl, f.settings.githubProxyUrl);
  f.lists[0].resolve(catalog());
  await bounded(check);
});

for (const late of ['success', 'reject']) {
  test(`disposing startup check prevents late ${late} and clears owned resources`, async (t) => {
    const f = setup(t);
    const dispose = f.start();
    const check = f.emitOnline();
    dispose();
    dispose();
    const logCount = f.logs.length;
    if (late === 'success') f.lists[0].resolve(catalog());
    else f.lists[0].reject(new Error('offline'));
    await bounded(check);
    assert.equal(f.logs.length, logCount);
    assert.equal(f.marketplacePlugins.value.length, 0);
    assert.equal(f.isCheckingPluginUpdates.value, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.events.get('online').size, 0);
    [...f.allTimers.values()][0]();
    assert.equal(f.lists.length, 1);
  });
}

test('disabled source failure does not force repeated startup checks', async (t) => {
  const f = setup(t);
  f.start();
  const check = f.emitOnline();
  f.lists[0].resolve(catalog([], { sources: [{ enabled: false, lastError: 'offline' }] }));
  await bounded(check);
  await f.emitOnline();
  assert.equal(f.lists.length, 1);
});

const bridgeCode = transformSync(
  readFileSync(new URL('../src/renderer/tasks/pluginUpdateTaskBridge.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const mountTaskBridge = (t, f) => {
  const registrations = [];
  const module = { exports: {} };
  const deps = {
    vue,
    '@/icons': { iconPlugin: 'plugin-icon' },
    './taskBridge': {
      createTaskBridge: () => ({
        set: (entry) => registrations.push(entry),
        dismiss() {},
        dispose() {},
      }),
    },
    '@/stores/pluginUpdates': f,
  };
  new Function('require', 'module', 'exports', bridgeCode)(
    (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
    module,
    module.exports,
  );
  const dispose = module.exports.setupPluginUpdateTaskBridge();
  t.after(dispose);
  return registrations;
};

test('task bridge shows completed installation with refresh warning and offers no reinstall', async (t) => {
  const f = setup(t, {
    refresh: async () => {
      throw new Error('offline');
    },
  });
  f.marketplacePlugins.value = [plugin()];
  const tasks = mountTaskBridge(t, f);
  assert.equal(tasks.at(-1).status, 'pending');
  const updateAction = tasks.at(-1).items[0].actions[0];
  await bounded(updateAction.onClick());
  await flush();
  const task = tasks.at(-1);
  assert.equal(task.status, 'completed');
  assert.equal(task.items[0].statusLabel, '已更新');
  assert.match(task.items[0].error, /运行时刷新失败/);
  assert.equal(task.items[0].actions.length, 0);
  assert.equal(task.actions.length, 0);
  assert.equal(f.installs().length, 1);
});

test('batch stays busy until runtime refresh finishes before advancing to next install', async (t) => {
  let gate;
  let refreshes = 0;
  const f = setup(t, {
    other: () => (++refreshes === 1 ? gate.promise : Promise.resolve()),
  });
  gate = f.deferred();
  const operation = f.updateMarketplaceBatch([plugin(), plugin('two')]);
  await flush();
  assert.equal(f.installs().length, 1);
  assert.equal(f.updateAllProgress.value, 0);
  assert.equal(f.isUpdatingAllMarketplace.value, true);
  assert.equal(f.busyMarketplacePluginKeys.value.has('official:one'), true);
  gate.resolve();
  await bounded(operation);
  assert.equal(f.installs().length, 2);
  assert.equal(f.updateAllProgress.value, 2);
  assert.equal(f.isUpdatingAllMarketplace.value, false);
  assert.equal(f.busyMarketplacePluginKeys.value.size, 0);
});
