import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateTaskbarDock,
  type TaskbarDisplay,
  type TaskbarShellLayout,
} from '../src/main/taskbarDock.ts';

const base: TaskbarDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1,
};
const shell: TaskbarShellLayout = {
  bounds: { x: 0, y: 1032, width: 1920, height: 48 },
  reliable: true,
  occupied: [
    { x: 0, y: 1032, width: 630, height: 48 },
    { x: 1680, y: 1032, width: 240, height: 48 },
  ],
};
test('avoids left-aligned Start, pinned apps and tray', () => {
  const p = calculateTaskbarDock(base, undefined, shell);
  assert.equal(p.mode, 'taskbar');
  assert.ok(p.bounds.x >= 638);
  assert.ok(p.bounds.x + p.bounds.width <= 1672);
  assert.equal(p.bounds.height, 46);
  assert.equal(p.bounds.y, 1033);
});
test('respects centered task buttons and widgets on Windows 11', () => {
  const p = calculateTaskbarDock(base, undefined, {
    ...shell,
    occupied: [
      { x: 0, y: 1032, width: 170, height: 48 },
      { x: 680, y: 1032, width: 680, height: 48 },
      { x: 1620, y: 1032, width: 300, height: 48 },
    ],
  });
  assert.equal(p.mode, 'taskbar');
  assert.ok(p.bounds.x >= 178);
  assert.ok(p.bounds.x + p.bounds.width <= 672);
});
test('narrows only into a sufficiently large free interval', () => {
  const p = calculateTaskbarDock(base, undefined, {
    ...shell,
    occupied: [
      { x: 0, y: 1032, width: 800, height: 48 },
      { x: 1080, y: 1032, width: 840, height: 48 },
    ],
  });
  assert.equal(p.mode, 'taskbar');
  assert.equal(p.bounds.width, 264);
  assert.equal(p.bounds.x, 808);
});
test('crowded and unknown taskbars fall back above, never cover icons', () => {
  for (const s of [
    undefined,
    { ...shell, reliable: false },
    { ...shell, occupied: [shell.bounds] },
  ]) {
    const p = calculateTaskbarDock(base, undefined, s);
    assert.equal(p.mode, 'work-area');
    assert.ok(p.bounds.y + p.bounds.height <= base.workArea.height - 8);
  }
});
test('logical proportions survive all common DPI factors, not a fixed physical cap', () => {
  for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
    const p = calculateTaskbarDock({ ...base, scaleFactor }, undefined, shell);
    assert.equal(p.bounds.height, 46);
    assert.equal(p.bounds.width, 362);
    assert.ok(p.bounds.height * scaleFactor < shell.bounds.height * scaleFactor);
  }
});
test('adapts to small and double-height taskbars', () => {
  for (const thickness of [24, 32, 40, 48, 64, 96]) {
    const d = { ...base, workArea: { ...base.workArea, height: 1080 - thickness } };
    const s = {
      ...shell,
      bounds: { ...shell.bounds, y: 1080 - thickness, height: thickness },
      occupied: shell.occupied.map((r) => ({ ...r, y: 1080 - thickness, height: thickness })),
    };
    const p = calculateTaskbarDock(d, undefined, s);
    assert.ok(p.bounds.height >= 20 && p.bounds.height <= 64);
    assert.ok(p.bounds.y >= 0 && p.bounds.y + p.bounds.height <= 1080);
    assert.equal(p.mode, 'taskbar');
  }
});
test('supports a top taskbar on a negative-coordinate secondary monitor', () => {
  const d: TaskbarDisplay = {
    bounds: { x: -2560, y: -120, width: 2560, height: 1440 },
    workArea: { x: -2560, y: -72, width: 2560, height: 1392 },
    scaleFactor: 1.5,
  };
  const p = calculateTaskbarDock(d, undefined, {
    bounds: { x: -2560, y: -120, width: 2560, height: 48 },
    reliable: true,
    occupied: [{ x: -2560, y: -120, width: 600, height: 48 }],
  });
  assert.equal(p.edge, 'top');
  assert.equal(p.mode, 'taskbar');
  assert.ok(p.bounds.x >= -1952 && p.bounds.x + p.bounds.width <= 0);
  assert.equal(p.bounds.y, -119);
});

test('uses the real client surface when work-area reservation is taller', () => {
  const native = { ...shell, bounds: { ...shell.bounds, y: 1040, height: 36 } };
  const p = calculateTaskbarDock(base, undefined, native);
  assert.equal(p.mode, 'taskbar');
  assert.equal(p.bounds.y, 1041);
  assert.equal(p.bounds.height, 34);
  assert.ok(p.bounds.y + p.bounds.height < 1076);
});

test('fractional DPI and displaced taskbars stay strictly inside their measured edges', () => {
  for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2, 3, 4]) {
    for (const offset of [0, 0.2, 0.66, 1.33, 4]) {
      const native = {
        ...shell,
        bounds: { ...shell.bounds, y: 1032 + offset, height: 48 - offset },
      };
      const p = calculateTaskbarDock({ ...base, scaleFactor }, undefined, native);
      assert.equal(p.mode, 'taskbar');
      assert.ok(p.bounds.y > native.bounds.y);
      assert.ok(p.bounds.y + p.bounds.height < native.bounds.y + native.bounds.height);
    }
  }
});
test('vertical taskbars keep a horizontal player beside them', () => {
  for (const edge of ['left', 'right'] as const) {
    const d = {
      ...base,
      workArea: { x: edge === 'left' ? 64 : 0, y: 0, width: 1856, height: 1080 },
    };
    const p = calculateTaskbarDock(d);
    assert.equal(p.edge, edge);
    assert.equal(p.mode, 'work-area');
    assert.ok(p.bounds.x >= d.workArea.x);
    assert.ok(p.bounds.x + p.bounds.width <= d.workArea.x + d.workArea.width);
  }
});
test('auto-hide retains every edge and leaves reveal room for the shell', () => {
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const p = calculateTaskbarDock({ ...base, workArea: base.bounds }, edge);
    assert.equal(p.edge, edge);
    assert.equal(p.mode, 'screen-edge');
    assert.ok(p.bounds.y > 0 && p.bounds.y + p.bounds.height < 1080);
    assert.ok(p.bounds.x >= 0 && p.bounds.x + p.bounds.width <= 1920);
  }
});
test('tiny work areas never produce off-screen or negative-sized windows', () => {
  for (const width of [16, 80, 240]) {
    const d: TaskbarDisplay = {
      bounds: { x: -width, y: 0, width, height: 80 },
      workArea: { x: -width, y: 0, width, height: 32 },
    };
    const p = calculateTaskbarDock(d);
    assert.ok(p.bounds.width > 0 && p.bounds.height > 0);
    assert.ok(p.bounds.x >= -width && p.bounds.x + p.bounds.width <= 0);
    assert.ok(p.bounds.y >= 0 && p.bounds.y + p.bounds.height <= 32);
  }
});
