import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const module = { exports: {} };
runInNewContext(
  transformSync(
    readFileSync(new URL('../src/main/window/macComposition.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code,
  { module },
);
const apply = module.exports.applyMacWindowBackground;
function setup() {
  const calls = [];
  let shadow = true;
  return {
    calls,
    win: {
      setVibrancy: (value) => calls.push(['vibrancy', value]),
      setBackgroundColor: (value) => calls.push(['background', value]),
      hasShadow: () => shadow,
      setHasShadow(value) {
        shadow = value;
        calls.push(['shadow', value]);
      },
      invalidateShadow: () => calls.push(['invalidate']),
    },
  };
}
const frost = { enabled: true, frosted: true, transparency: 60, color: '' };
test('ordinary macOS window changes material and theme without losing native shadow', () => {
  const { win, calls } = setup();
  apply(win, frost, false, true);
  apply(win, frost, false, true);
  apply(win, frost, false, false);
  apply(win, { ...frost, enabled: false }, false, false);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'vibrancy'),
    [
      ['vibrancy', 'hud'],
      ['vibrancy', 'under-window'],
      ['vibrancy', null],
    ],
  );
  assert.equal(win.hasShadow(), true);
  assert.equal(
    calls.some((c) => c[0] === 'shadow'),
    false,
  );
  assert.deepEqual(calls.at(-1), ['background', '#f5f5f7']);
});
test('alpha shadow workaround stays limited to transparent windows', () => {
  const { win, calls } = setup();
  apply(win, { ...frost, frosted: false }, true, true);
  assert.equal(win.hasShadow(), false);
  apply(win, { ...frost, enabled: false }, true, true);
  assert.equal(win.hasShadow(), true);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'shadow'),
    [
      ['shadow', false],
      ['shadow', true],
    ],
  );
});
