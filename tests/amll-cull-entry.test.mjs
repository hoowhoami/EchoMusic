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

class Engine {
  currentLyricGroups = [];
  buildLyricGroups() {
    this.currentLyricGroups = this.nextGroups;
  }
}
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  () => ({ LyricPlayer: Engine }),
  module,
  module.exports,
);
const { OpeningLyricPlayer } = module.exports;

function setup(position, { opacity = 1, blur = 0, mounted = false } = {}) {
  const group = {
    element: { parentElement: mounted ? {} : null, style: {} },
    posY: { getCurrentPosition: () => position },
    opacity,
    blur,
    words: [{ animation: {} }],
    show() {
      this.element.parentElement = {};
      // Core's word measurement flushes these styles before its render commit.
      this.measuredStyles = { ...this.element.style };
      this.shows = (this.shows ?? 0) + 1;
    },
  };
  const player = new OpeningLyricPlayer();
  player.nextGroups = [group];
  player.buildLyricGroups();
  return { player, group };
}

test('a new overscan line is positioned and blurred before mounting triggers word measurement', () => {
  const { group } = setup(660.123, { opacity: 0.2, blur: 8 });
  group.show();
  assert.deepEqual(group.measuredStyles, {
    transform: 'translateY(660.1px)',
    opacity: '0.2',
    filter: 'blur(5.00px)',
  });
  assert.equal(group.shows, 1);
});

test('a remounted line discards its stale position while retaining its words and effects', () => {
  const { group } = setup(-170.5);
  const words = group.words;
  group.element.style = { transform: 'translateY(400px)', filter: 'blur(5px)' };
  group.show();
  assert.equal(group.measuredStyles.transform, 'translateY(-170.5px)');
  assert.equal(group.measuredStyles.filter, 'none');
  assert.equal(group.words, words);
});

test('mounted lyrics keep the core commit order and existing movement transitions', () => {
  const { group } = setup(120, { mounted: true });
  group.element.style = { transform: 'translateY(200px)', opacity: '0.85' };
  group.show();
  assert.deepEqual(group.measuredStyles, {
    transform: 'translateY(200px)',
    opacity: '0.85',
  });
});

test('entry follows the current spring position rather than snapping to a target', () => {
  const { group } = setup(501.75);
  group.top = 450;
  group.show();
  assert.equal(group.measuredStyles.transform, 'translateY(501.8px)');
  assert.equal(group.top, 450);
});

test('freshly rebuilt groups receive the same entry preparation', () => {
  const { player, group: previous } = setup(660);
  const { group: next } = setup(320);
  // Model a newly created core group without the first player's adapter.
  next.show = function () {
    this.measuredStyles = { ...this.element.style };
  };
  player.nextGroups = [next];
  player.buildLyricGroups();
  next.show();
  assert.equal(next.measuredStyles.transform, 'translateY(320.0px)');
  assert.equal(previous.shows, undefined);
});
