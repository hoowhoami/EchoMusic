import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (source) =>
  transformSync(source.replaceAll('export const ', 'const '), { loader: 'ts' }).code;
const policy = compile(read('../src/main/plugins/marketplaceCache.ts'));
const shouldRefreshMarketplace = new Function(`${policy}; return shouldRefreshMarketplace;`)();
const source = read('../src/main/plugins/index.ts');
const slice = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return compile(source.slice(from, to));
};
const listCode = slice('const marketplaceRefreshes =', 'const downloadMarketplacePackage =');
const fallbackCode = slice('const fetchMarketplaceSourceCatalog =', 'const getComparableVersion =');
const textCode = slice('const fetchMarketplaceText =', 'const fetchMarketplaceIndex =');
const create = (code, name, deps) =>
  new Function(...Object.keys(deps), `${code}; return ${name};`)(...Object.values(deps));
const now = Date.now();
const sources = [{ id: 'official', enabled: true, lastFetchedAt: now, lastError: '' }];

test('catalog expires after five minutes; failures retry after one minute', () => {
  assert.equal(shouldRefreshMarketplace(now, sources, false, now + 299_999), false);
  assert.equal(shouldRefreshMarketplace(now, sources, false, now + 300_000), true);
  const failed = [{ ...sources[0], lastError: 'offline' }];
  assert.equal(shouldRefreshMarketplace(now, failed, false, now + 59_999), false);
  assert.equal(shouldRefreshMarketplace(now, failed, false, now + 60_000), true);
  assert.equal(shouldRefreshMarketplace(now, sources, true, now), true);
  assert.equal(shouldRefreshMarketplace(0, sources, false, now), true);
  assert.equal(shouldRefreshMarketplace(now + 100, sources, false, now), true);
  assert.equal(shouldRefreshMarketplace(0, [], true, now), false);
});

function setup(fetchedAt = now) {
  let cache = { fetchedAt, plugins: [{ id: 'old' }] };
  const calls = [];
  let finish;
  const list = create(listCode, 'listPluginMarketplace', {
    getSavedMarketplaceSources: () => sources,
    getMarketplaceCache: () => cache,
    shouldRefreshMarketplace,
    hydrateMarketplacePlugins: async (plugins) => plugins,
    refreshMarketplaceCatalog: (...args) => {
      calls.push(args);
      return new Promise((resolve) => {
        finish = () => {
          cache = { fetchedAt: Date.now(), plugins: [{ id: 'new' }] };
          resolve({ sources, cache });
        };
      });
    },
  });
  return { list, calls, finish: () => finish() };
}

test('cached-only reads return stale content without waiting for network', async () => {
  const t = setup(1);
  assert.equal((await t.list({ cachedOnly: true })).plugins[0].id, 'old');
  assert.equal(t.calls.length, 0);
});

test('fresh catalog is reused; explicit refresh bypasses it', async () => {
  const t = setup();
  await t.list();
  assert.equal(t.calls.length, 0);
  const pending = t.list({ refresh: true });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][3], true);
  t.finish();
  assert.equal((await pending).plugins[0].id, 'new');
});

test('expired catalog auto-refreshes and simultaneous calls share the request', async () => {
  const t = setup(1);
  const first = t.list();
  const second = t.list();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][3], true);
  t.finish();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.plugins[0].id === 'new'));
  await t.list();
  assert.equal(t.calls.length, 1);
});

test('source fetch failure preserves previous plugins and successful timestamp', async () => {
  const fetchCatalog = create(fallbackCode, 'fetchMarketplaceSourceCatalog', {
    fetchMarketplaceIndex: async () => {
      throw new Error('offline');
    },
  });
  const previous = [
    { id: 'old', sourceId: 'official' },
    { id: 'other', sourceId: 'other' },
  ];
  const result = await fetchCatalog(sources[0], undefined, previous, true);
  assert.equal(result.source.lastFetchedAt, now);
  assert.equal(result.source.lastError, 'offline');
  assert.deepEqual(
    result.plugins.map((plugin) => plugin.id),
    ['old'],
  );
});

test('index and manifest requests bypass caches on accelerator and direct fallback', async () => {
  const requests = [];
  const fetchText = create(textCode, 'fetchMarketplaceText', {
    appendUrlCacheKey: (url, key) => `${url}?v=${key}`,
    applyGithubProxyUrl: (url) => `https://proxy.test/${url}`,
    fetchWithTimeout: async (url, options) => {
      requests.push({ url, options });
      if (url.startsWith('https://proxy.test/')) throw new Error('proxy down');
      return { ok: true, text: async () => '{}' };
    },
    PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS: 100,
    runGithubAcceleratorFallback: async ({ accelerated, github }) => {
      try {
        return await accelerated();
      } catch {
        return github();
      }
    },
    log: { warn() {} },
  });
  for (const file of ['echo-plugins.json', 'manifest.json']) {
    await fetchText(`https://raw.githubusercontent.com/test/main/${file}`, 'proxy', true);
  }
  assert.equal(requests.length, 4);
  assert.ok(
    requests.every(
      ({ url, options }) =>
        url.includes('?v=cb-') && options.headers['Cache-Control'] === 'no-cache',
    ),
  );
});

const rendererSource = read('../src/renderer/views/plugins/usePluginMarketplace.ts');
const rendererCode = compile(
  rendererSource.slice(rendererSource.indexOf('export const getMarketplacePluginKey')),
);
function setupView() {
  const calls = [];
  const events = new Map();
  const mounts = [];
  const unmounts = [];
  const watchers = [];
  const pending = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, handler) => events.set(name, handler),
    removeEventListener: (name) => events.delete(name),
  };
  const window = {
    ...document,
    electron: {
      plugins: {
        marketplace: {
          list: (options) => {
            calls.push(options);
            if (options.cachedOnly)
              return Promise.resolve({ plugins: [{ id: 'old' }], sources: [], fetchedAt: 1 });
            return new Promise((resolve) => pending.push(resolve));
          },
        },
      },
    },
  };
  const route = { name: 'plugin-management', query: {}, fullPath: '/plugins' };
  const activeView = { value: 'marketplace' };
  const catalog = { value: [] };
  const use = create(rendererCode, 'usePluginMarketplace', {
    getMarketplaceRevision: () => 0,
    marketplacePlugins: catalog,
    acceptMarketplaceCatalog: (plugins) => {
      catalog.value = plugins;
    },
    busyMarketplacePluginKeys: { value: new Set() },
    isUpdatingAllMarketplace: { value: false },
    updateAllProgress: { value: 0 },
    updateAllTotal: { value: 0 },
    ref: (value) => ({ value }),
    computed: (get) => ({
      get value() {
        return get();
      },
    }),
    onMounted: (fn) => mounts.push(fn),
    onUnmounted: (fn) => unmounts.push(fn),
    watch: (_get, fn) => watchers.push(fn),
    useToastStore: () => ({
      warning() {
        assert.fail('automatic checks should be quiet');
      },
      actionCompleted() {},
    }),
    useSettingStore: () => ({}),
    window,
    document,
    navigator: { onLine: true },
    setInterval: (fn) => {
      events.set('interval', fn);
      return 1;
    },
    clearInterval: () => events.delete('interval'),
  });
  const view = use({ route, activeView });
  return { view, calls, events, mounts, unmounts, pending, route, document, activeView, watchers };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('page shows cached list before background response and rechecks when reopened', async () => {
  const t = setupView();
  t.view.switchView('marketplace');
  await settle();
  assert.equal(t.view.marketplacePlugins.value[0].id, 'old');
  assert.equal(t.view.isMarketplaceLoading.value, false);
  assert.deepEqual(
    t.calls.map((call) => !!call.cachedOnly),
    [true, false],
  );
  t.pending.shift()({ ok: true, plugins: [{ id: 'new' }], sources: [], fetchedAt: now });
  await settle();
  assert.equal(t.view.marketplacePlugins.value[0].id, 'new');
  t.view.switchView('marketplace');
  assert.equal(t.calls.length, 3);
  t.pending.shift()({ ok: true, plugins: [{ id: 'new' }], sources: [], fetchedAt: now });
  await settle();
});

test('automatic checks only run on visible marketplace and clean up on unmount', async () => {
  const t = setupView();
  t.mounts.forEach((fn) => fn());
  t.document.visibilityState = 'hidden';
  t.events.get('interval')();
  assert.equal(t.calls.length, 0);
  t.document.visibilityState = 'visible';
  t.route.name = 'home';
  t.events.get('focus')();
  assert.equal(t.calls.length, 0);
  t.route.name = 'plugin-management';
  t.events.get('online')();
  await settle();
  t.events.get('focus')();
  assert.equal(t.calls.length, 2); // local + one background request, focus is coalesced
  t.pending.shift()({ ok: true, plugins: [], sources: [], fetchedAt: now });
  await settle();
  t.unmounts.forEach((fn) => fn());
  assert.equal(t.events.size, 0);
});

test('startup checks only installed manifests and preserves full catalog freshness and entries', async () => {
  const cached = {
    fetchedAt: 123,
    plugins: [
      { id: 'installed', sourceId: 'official', version: '1' },
      { id: 'other', sourceId: 'official', version: '1' },
    ],
  };
  let saved;
  let skipStats;
  const list = create(listCode, 'listPluginMarketplace', {
    getSavedMarketplaceSources: () => sources,
    getMarketplaceCache: () => cached,
    setMarketplaceCache: (cache) => {
      saved = cache;
    },
    listPlugins: () => ({ plugins: [{ id: 'installed' }] }),
    fetchMarketplaceSourceCatalog: async (_source, _proxy, _previous, force, ids) => {
      assert.equal(force, true);
      assert.deepEqual([...ids], ['installed']);
      return {
        source: sources[0],
        plugins: [{ id: 'installed', sourceId: 'official', version: '2' }],
      };
    },
    hydrateMarketplacePlugins: async (plugins, _sources, _proxy, cachedOnly) => {
      skipStats = cachedOnly;
      return plugins;
    },
    log: { info() {} },
  });
  const result = await list({ installedOnly: true });
  assert.equal(skipStats, true);
  assert.equal(saved.fetchedAt, 123);
  assert.equal(result.plugins.find((p) => p.id === 'installed').version, '2');
  assert.equal(result.plugins.find((p) => p.id === 'other').version, '1');
});

test('index filtering skips uninstalled entries but resolves legacy entries without ids', async () => {
  const indexCode = slice('const fetchMarketplaceIndex =', 'const fetchMarketplaceSourceCatalog =');
  const fetchIndex = create(indexCode, 'fetchMarketplaceIndex', {
    parseGithubRepository: () => ({}),
    toRawGithubUrl: () => 'index',
    toGithubBlobUrl: () => 'index',
    PLUGIN_MARKETPLACE_INDEX_FILE: 'echo-plugins.json',
    normalizePluginId: (id) => id || '',
    fetchMarketplaceText: async () =>
      JSON.stringify({ plugins: [{ id: 'installed' }, { id: 'other' }, { path: 'legacy' }] }),
    normalizeMarketplaceIndexPlugins: async (_source, index) => {
      assert.deepEqual(index.plugins, [{ id: 'installed' }, { path: 'legacy' }]);
      return { plugins: [], failedCount: 0, recoveredCount: 0 };
    },
    log: { info() {} },
  });
  await fetchIndex(sources[0], undefined, [], true, new Set(['installed']));
});
