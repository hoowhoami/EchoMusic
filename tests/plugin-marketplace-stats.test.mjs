import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/main/plugins/marketplaceStats.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' },
).code;
const { createMarketplaceStatsCache, marketplaceStatsKey: key } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const endpoint = 'https://stats.test';
const a = { sourceId: 'github:owner/repo', pluginId: 'a' };
const b = { ...a, pluginId: 'b' };
const stats = (installCount = 7) => ({
  installCount,
  updateCount: 0,
  failureCount: 0,
  score: installCount * 8,
  lastInstalledAt: '',
  lastUpdatedAt: '',
});
const response = (plugins, count = 7) => new Map(plugins.map((p) => [key(p), stats(count)]));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup() {
  let time = 1_000_000;
  let disk;
  let fetch = async (_endpoint, plugins) => response(plugins);
  const calls = [];
  const errors = [];
  const create = () =>
    createMarketplaceStatsCache({
      now: () => time,
      read: () => structuredClone(disk),
      write: (snapshot) => {
        disk = structuredClone(snapshot);
      },
      onError: (error) => errors.push(error),
      fetch: (...args) => {
        calls.push(args);
        return fetch(...args);
      },
    });
  return {
    cache: create(),
    create,
    calls,
    errors,
    advance: (ms) => {
      time += ms;
    },
    fetch: (fn) => {
      fetch = fn;
    },
    disk: () => disk,
  };
}

test('statistics have independent ten-minute TTL and survive restart and cached-only reads', async () => {
  const t = setup();
  assert.equal((await t.cache.get(endpoint, [a], true)).size, 0);
  await t.cache.get(endpoint, [a]);
  t.advance(599_999);
  assert.equal((await t.create().get(endpoint, [a])).get(key(a)).installCount, 7);
  assert.equal(t.calls.length, 1);
  t.advance(1);
  await t.cache.get(endpoint, [a], true);
  assert.equal(t.calls.length, 1);
  await t.cache.get(endpoint, [a]);
  assert.equal(t.calls.length, 2);
});

test('many simultaneous readers share one request; overlapping readers fetch only missing keys', async () => {
  const t = setup();
  const wait = deferred();
  t.fetch(async (_url, plugins) => {
    await wait.promise;
    return response(plugins);
  });
  const requests = Array.from({ length: 10 }, () => t.cache.get(endpoint, [a, a]));
  const overlap = t.cache.get(endpoint, [a, b]);
  assert.equal(t.calls.length, 1);
  assert.equal((await t.cache.get(endpoint, [a], true)).size, 0);
  wait.resolve();
  await Promise.all([...requests, overlap]);
  assert.deepEqual(
    t.calls.map(([, plugins]) => plugins),
    [[a], [b]],
  );
});

test('manual refresh bypasses fresh statistics while automatic reads still reuse them', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a]);
  t.fetch(async (_url, plugins) => response(plugins, 9));
  assert.equal((await t.cache.get(endpoint, [a])).get(key(a)).installCount, 7);
  assert.equal((await t.cache.get(endpoint, [a], false, true)).get(key(a)).installCount, 9);
  assert.equal(t.calls.length, 2);
  await t.cache.get(endpoint, [a]);
  await t.cache.get(endpoint, [a], true, true);
  assert.equal(t.calls.length, 2);
});

test('manual retry bypasses backoff; failure retains old values and automatic retries stay blocked', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a]);
  t.fetch(async () => {
    throw new Error('offline');
  });
  await t.cache.get(endpoint, [a], false, true);
  const result = await t.cache.get(endpoint, [a], false, true);
  assert.equal(result.get(key(a)).installCount, 7);
  assert.equal(t.calls.length, 3);
  await t.cache.get(endpoint, [a, b]);
  assert.equal(t.calls.length, 3);
  t.fetch(async (_url, plugins) => response(plugins, 10));
  await t.cache.get(endpoint, [a], false, true);
  assert.equal(t.disk().failures, 0);
  assert.equal(t.disk().retryAt, 0);
});

test('simultaneous manual refreshes share both successful and failed attempts', async () => {
  for (const fail of [false, true]) {
    const t = setup();
    await t.cache.get(endpoint, [a]);
    const wait = deferred();
    t.fetch(async (_url, plugins) => {
      await wait.promise;
      if (fail) throw new Error('offline');
      return response(plugins, 9);
    });
    const reads = Array.from({ length: 5 }, () => t.cache.get(endpoint, [a], false, true));
    wait.resolve();
    const results = await Promise.all(reads);
    assert.equal(t.calls.length, 2);
    assert.ok(results.every((r) => r.get(key(a)).installCount === (fail ? 7 : 9)));
  }
});

test('manual refresh sharing an automatic request still fetches other requested fresh keys', async () => {
  const t = setup();
  await t.cache.get(endpoint, [b]);
  const wait = deferred();
  t.fetch(async (_url, plugins) => {
    await wait.promise;
    return response(plugins, 9);
  });
  const automatic = t.cache.get(endpoint, [a]);
  const manual = t.cache.get(endpoint, [a, b], false, true);
  wait.resolve();
  await Promise.all([automatic, manual]);
  assert.deepEqual(
    t.calls.map(([, plugins]) => plugins),
    [[b], [a], [b]],
  );
});

test('failures retain old numbers and back off 1, 2, 4, 8, 16, then 30 minutes across restarts', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a]);
  t.advance(600_000);
  t.fetch(async () => {
    throw new Error('CPU limit');
  });
  for (const minutes of [1, 2, 4, 8, 16, 30, 30]) {
    const cache = t.create();
    assert.equal((await cache.get(endpoint, [a])).get(key(a)).installCount, 7);
    const count = t.calls.length;
    t.advance(minutes * 60_000 - 1);
    await t.create().get(endpoint, [a, b]);
    assert.equal(t.calls.length, count);
    t.advance(1);
  }
  t.fetch(async (_url, plugins) => response(plugins, 9));
  assert.equal((await t.create().get(endpoint, [a])).get(key(a)).installCount, 9);
  assert.equal(t.disk().failures, 0);
});

test('malformed or incomplete result is a failure and cannot replace good cached counts', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a, b]);
  t.advance(600_000);
  t.fetch(async () => response([a], 0));
  const result = await t.cache.get(endpoint, [a, b]);
  assert.equal(result.get(key(a)).installCount, 7);
  assert.equal(result.get(key(b)).installCount, 7);
  assert.equal(t.errors.length, 1);
});

test('event updates are immediate and older pending reads cannot overwrite them', async () => {
  const t = setup();
  const wait = deferred();
  t.fetch(() => wait.promise);
  const request = t.cache.get(endpoint, [a]);
  t.cache.update(endpoint, a, stats(8));
  assert.equal((await t.cache.get(endpoint, [a], true)).get(key(a)).installCount, 8);
  wait.resolve(response([a], 7));
  assert.equal((await request).get(key(a)).installCount, 8);
  assert.equal((await t.create().get(endpoint, [a], true)).get(key(a)).installCount, 8);
});

test('more than 200 identities are fetched in bounded batches without truncation', async () => {
  const t = setup();
  const plugins = Array.from({ length: 451 }, (_, i) => ({ ...a, pluginId: `p${i}` }));
  assert.equal((await t.cache.get(endpoint, plugins)).size, 451);
  assert.deepEqual(
    t.calls.map(([, batch]) => batch.length),
    [200, 200, 51],
  );
});

test('a failed later batch preserves completed batches and retries only remaining identities', async () => {
  const t = setup();
  const plugins = Array.from({ length: 201 }, (_, i) => ({ ...a, pluginId: `p${i}` }));
  t.fetch(async (_url, batch) => {
    if (batch.length === 1) throw new Error('offline');
    return response(batch);
  });
  assert.equal((await t.cache.get(endpoint, plugins)).size, 200);
  t.advance(60_000);
  t.fetch(async (_url, batch) => response(batch));
  assert.equal((await t.cache.get(endpoint, plugins)).size, 201);
  assert.equal(t.calls.at(-1)[1].length, 1);
});

test('service changes never reuse another endpoint counts or retry deadline', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a]);
  const other = `${endpoint}/other`;
  assert.equal((await t.cache.get(other, [a], true)).size, 0);
  await t.cache.get(other, [a]);
  assert.equal(t.calls.length, 2);
});

test('future cache timestamps force refresh after clock rollback', async () => {
  const t = setup();
  await t.cache.get(endpoint, [a]);
  t.advance(-1);
  await t.cache.get(endpoint, [a]);
  assert.equal(t.calls.length, 2);
});

// Exercise the actual main-process transport wiring, not just the cache policy.
const mainSource = readFileSync(new URL('../src/main/plugins/index.ts', import.meta.url), 'utf8');
const transportCode = transformSync(
  mainSource.slice(
    mainSource.indexOf('const getEmptyMarketplaceStats ='),
    mainSource.indexOf('const fetchWithTimeout ='),
  ),
  { loader: 'ts' },
).code;
function transport() {
  const requests = [];
  let disk;
  let eventReply = () => Response.json({ ok: true, stats: stats(8) });
  const deps = {
    createMarketplaceStatsCache,
    getKvStorage: () => ({
      get: () => disk,
      set: (_key, value) => {
        disk = structuredClone(value);
      },
    }),
    log: { warn() {} },
    normalizeMarketplaceStatsApiUrl: () => endpoint,
    normalizePluginId: (id) => id,
    getMarketplaceStatsApiUrlCandidates: (path) => [`${endpoint}${path}`],
    getHttpFailureMessage: async () => 'request failed',
    PLUGIN_MARKETPLACE_FETCH_TIMEOUT_MS: 30_000,
    networkFetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({
        plugins: JSON.parse(options.body).plugins.map((p) => ({ ...p, stats: stats() })),
      });
    },
    fetchWithTimeout: async (url, options) => {
      requests.push({ url, options });
      return eventReply();
    },
  };
  const api = new Function(
    ...Object.keys(deps),
    `${transportCode}; return { read: fetchMarketplacePluginStats, report: reportMarketplacePluginInstallEvent };`,
  )(...Object.values(deps));
  return {
    ...api,
    requests,
    reply: (fn) => {
      eventReply = fn;
    },
  };
}

test('main process sends identities only and event result is reused without another read', async () => {
  const t = transport();
  const plugin = {
    id: a.pluginId,
    sourceId: a.sourceId,
    version: '1',
    checksum: 'abc',
    repo: 'owner/repo',
  };
  assert.equal((await t.read([plugin], true)).size, 0);
  await t.read([plugin]);
  assert.deepEqual(JSON.parse(t.requests[0].options.body), { plugins: [a] });
  assert.ok(t.requests[0].options.signal instanceof AbortSignal);
  await t.report(plugin, 'install');
  assert.equal(JSON.parse(t.requests[1].options.body).plugin.checksum, 'abc');
  assert.equal((await t.read([plugin], true)).get(key(a)).installCount, 8);
  assert.equal((await t.read([plugin])).get(key(a)).installCount, 8);
  assert.equal(t.requests.length, 2);
});

test('accepted event with unreadable response is never sent twice', async () => {
  const t = transport();
  t.reply(() => new Response('bad JSON', { status: 200 }));
  await t.report({ id: a.pluginId, sourceId: a.sourceId }, 'install');
  assert.equal(t.requests.length, 1);
});

test('main process forwards explicit refresh through to the statistics transport', async () => {
  const t = transport();
  const plugin = { id: a.pluginId, sourceId: a.sourceId };
  await t.read([plugin]);
  await t.read([plugin]);
  assert.equal(t.requests.length, 1);
  await t.read([plugin], false, true);
  assert.equal(t.requests.length, 2);
});

test('malformed event statistics cannot reset cached counts', async () => {
  const t = transport();
  const plugin = { id: a.pluginId, sourceId: a.sourceId };
  await t.read([plugin]);
  for (const value of [{}, [], { ...stats(), installCount: 'bad' }]) {
    t.reply(() => Response.json({ stats: value }));
    await t.report(plugin, 'install');
    assert.equal((await t.read([plugin], true)).get(key(a)).installCount, 7);
  }
  assert.equal(t.requests.length, 4);
});
