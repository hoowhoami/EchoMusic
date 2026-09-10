import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
const module = { exports: {} };
runInNewContext(
  buildSync({
    entryPoints: ['src/main/window/titleBar.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text,
  { module },
);
const { createTitleBarController } = module.exports;
test('lyrics override light theme and survive theme/zoom updates; closing restores current theme', () => {
  let dark = false,
    level = 0,
    destroyed = false;
  const calls = [];
  const c = createTitleBarController(
    { isDestroyed: () => destroyed, setTitleBarOverlay: (o) => calls.push(o) },
    () => dark,
    () => level,
  );
  c.sync();
  assert.equal(calls.at(-1).symbolColor, '#202020');
  c.setLyricVisible(true);
  assert.equal(calls.at(-1).symbolColor, '#ffffff');
  level = 2;
  c.sync();
  assert.equal(calls.at(-1).symbolColor, '#ffffff');
  assert.ok(calls.at(-1).height > calls[0].height);
  dark = true;
  c.sync();
  c.setLyricVisible(false);
  assert.equal(calls.at(-1).symbolColor, '#ffffff');
  dark = false;
  c.sync();
  assert.equal(calls.at(-1).symbolColor, '#202020');
  c.setLyricVisible(true);
  c.setLyricVisible(false);
  assert.equal(calls.at(-1).symbolColor, '#202020');
  destroyed = true;
  const count = calls.length;
  c.sync();
  assert.equal(calls.length, count);
});
