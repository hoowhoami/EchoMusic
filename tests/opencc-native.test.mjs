import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const native = require('../native/echo-opencc');

test('native batch converts all supported profiles and returns a Promise', async () => {
  for (const profile of ['s2t', 's2t-variants', 's2tw', 's2hk']) {
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

test('traditional variants use native dictionary and phrase conversion without changing existing profiles', async () => {
  const input = [
    '因为你这里的群众，峰回路转。',
    '為 群 峰 裡',
    '才华 著作 梁先生 桥梁 人参 参加 口吃 吃饭',
    '𠮷🙂中文かな한글',
  ];
  const expected = [
    '因爲你這裏的羣衆，峯迴路轉。',
    '爲 羣 峯 裏',
    '才華 著作 梁先生 橋樑 人蔘 參加 口吃 喫飯',
    '𠮷🙂中文かな한글',
  ];
  assert.deepEqual(await native.convertBatch(input, 's2t-variants'), expected);
  for (const [i, text] of input.entries()) {
    assert.equal(native.convert(text, 's2t-variants'), expected[i]);
    assert.equal([...text].length, [...expected[i]].length);
  }
  assert.equal(native.convert(input[0], 's2t'), '因為你這裡的群眾，峰迴路轉。');
  assert.equal(native.convert('床前明月光', 's2tw'), '床前明月光');
  assert.equal(native.convert('台灯', 's2hk'), '枱燈');
  assert.deepEqual(await native.convertBatch([], 's2t-variants'), []);
});
