import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const native = require('../native/echo-opencc');

test('native batch converts all supported profiles and returns a Promise', async () => {
  for (const profile of ['s2t', 's2tw', 's2hk']) {
    const pending = native.convertBatch(['头发干燥', '后来发现理发店'], profile);
    assert.ok(pending instanceof Promise);
    assert.deepEqual(await pending, ['頭髮乾燥', '後來發現理髮店']);
  }
  assert.deepEqual(await native.convertBatch(['頭髮乾燥'], 't2s'), ['头发干燥']);
  assert.deepEqual(await native.convertBatch([], 's2t'), []);
  assert.throws(() => native.convertBatch(['头发'], 'bad'), /unsupported OpenCC profile/);
});

test('cold native initialization and conversion allow the event loop to keep ticking', () => {
  const addonPath = require.resolve('../native/echo-opencc');
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const addon = require(${JSON.stringify(addonPath)});
    (async () => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      const pending = addon.convertBatch(Array(5000).fill('头发干燥，后来发现理发店。'), 's2t');
      if (!(pending instanceof Promise)) throw new Error('not asynchronous');
      const result = await pending;
      clearInterval(timer);
      if (!ticks || result.length !== 5000) throw new Error('event loop blocked');
      console.log(JSON.stringify({ ticks, converted: result[0] }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.ticks > 0);
  assert.equal(result.converted, '頭髮乾燥，後來發現理髮店。');
});
