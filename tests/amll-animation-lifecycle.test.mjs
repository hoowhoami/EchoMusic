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

function animation() {
  return {
    effect: { target: {} },
    onfinish() {},
    oncancel() {},
    cancel() {
      this.cancelled = true;
    },
  };
}
function element(animations = [], mounted = true) {
  return {
    parentElement: mounted ? {} : null,
    queries: 0,
    getAnimations(options) {
      assert.equal(options.subtree, true);
      this.queries++;
      return animations;
    },
  };
}
class Engine {
  currentLyricGroups = [];
  dots = animation();
  element = element([this.dots]);
  resizeObserver = {
    disconnect: () => {
      this.disconnected = true;
    },
  };
  calcLayout() {
    return Promise.resolve();
  }
  getElement() {
    return this.element;
  }
  update() {
    for (const group of this.currentLyricGroups) {
      if (group.element.parentElement && !group.isInSight) {
        // Core is about to drop the word arrays and their DOM.
        assert.ok(group.animations.every((a) => a.cancelled && a.effect === null));
        group.element.parentElement = null;
      }
    }
  }
  setLyricLines(lines, time) {
    assert.ok(this.currentLyricGroups.every((g) => g.animations.every((a) => a.effect === null)));
    this.currentLyricGroups = [];
    this.initialTime = time;
    this.lines = lines;
  }
  dispose() {
    assert.equal(this.dots.effect, null);
    this.disposed = true;
  }
}
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  () => ({ LyricPlayer: Engine }),
  module,
  module.exports,
);
const { OpeningLyricPlayer } = module.exports;
function group(inSight, mounted = true) {
  const animations = [animation(), animation()];
  return { isInSight: inSight, element: element(animations, mounted), animations };
}

test('leaving lyrics release effects and callbacks before their DOM is discarded', () => {
  const player = new OpeningLyricPlayer();
  const leaving = group(false),
    visible = group(true),
    detached = group(false, false);
  player.currentLyricGroups = [leaving, visible, detached];
  player.update(16);
  for (const a of leaving.animations) {
    assert.equal(a.effect, null);
    assert.equal(a.onfinish, null);
    assert.equal(a.oncancel, null);
  }
  assert.equal(visible.element.queries, 0);
  assert.equal(detached.element.queries, 0);
  assert.ok(visible.animations.every((a) => a.effect && !a.cancelled));
  // Steady playback does not query animations again or touch visible word effects.
  for (let i = 0; i < 60; i++) player.update(16);
  assert.equal(leaving.element.queries, 1);
  assert.equal(visible.element.queries, 0);
});

test('replacing lyrics frees old words, preserves interlude animations and initial time', () => {
  const player = new OpeningLyricPlayer();
  const previous = group(true);
  player.currentLyricGroups = [previous];
  const next = [{ words: [] }];
  player.setLyricLines(next, 12345);
  assert.equal(player.initialTime, 12345);
  assert.equal(player.lines, next);
  assert.ok(previous.animations.every((a) => a.effect === null));
  assert.ok(player.dots.effect);
  assert.equal(player.element.queries, 0);
});

test('disposing frees persistent animations, disconnects observation and drops group references', () => {
  const player = new OpeningLyricPlayer();
  player.currentLyricGroups = [group(true)];
  player.dispose();
  assert.equal(player.disposed, true);
  assert.equal(player.disconnected, true);
  assert.equal(player.dots.effect, null);
  assert.deepEqual(player.currentLyricGroups, []);
});
