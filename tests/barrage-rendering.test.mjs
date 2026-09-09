import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const source = buildSync({ entryPoints: [new URL('../src/renderer/utils/barrage.ts', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { normalizeBarrageItems, normalizeBarrageUserId, getFreeBarrageLane } = module.exports;
test('ownership preserves user identity and excludes anonymous and invalid IDs', () => {
  assert.equal(normalizeBarrageUserId(123), normalizeBarrageUserId('123'));
  assert.equal(normalizeBarrageUserId('9007199254740993'), '9007199254740993');
  for (const value of [null, undefined, 0, '0', '', 'undefined', {}, -1]) assert.equal(normalizeBarrageUserId(value), '');
  assert.deepEqual(normalizeBarrageItems([{ content: ' hello ', user_id: '123' }, null, { content: ' ' }]), [{ text: 'hello', userId: '123' }]);
});
test('list size is bounded independently of the upstream response size', () => {
  assert.equal(normalizeBarrageItems(Array.from({ length: 1000 }, () => ({ content: 'test' }))).length, 100);
});
test('out-of-order animation completion only reuses vacant lanes', () => {
  assert.equal(getFreeBarrageLane([{ lane: 0 }, { lane: 2 }, { lane: 3 }]), 1);
  assert.equal(getFreeBarrageLane([0, 1, 2, 3].map(lane => ({ lane }))), -1);
});
