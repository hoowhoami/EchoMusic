import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [new URL('../src/renderer/utils/commentVip.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { commentChipsFromRaw } = module.exports;

test('batch_union_vipinfo style busi_vip array paints 畅听VIP', () => {
  assert.deepEqual(
    commentChipsFromRaw({
      user_id: '123',
      busi_vip: [{ product_type: 'tvip', is_vip: 1, y_type: 0 }],
    }).map((chip) => chip.label),
    ['畅听VIP'],
  );
});
