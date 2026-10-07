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
function setup() {
  const element = () => ({
    children: Array.from({ length: 3 }, () => ({ style: {} })),
    getAnimations: () => [],
  });
  const group = () => {
    const el = element();
    return { mainLine: { getElement: () => el }, element: el };
  };
  class Engine {
    currentLyricGroups = [group(), group()];
    time = 12000;
    timelineState = { scrollToIndex: 1 };
    hot = new Set([1]);
    scrollOffset = 95;
    replacements = 0;
    layouts = [];
    root = {
      style: {
        setProperty: (key, value) => {
          this[key] = value;
        },
      },
      getAnimations: () => [],
    };
    resizeObserver = { disconnect() {} };
    getElement() {
      return this.root;
    }
    calcLayout(sync, force) {
      this.layouts.push({ sync, force });
      return Promise.resolve();
    }
    setLyricLines() {
      this.replacements++;
      this.currentLyricGroups = [group(), group()];
    }
    dispose() {}
  }
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    () => ({ LyricPlayer: Engine }),
    module,
    module.exports,
  );
  const player = new module.exports.OpeningLyricPlayer();
  player.finishOpeningLayout();
  return { player };
}

test('secondary toggles preserve lyric groups, playback and manual scroll while snapping height changes', async () => {
  const env = setup(),
    p = env.player,
    groups = p.currentLyricGroups,
    hot = p.hot;
  p.setSecondaryVisibility(false, true);
  assert.equal(p.currentLyricGroups, groups);
  assert.equal(p.hot, hot);
  assert.equal(p.time, 12000);
  assert.equal(p.scrollOffset, 95);
  assert.equal(p.replacements, 0);
  assert.ok(groups.every((g) => g.mainLine.getElement().children[1].style.display === 'none'));
  assert.ok(groups.every((g) => g.mainLine.getElement().children[2].style.display === ''));
  await p.calcLayout(true);
  assert.equal(p.layouts.at(-1).force, true);
  await p.calcLayout();
  assert.equal(p.layouts.at(-1).force, false, 'normal playback keeps its springs');
  p.timelineState.scrollToIndex = 2;
  await p.calcLayout(true);
  assert.equal(p.layouts.at(-1).force, false, 'next lyric follows normal layout');
  p.setSecondaryVisibility(true, false);
  assert.equal(p['--echo-amll-roman-display'], 'none');
  assert.ok(groups.every((g) => g.mainLine.getElement().children[1].style.display === ''));
  assert.ok(groups.every((g) => g.mainLine.getElement().children[2].style.display === 'none'));
});

test('replacement lyrics inherit secondary visibility, including unmounted groups', () => {
  const { player: p } = setup();
  p.setSecondaryVisibility(false, false);
  p.setLyricLines([], 35000);
  assert.equal(p.replacements, 1);
  assert.ok(
    p.currentLyricGroups.every((g) =>
      g.mainLine
        .getElement()
        .children.slice(1)
        .every((el) => el.style.display === 'none'),
    ),
  );
});

test('delayed measurements snap only the same lyric and fresh data clears that state', async () => {
  const { player: p } = setup();
  p.setSecondaryVisibility(false, false);
  await p.calcLayout(true);
  await p.calcLayout(true);
  assert.ok(p.layouts.every((l) => l.force));
  await p.calcLayout(false);
  assert.equal(p.layouts.at(-1).force, false, 'manual scrolling retains normal springs');
  p.setLyricLines([], 35000);
  await p.calcLayout(true);
  assert.equal(p.layouts.at(-1).force, false, 'new lyrics resume ordinary resize behavior');
});
