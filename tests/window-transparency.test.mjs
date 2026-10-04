import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/renderer/theme/windowTransparency.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const module = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports);
const { windowBackgroundFromTransparency: resolve, createWindowTransparencySync } = module.exports;

test('one normalized amount enables native transparency without changing the frosting preference', () => {
  for (const frosted of [false, true]) {
    for (const amount of [0, 5, 40, 100]) {
      assert.deepEqual(resolve(amount, frosted), {
        enabled: amount > 0 || frosted,
        transparency: amount,
        frosted,
        color: '',
      });
    }
    assert.equal(resolve(Infinity, frosted).enabled, frosted);
    assert.equal(resolve(-10, frosted).enabled, frosted);
    assert.equal(resolve(150, frosted).transparency, 100);
  }
});

test('frost alone activates the native material and switching it off restores opaque mode', () => {
  assert.deepEqual(resolve(0, true), {
    enabled: true,
    transparency: 0,
    frosted: true,
    color: '',
  });
  assert.equal(resolve(0, false).enabled, false);
  assert.equal(resolve(50, false).enabled, true);
});

test('slider bursts serialize IPC and keep only the latest pending transparency and frosting', async () => {
  const applied = [];
  const release = [];
  const sync = createWindowTransparencySync(
    (value) => {
      applied.push(value);
      return new Promise((resolve) => release.push(resolve));
    },
    () => {},
  );
  const first = sync.update(resolve(30, false));
  await Promise.resolve();
  sync.update(resolve(50, false));
  const last = sync.update(resolve(75, true));
  assert.deepEqual(
    applied.map((v) => v.transparency),
    [30],
  );
  release.shift()();
  await Promise.resolve();
  assert.deepEqual(applied, [resolve(30, false), resolve(75, true)]);
  release.shift()();
  await Promise.all([first, last]);
  const reset = sync.update(resolve(0, true));
  await Promise.resolve();
  assert.deepEqual(applied.at(-1), resolve(0, true));
  release.shift()();
  await reset;
});

test('failed native updates can be retried and clear the reported error', async () => {
  let failed = true;
  const reports = [];
  const sync = createWindowTransparencySync(
    async () => {
      if (failed) throw new Error('native unavailable');
    },
    (error) => reports.push(error),
  );
  await sync.update(resolve(40, false));
  assert.match(reports[0].message, /native unavailable/);
  failed = false;
  await sync.update(resolve(40, false));
  assert.equal(reports.at(-1), null);
});

test('unmount drops queued IPC work and does not publish a late result', async () => {
  const applied = [];
  const reports = [];
  let release;
  const sync = createWindowTransparencySync(
    (value) => {
      applied.push(value);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    (error) => reports.push(error),
  );
  const pending = sync.update(resolve(40, false));
  await Promise.resolve();
  sync.update(resolve(70, true));
  sync.dispose();
  release();
  await pending;
  await sync.update(resolve(0, false));
  assert.equal(applied.length, 1);
  assert.deepEqual(reports, []);
});
