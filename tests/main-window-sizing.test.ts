import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveMainWindowPlacement,
  resolveWaylandWindowSize,
  validateWindowBounds,
  MAIN_WINDOW_DEFAULT_SIZE,
  type WindowDisplay,
} from '../src/main/windowSizing.ts';
const display = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
): WindowDisplay => ({ id, workArea: { x, y, width, height }, bounds: { x, y, width, height } });
const primary = display(1, 0, 24, 1920, 1056);

test('4K at 150% Wayland allows a 1228x693 quarter-screen tile', () => {
  const tiled = { width: 1228, height: 693 };
  const result = resolveWaylandWindowSize(tiled);
  assert.deepEqual(result.bounds, tiled);
  assert.equal(result.minHeight, 650);
  assert.ok(result.minHeight < tiled.height);
});

test('Windows 1080p at 150% and 4K at 300% fit the logical work area', () => {
  // Both modes yield a 1280x720 DIP display; Electron already applies system scaling.
  for (const workHeight of [680, 640]) {
    const screen = display(1, 0, 0, 1280, workHeight);
    screen.bounds.height = 720;
    const result = resolveMainWindowPlacement(
      { width: 1150, height: 750, x: 0, y: 0 },
      [screen],
      1,
    );
    assert.equal(result.minHeight, Math.min(650, workHeight));
    assert.ok(result.bounds.y + result.bounds.height <= workHeight);
  }
});

test('Wayland omits coordinates and does not infer a monitor from saved positions', () => {
  const result = resolveWaylandWindowSize({ x: -700, y: 100, width: 1400, height: 900 });
  assert.deepEqual(result.bounds, { width: 1400, height: 900 });
  assert.equal(result.minWidth, 1100);
  assert.equal(result.minHeight, 650);
  assert.deepEqual(
    resolveWaylandWindowSize({ width: Infinity, height: -1 }).bounds,
    MAIN_WINDOW_DEFAULT_SIZE,
  );
});

test('default size is centered and remember-disabled callers ignore all saved state', () => {
  const result = resolveMainWindowPlacement(null, [primary], 1);
  assert.deepEqual(result.bounds, { x: 385, y: 177, ...MAIN_WINDOW_DEFAULT_SIZE });
  assert.equal(result.minHeight, 650);
});
test('invalid persisted numbers never reach native geometry APIs', () => {
  for (const invalid of [NaN, Infinity, -1, 0, 2 ** 40]) {
    const result = resolveMainWindowPlacement(
      { x: Infinity, y: NaN, width: invalid, height: invalid },
      [primary],
      1,
    );
    assert.deepEqual(result.bounds, { x: 385, y: 177, ...MAIN_WINDOW_DEFAULT_SIZE });
  }
});
test('negative coordinates and a larger secondary display restore without primary-display clamping', () => {
  const secondary = display(2, -2560, -200, 2560, 1440);
  const saved = { x: -2400, y: -100, width: 2200, height: 1300 };
  assert.deepEqual(resolveMainWindowPlacement(saved, [primary, secondary], 1).bounds, saved);
});
test('removed monitor recenters on the primary and clamps oversized bounds', () => {
  const saved = { x: -2500, y: 20, width: 2000, height: 1400 };
  assert.deepEqual(resolveMainWindowPlacement(saved, [primary], 1).bounds, primary.workArea);
});
test('small target displays cap BOTH minimum dimensions without a percentage heuristic', () => {
  const tiny = display(2, 1920, 0, 1024, 600);
  const result = resolveMainWindowPlacement(
    { x: 1920, y: 0, width: 1024, height: 600 },
    [primary, tiny],
    1,
  );
  assert.equal(result.minWidth, 1024);
  assert.equal(result.minHeight, 600);
  assert.deepEqual(result.bounds, tiny.workArea);
});
test('oversized single-monitor state and a one-pixel intersection remain draggable', () => {
  const result = resolveMainWindowPlacement(
    { x: 1919, y: 1079, width: 1200, height: 800 },
    [primary],
    1,
  );
  assert.ok(result.bounds.x + result.bounds.width <= 1920);
  assert.ok(result.bounds.y >= 24 && result.bounds.y + result.bounds.height <= 1080);
});
test('zero workArea falls back to display bounds, empty display list remains valid', () => {
  const broken = { ...primary, workArea: { x: 0, y: 0, width: 0, height: 0 } };
  assert.deepEqual(
    resolveMainWindowPlacement(null, [broken], 1),
    resolveMainWindowPlacement(null, [primary], 1),
  );
  assert.deepEqual(resolveMainWindowPlacement(null, [], 1).bounds, {
    x: 0,
    y: 0,
    ...MAIN_WINDOW_DEFAULT_SIZE,
  });
});
test('intentional spanning across connected displays is preserved', () => {
  const saved = { x: 100, y: 100, width: 2300, height: 800 };
  assert.deepEqual(
    resolveMainWindowPlacement(saved, [primary, display(2, 1920, 0, 1920, 1080)], 1).bounds,
    saved,
  );
});

test('VS Code single-display recovery keeps intentional right/bottom overhang within its 128 DIP threshold', () => {
  const saved = { x: 1000, y: 500, width: 1150, height: 750 };
  assert.deepEqual(validateWindowBounds(saved, [primary]), saved);
});
test('VS Code multi-display validation preserves intersecting bounds and rejects disconnected positions', () => {
  const screens = [primary, display(2, -1920, 0, 1920, 1080)];
  const intersecting = { x: -3000, y: -300, width: 1150, height: 750 };
  assert.deepEqual(validateWindowBounds(intersecting, screens), intersecting);
  assert.equal(validateWindowBounds({ ...intersecting, x: -8000 }, screens), null);
  const fallback = resolveMainWindowPlacement({ ...intersecting, x: -8000 }, screens, 1);
  assert.deepEqual(fallback.bounds, { x: 385, y: 177, ...MAIN_WINDOW_DEFAULT_SIZE });
});
