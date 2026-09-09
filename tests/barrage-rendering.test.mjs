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
test('local sends suppress immediate server echoes but not other users or later playback', () => {
  const { barrageIdentity, nextBarrageItem } = module.exports;
  const own = { text: 'hello', userId: '1' }, other = { text: 'hello', userId: '2' };
  const recent = new Map([[barrageIdentity(own), 20000]]);
  assert.equal(nextBarrageItem([own, other], 0, recent, 100).item, other);
  assert.equal(nextBarrageItem([own], 0, recent, 100).item, undefined);
  assert.equal(nextBarrageItem([own], 0, recent, 20001).item, own);
});
test('long and short barrage use identical pixel speed, including larger fonts and viewports', () => {
  const { barrageTravelDuration, BARRAGE_BASE_SPEED } = module.exports;
  for (const width of [320, 1000, 1920]) {
    for (const text of [40, 300, 4000]) {
      for (const speed of [0.5, 1, 2]) {
        assert.ok(Math.abs((width + text) / barrageTravelDuration(width, text, speed) - BARRAGE_BASE_SPEED * speed) < 1e-8);
      }
    }
  }
  assert.ok(barrageTravelDuration(1000, 4000, 1) > barrageTravelDuration(1000, 40, 1));
  assert.equal(barrageTravelDuration(1000, 100, 0), 11);
});
