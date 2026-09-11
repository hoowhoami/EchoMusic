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
function setup({ available = true, diagnostics, legacy = false, modeMax = Infinity } = {}) {
  const calls = [],
    module = { exports: {} };
  const materialModule = { exports: {} };
  runInNewContext(materialCode, { module: materialModule });
  let failed = false;
  const native = {
    ...(diagnostics ? { getWindowCompositionDiagnostics: diagnostics } : {}),
    setWindowComposition(handle, mode) {
      calls.push(['accent', handle, mode]);
      return !failed && (!legacy || mode <= 3) && mode <= modeMax;
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
    diagnose: module.exports.readWindowsCompositionDiagnostics,
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
    ['accent', '1311768467463790320', 5],
    ['material', false],
    ['accent', '1311768467463790320', 0],
    ['material', true],
    ['material', false],
    ['material', true],
    ['accent', '1311768467463790320', 5],
    ['material', false],
    ['accent', '1311768467463790320', 0],
  ]);
});
test('Win10 uses Accent Acrylic and a fresh opaque window makes no native calls', () => {
  const e = setup();
  e.apply(e.win, { ...e.background, enabled: false }, 19045);
  assert.deepEqual(e.calls, []);
  e.apply(e.win, { ...e.background, frosted: true }, 19045);
  assert.deepEqual(e.calls, [['accent', '1311768467463790320', 8]]);
  assert.equal(e.diagnose(e.win).requestedBackend, 'accent-acrylic');
});
test('legacy clear relies on Electron alpha and works without a native addon', () => {
  for (const build of [19045, 22000, 22620]) {
    const e = setup({ available: false });
    assert.equal(e.options(build, true).backgroundMaterial, undefined);
    e.apply(e.win, e.background, build);
    assert.equal(e.diagnose(e.win).requestedBackend, 'electron-transparent');
    e.apply(e.win, { ...e.background, transparency: 100 }, build);
    e.apply(e.win, { ...e.background, enabled: false }, build);
    assert.equal(e.diagnose(e.win).requestedBackend, 'none');
    assert.deepEqual(e.calls, []);
  }
});
test('missing addon reports a fallback and does not prevent official Win11 Acrylic', () => {
  const e = setup({ available: false });
  assert.throws(
    () => e.apply(e.win, { ...e.background, frosted: true }, 19045),
    /系统背景接口不可用/,
  );
  e.apply(e.win, { ...e.background, frosted: true }, 22631);
  assert.deepEqual(e.calls.at(-1), ['material', true]);
});
test('native failures are not cached as successful composition', () => {
  const e = setup();
  e.fail();
  assert.throws(() => e.apply(e.win, { ...e.background, frosted: true }, 19045));
  assert.throws(() => e.apply(e.win, { ...e.background, frosted: true }, 19045));
  assert.equal(e.calls.filter((call) => call[0] === 'accent' && call[2] === 8).length, 2);
});

test('Win11 clear failure releases prepared material and retries instead of caching success', () => {
  const e = setup();
  e.fail();
  for (let i = 0; i < 2; i++) assert.throws(() => e.apply(e.win, e.background, 22631));
  assert.deepEqual(
    e.calls.map((c) => (c[0] === 'material' ? c : [c[0], c[2]])),
    [
      ['material', true],
      ['accent', 5],
      ['material', false],
      ['accent', 0],
      ['material', true],
      ['accent', 5],
      ['material', false],
      ['accent', 0],
    ],
  );
});

test('legacy off/clear/Acrylic switches preserve constructor options without calling the unsupported material setter', () => {
  for (const build of [19045, 22000]) {
    const e = setup();
    const options = e.options(build);
    assert.equal(options.backgroundMaterial, 'acrylic');
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
      [8, 0],
    );
  }
  assert.equal(setup().options(22621).backgroundMaterial, undefined);
});

test('legacy Acrylic rejects beta.3 addons and rolls back without caching success', () => {
  const e = setup({ modeMax: 7 });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => e.apply(e.win, { ...e.background, frosted: true }, 19045));
    assert.equal(e.diagnose(e.win).requestedBackend, 'none');
  }
  assert.deepEqual(
    e.calls.map((c) => c[2]),
    [8, 0, 8, 0],
  );
});

test('Acrylic diagnostics expose drag suppression independently of requested effect', () => {
  const e = setup({
    diagnostics: () => ({
      acrylicDragHandlerInstalled: true,
      acrylicSuspended: true,
      acrylicLastOperationSucceeded: true,
      accentState: 0,
    }),
  });
  e.apply(e.win, { ...e.background, frosted: true }, 19045);
  const state = e.diagnose(e.win);
  assert.equal(state.requestedBackend, 'accent-acrylic');
  assert.equal(state.actual.acrylicSuspended, true);
  assert.equal(state.actual.accentState, 0);
  e.apply(e.win, { ...e.background, frosted: true, transparency: 90 }, 19045);
  assert.equal(e.calls.length, 1); // Do not re-enable Acrylic mid-drag on theme/tint sync.
});
test('legacy Accent failure leaves the constructor alpha declaration intact', () => {
  const e = setup();
  e.fail();
  assert.throws(() => e.apply(e.win, { ...e.background, frosted: true }, 19045));
  assert.equal(
    e.calls.some((c) => c[0] === 'material'),
    false,
  );
});

test('diagnostics distinguish missing and older addons without changing composition', () => {
  for (const available of [false, true]) {
    const e = setup({ available });
    const result = e.diagnose(e.win);
    assert.equal(result.nativeAvailable, available);
    assert.equal(result.nativeDiagnosticsAvailable, false);
    assert.equal(result.requestedBackend, 'none');
    assert.deepEqual(e.calls, []);
  }
});
test('diagnostics report native readback separately from accepted clear requests', () => {
  const e = setup({
    diagnostics: (address) => {
      assert.equal(address, '1311768467463790320');
      return { accentState: 0, systemBackdrop: 1, layered: false, remoteSession: true };
    },
  });
  e.apply(e.win, e.background, 22631);
  const count = e.calls.length;
  const result = e.diagnose(e.win);
  assert.equal(result.requestedBackend, 'clear');
  assert.equal(result.actual.accentState, 0);
  assert.equal(result.actual.remoteSession, true);
  assert.equal(e.calls.length, count);
});
test('failed native diagnostics remain readable and do not reset a running effect', () => {
  const e = setup({
    diagnostics: () => {
      throw new Error('readback failed');
    },
  });
  e.apply(e.win, e.background, 22631);
  const count = e.calls.length;
  assert.match(e.diagnose(e.win).error, /readback failed/);
  assert.equal(e.calls.length, count);
});

test('older Accent-only binaries cannot silently accept the new DWM clear modes', () => {
  for (const build of [22621, 26100]) {
    const e = setup({ legacy: true });
    assert.throws(() => e.apply(e.win, e.background, build), /系统背景接口不可用/);
    assert.equal(e.diagnose(e.win).requestedBackend, 'none');
  }
});

test('Win10 effects reject pre-frame-repair addons while Win11 keeps its working DWM mode', () => {
  for (const build of [19045, 22000]) {
    for (const frosted of [true]) {
      const e = setup({ modeMax: 5 });
      assert.throws(() => e.apply(e.win, { ...e.background, frosted }, build));
      assert.equal(e.diagnose(e.win).requestedBackend, 'none');
    }
  }
  const e = setup({ modeMax: 5 });
  assert.doesNotThrow(() => e.apply(e.win, e.background, 26100));
  assert.equal(e.diagnose(e.win).requestedBackend, 'clear');
});
