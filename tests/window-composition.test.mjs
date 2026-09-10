import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
const compile = (path) =>
  transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const compositionCode = compile('../src/main/window/windowsComposition.ts');
const materialCode = compile('../src/main/window/backgroundMaterial.ts');
function setup({ available = true } = {}) {
  const calls = [],
    module = { exports: {} };
  const materialModule = { exports: {} };
  runInNewContext(materialCode, { module: materialModule });
  let failed = false;
  const native = {
    setWindowComposition(handle, mode) {
      calls.push(['accent', handle, mode]);
      return !failed;
    },
  };
  runInNewContext(compositionCode, {
    module,
    __dirname: '/app/dist-electron/main',
    process: { platform: 'win32', cwd: () => '/app' },
    require(name) {
      if (name === '../native/platform')
        return { getNativePlatform: () => (available ? native : null) };
      if (name === './backgroundMaterial') return materialModule.exports;
      throw new Error(name);
    },
  });
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x123456789abcdef0n);
  const win = {
    getNativeWindowHandle: () => handle,
    setBackgroundMaterial: (material) => calls.push(['material', material === 'acrylic']),
  };
  const background = { enabled: true, frosted: false, transparency: 50, color: '' };
  return {
    calls,
    win,
    background,
    apply: module.exports.applyWindowsComposition,
    options: module.exports.getWindowsCompositionOptions,
    fail: () => {
      failed = true;
    },
  };
}
test('clear -> Win11 Acrylic -> clear -> opaque disables the previous backend in order', () => {
  const e = setup();
  e.apply(e.win, e.background, 22631);
  e.apply(e.win, { ...e.background, transparency: 20 }, 22631);
  e.apply(e.win, { ...e.background, frosted: true }, 22631);
  e.apply(e.win, e.background, 22631);
  e.apply(e.win, { ...e.background, enabled: false }, 22631);
  assert.deepEqual(e.calls, [
    ['material', true],
    ['accent', '1311768467463790320', 3],
    ['material', false],
    ['accent', '1311768467463790320', 0],
    ['material', true],
    ['material', false],
    ['material', true],
    ['accent', '1311768467463790320', 3],
    ['material', false],
    ['accent', '1311768467463790320', 0],
  ]);
});
test('Win10 uses BlurBehind and a fresh opaque window makes no native calls', () => {
  const e = setup();
  e.apply(e.win, { ...e.background, enabled: false }, 19045);
  assert.deepEqual(e.calls, []);
  e.apply(e.win, { ...e.background, frosted: true }, 19045);
  assert.deepEqual(e.calls, [['accent', '1311768467463790320', 2]]);
});
test('missing addon reports a fallback and does not prevent official Win11 Acrylic', () => {
  const e = setup({ available: false });
  assert.throws(() => e.apply(e.win, e.background, 19045), /系统背景接口不可用/);
  e.apply(e.win, { ...e.background, frosted: true }, 22631);
  assert.deepEqual(e.calls.at(-1), ['material', true]);
});
test('native failures are not cached as successful composition', () => {
  const e = setup();
  e.fail();
  assert.throws(() => e.apply(e.win, e.background, 19045));
  assert.throws(() => e.apply(e.win, e.background, 19045));
  assert.equal(e.calls.filter((call) => call[0] === 'accent' && call[2] === 1).length, 2);
});

test('Win11 clear failure releases prepared material and retries instead of caching success', () => {
  const e = setup();
  e.fail();
  for (let i = 0; i < 2; i++) assert.throws(() => e.apply(e.win, e.background, 22631));
  assert.deepEqual(
    e.calls.map((c) => (c[0] === 'material' ? c : [c[0], c[2]])),
    [
      ['material', true],
      ['accent', 3],
      ['material', false],
      ['accent', 0],
      ['material', true],
      ['accent', 3],
      ['material', false],
      ['accent', 0],
    ],
  );
});

test('Win10 and early Win11 prepare alpha at creation and keep it through off/clear/blur toggles', () => {
  for (const build of [19045, 22000]) {
    const e = setup();
    const options = e.options(build);
    assert.equal(options.backgroundMaterial, 'acrylic');
    assert.equal(options.thickFrame, true);
    assert.notEqual(options.transparent, true);
    for (const background of [
      { ...e.background, enabled: false },
      e.background,
      { ...e.background, frosted: true },
      { ...e.background, enabled: false },
      e.background,
    ])
      e.apply(e.win, background, build);
    // Runtime setBackgroundMaterial cannot update the Win10 compositor. In
    // particular, do not clear the constructor's alpha declaration on exit.
    assert.equal(
      e.calls.some((c) => c[0] === 'material'),
      false,
    );
    assert.deepEqual(
      e.calls.map((c) => c[2]),
      [1, 0, 2, 0, 1],
    );
  }
  assert.equal(setup().options(22621).backgroundMaterial, undefined);
});
test('legacy Accent failure leaves the constructor alpha declaration intact', () => {
  const e = setup();
  e.fail();
  assert.throws(() => e.apply(e.win, e.background, 19045));
  assert.equal(
    e.calls.some((c) => c[0] === 'material'),
    false,
  );
});
