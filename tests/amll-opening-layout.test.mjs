import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const code = buildSync({
  entryPoints: ['src/renderer/views/lyric/amll/OpeningLyricPlayer.ts'],
  bundle: true,
  external: ['@applemusic-like-lyrics/core'],
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;

// Model the engine's constructor, settings and ResizeObserver layout entry points.
class Engine {
  calls = [];
  size = [0, 0];
  element = { clientWidth: 640, clientHeight: 480 };
  constructor() {
    this.calcLayout();
  }
  calcLayout(sync = false, force = false) {
    this.calls.push({ sync, force });
    return Promise.resolve();
  }
  getElement() {
    return this.element;
  }
}
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  () => ({ LyricPlayer: Engine }),
  module,
  module.exports,
);
const { OpeningLyricPlayer } = module.exports;

test('constructor, settings and initial resize all snap, including synchronous layouts', async () => {
  const player = new OpeningLyricPlayer();
  await player.calcLayout();
  await player.calcLayout(true);
  await player.calcLayout(false, false);
  assert.equal(player.calls.length, 4);
  assert.ok(player.calls.every((call) => call.force));
  assert.equal(player.calls[2].sync, true);
});

test('after opening, normal lyric following uses springs and explicit forced layouts still work', async () => {
  const player = new OpeningLyricPlayer();
  player.finishOpeningLayout();
  await player.calcLayout();
  await player.calcLayout(true);
  await player.calcLayout(false, true);
  assert.deepEqual(player.calls.slice(1), [
    { sync: false, force: false },
    { sync: true, force: false },
    { sync: false, force: true },
  ]);
});

test('reopening starts a fresh initial layout without affecting an already opened player', async () => {
  const previous = new OpeningLyricPlayer();
  previous.finishOpeningLayout();
  const reopened = new OpeningLyricPlayer();
  await previous.calcLayout(true);
  await reopened.calcLayout(true);
  assert.equal(previous.calls.at(-1).force, false);
  assert.equal(reopened.calls.at(-1).force, true);
});

test('seeded viewport preserves nonzero fallback line heights before the first resize delivery', () => {
  const player = new OpeningLyricPlayer();
  const viewport = player.size;
  assert.equal(player.size[1] / 5, 0);
  player.initializeViewport();
  assert.equal(player.size, viewport);
  assert.deepEqual(player.size, [640, 480]);
  assert.equal(player.size[1] / 5, 96);
  // ResizeObserver remains free to update the same core-owned dimensions later.
  player.size[1] = 720;
  assert.equal(player.size[1] / 5, 144);
});
