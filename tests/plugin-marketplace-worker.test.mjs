import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const read = (file) =>
  readFileSync(new URL(`../cloudflare/plugin-marketplace-worker/${file}`, import.meta.url), 'utf8');
const worker = (
  await import(`data:text/javascript;base64,${Buffer.from(read('worker.js')).toString('base64')}`)
).default;
const plugin = { sourceId: 'github:owner/repo', pluginId: 'test', version: '1.0.0' };
function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(read('schema.sql'));
  t.after(() => db.close());
  const queries = [];
  const plans = [];
  const env = {
    PLUGIN_STATS_DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                queries.push(sql);
                plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
                return { results: db.prepare(sql).all(...args), success: true };
              },
              run() {
                queries.push(sql);
                return db.prepare(sql).run(...args);
              },
            };
          },
        };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try {
          const result = statements.map((s) => s.run());
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  const request = (path, body, headers) =>
    worker.fetch(
      new Request(`https://stats.test/v1/plugins/${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
  return { db, queries, plans, env, request };
}

test('200 identities use one indexed query and unknown plugins return zeros', async (t) => {
  const h = setup(t);
  const plugins = Array.from({ length: 200 }, (_, i) => ({ ...plugin, pluginId: `p${i}` }));
  const result = await (await h.request('stats', { plugins })).json();
  assert.equal(result.plugins.length, 200);
  assert.equal(h.queries.length, 1);
  assert.ok(result.plugins.every((row) => row.stats.installCount === 0 && row.stats.score === 0));
  const plan = h.plans[0].map((row) => row.detail).join('\n');
  assert.match(plan, /SEARCH s USING INDEX/);
  assert.match(plan, /SEARCH d USING INDEX/);
});

test('install/update/failure keep exact totals, daily counts, timestamps and score', async (t) => {
  const h = setup(t);
  for (const event of ['install', 'install', 'update', 'failure']) {
    const before = h.queries.length;
    const result = await h.request('events', { event, plugin });
    assert.equal(result.status, 200);
    assert.equal(h.queries.length - before, 3); // two atomic writes + one read
  }
  const result = await (await h.request('stats', { plugins: [plugin] })).json();
  const stats = result.plugins[0].stats;
  assert.equal(stats.installCount, 2);
  assert.equal(stats.updateCount, 1);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.score, 22);
  assert.ok(stats.lastInstalledAt && stats.lastUpdatedAt);
  const daily = h.db.prepare('SELECT * FROM plugin_daily_stats').get();
  assert.equal(daily.install_count, 2);
  assert.equal(daily.update_count, 1);
  assert.equal(daily.failure_count, 1);
  h.db.exec("UPDATE plugin_daily_stats SET day = '20000101'");
  const nextDay = await (await h.request('stats', { plugins: [plugin] })).json();
  assert.equal(nextDay.plugins[0].stats.score, 7);
});

test('normalization, duplicate IDs, multiple sources and old metadata-rich clients are compatible', async (t) => {
  const h = setup(t);
  await h.request('events', {
    event: 'install',
    plugin: { ...plugin, sourceId: 'GITHUB:OWNER/REPO', repo: 'owner/repo', checksum: 'abc' },
  });
  const other = { ...plugin, sourceId: 'github:other/repo' };
  const result = await (
    await h.request('stats', { plugins: [plugin, plugin, other, null, {}] })
  ).json();
  assert.equal(result.plugins.length, 2);
  assert.equal(result.plugins.find((p) => p.sourceId === plugin.sourceId).stats.installCount, 1);
  assert.equal(result.plugins.find((p) => p.sourceId === other.sourceId).stats.installCount, 0);
  assert.equal(h.db.prepare('SELECT checksum FROM plugin_stats').get().checksum, 'abc');
});

test('empty lists skip D1 and legacy lists over 200 retain first-200 behavior', async (t) => {
  const h = setup(t);
  assert.deepEqual((await (await h.request('stats', { plugins: [] })).json()).plugins, []);
  assert.equal(h.queries.length, 0);
  const plugins = Array.from({ length: 201 }, (_, i) => ({ ...plugin, pluginId: `p${i}` }));
  assert.equal((await (await h.request('stats', { plugins })).json()).plugins.length, 200);
});

test('malformed and oversized requests are bounded before reaching D1', async (t) => {
  const h = setup(t);
  for (const body of ['{bad', 'null', '{}'])
    assert.equal((await h.request('stats', body)).status, 400);
  assert.equal((await h.request('events', { event: 'install', plugin: {} })).status, 400);
  assert.equal((await h.request('events', { event: 'bad', plugin })).status, 400);
  assert.equal((await h.request('stats', 'x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await h.request('stats', '{}', { 'content-length': '1048577' })).status, 413);
  assert.equal(h.queries.length, 0);
});

test('async D1 errors become JSON 500 responses with CORS for reads and events', async (t) => {
  const h = setup(t);
  h.env.PLUGIN_STATS_DB.prepare = () => ({
    bind: () => ({
      all: async () => {
        throw new Error('database unavailable');
      },
    }),
  });
  h.env.PLUGIN_STATS_DB.batch = async () => {
    throw new Error('database unavailable');
  };
  for (const [path, body] of [
    ['stats', { plugins: [plugin] }],
    ['events', { event: 'install', plugin }],
  ]) {
    const response = await h.request(path, body);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await response.json()).error, 'database unavailable');
  }
});
