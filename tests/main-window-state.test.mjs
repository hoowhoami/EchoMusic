import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
const module = { exports: {} };
runInNewContext(
  buildSync({
    entryPoints: ['src/main/window/state.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text,
  { module, setTimeout, clearTimeout },
);
const { readMainWindowState, trackMainWindowState } = module.exports;
const initial = { x: 0, y: 30, width: 1150, height: 750, isMaximized: false };
function setup() {
  const win = Object.assign(new EventEmitter(), {
    minimized: false,
    maximized: false,
    fullscreen: false,
    destroyed: false,
    bounds: { x: 0, y: 30, width: 1150, height: 750 },
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isMaximized() {
      return this.maximized;
    },
    isFullScreen() {
      return this.fullscreen;
    },
    getNormalBounds() {
      return this.bounds;
    },
    getBounds() {
      return this.bounds;
    },
  });
  let enabled = true;
  const saves = [];
  const tracker = trackMainWindowState(win, {
    initial,
    enabled: () => enabled,
    save: (value) => saves.push(value),
  });
  return {
    win,
    tracker,
    saves,
    enable: (value) => {
      enabled = value;
    },
  };
}
test('Wayland snapshots omit unobservable global coordinates', () => {
  const e = setup();
  e.win.bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const state = readMainWindowState(e.win, initial, { supportsPosition: false });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    width: 1200,
    height: 800,
    isMaximized: false,
  });
  e.tracker.dispose();
});
test('macOS pending fullscreen animation cannot overwrite normal bounds', () => {
  const e = setup();
  e.win.bounds = { x: 0, y: 0, width: 3840, height: 2160 };
  assert.equal(readMainWindowState(e.win, initial, { transitioning: () => true }), initial);
  e.tracker.dispose();
});
test('macOS zoom stores the current frame as normal, matching VS Code', () => {
  const e = setup();
  e.win.maximized = true;
  e.win.getBounds = () => ({ x: 0, y: 24, width: 1440, height: 876 });
  const state = readMainWindowState(e.win, initial, { macOS: true });
  assert.equal(state.isMaximized, false);
  assert.equal(state.width, 1440);
  e.tracker.dispose();
});
test('maximize uses current normal bounds, including a resize immediately before maximizing', () => {
  const e = setup();
  e.win.bounds.width = 1400;
  e.win.maximized = true;
  e.win.emit('maximize');
  e.tracker.flush();
  assert.equal(e.saves.at(-1).width, 1400);
  assert.equal(e.saves.at(-1).isMaximized, true);
  e.tracker.dispose();
});
test('fullscreen/minimize never overwrite the last normal rectangle or maximize mode', () => {
  const e = setup();
  e.win.maximized = true;
  e.win.emit('maximize');
  e.win.minimized = true;
  e.win.maximized = false;
  e.win.bounds = { x: -32000, y: -32000, width: 0, height: 0 };
  e.tracker.flush();
  assert.equal(e.saves.at(-1).isMaximized, true);
  assert.equal(e.saves.at(-1).width, 1150);
  e.win.fullscreen = true;
  e.win.minimized = false;
  e.win.bounds = { x: 0, y: 0, width: 3840, height: 2160 };
  assert.equal(readMainWindowState(e.win, initial), initial);
  e.tracker.dispose();
});
test('programmatic and native changes use the same snapshot, with deduplication and no dirty gate', () => {
  const e = setup();
  e.win.bounds = { ...e.win.bounds, x: 450 };
  e.win.emit('move');
  e.tracker.flush();
  e.tracker.flush();
  assert.equal(e.saves.length, 1);
  assert.equal(e.saves[0].x, 450);
  e.tracker.dispose();
});
test('disabled persistence leaves the previous saved preference intact and enabling captures current state', () => {
  const e = setup();
  e.enable(false);
  e.win.bounds.width = 1300;
  e.win.emit('resize');
  e.tracker.flush();
  assert.equal(e.saves.length, 0);
  e.enable(true);
  e.tracker.flush();
  assert.equal(e.saves.at(-1).width, 1300);
  e.tracker.dispose();
});
test('dispose cancels pending persistence and removes native listeners', async () => {
  const e = setup();
  e.win.emit('resize');
  e.tracker.dispose();
  assert.equal(e.win.listenerCount('resize'), 0);
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(e.saves.length, 0);
});
