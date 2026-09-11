import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_BACKGROUND,
  getWindowComposition,
  normalizeWindowBackground,
  resolveWindowBackground,
  resolveRunningWindowBackground,
} from '../src/shared/window-background.ts';

test('old settings default to an opaque themed background', () => {
  assert.deepEqual(normalizeWindowBackground(null), DEFAULT_WINDOW_BACKGROUND);
  assert.deepEqual(normalizeWindowBackground({}), DEFAULT_WINDOW_BACKGROUND);
});
test('invalid persisted values cannot generate invalid CSS or out-of-range alpha', () => {
  assert.equal(normalizeWindowBackground({ transparency: Infinity }).transparency, 0);
  assert.equal(normalizeWindowBackground({ transparency: -20 }).transparency, 0);
  assert.equal(normalizeWindowBackground({ transparency: 180 }).transparency, 100);
  assert.equal(normalizeWindowBackground({ color: 'url(https://example.com)' }).color, '');
});
test('frost preserves the color and transparency to restore on exit', () => {
  const saved = { enabled: true, transparency: 65, frosted: true, color: '#aAbBcC' };
  assert.deepEqual(normalizeWindowBackground(saved), saved);
  assert.deepEqual(normalizeWindowBackground({ ...saved, frosted: false }), {
    ...saved,
    frosted: false,
  });
});

test('legacy transparency settings remain saved but default to disabled', () => {
  const saved = normalizeWindowBackground({ transparency: 65, frosted: true, color: '#aAbBcC' });
  assert.equal(saved.enabled, false);
  assert.equal(saved.transparency, 65);
  assert.deepEqual(resolveWindowBackground(saved, false), DEFAULT_WINDOW_BACKGROUND);
});

test('switching native mode takes effect only after recreation', () => {
  const saved = { enabled: true, transparency: 65, frosted: true, color: '#aAbBcC' };
  assert.deepEqual(resolveWindowBackground(saved, false), DEFAULT_WINDOW_BACKGROUND);
  assert.deepEqual(resolveWindowBackground(saved, true), saved);
  const disabled = { ...saved, enabled: false };
  assert.deepEqual(resolveWindowBackground(disabled, true), saved);
  assert.deepEqual(resolveWindowBackground(disabled, false), DEFAULT_WINDOW_BACKGROUND);
});

test('Windows clear and Acrylic preserve a non-layered native window', () => {
  const clear = { enabled: true, frosted: false, transparency: 50, color: '' };
  assert.deepEqual(getWindowComposition(clear, 'win32', 22631), {
    transparent: false,
    systemMaterial: false,
    clientCornerRadius: 0,
  });
  assert.deepEqual(getWindowComposition({ ...clear, frosted: true }, 'win32', 22631), {
    transparent: false,
    systemMaterial: true,
    clientCornerRadius: 0,
  });
  assert.deepEqual(getWindowComposition({ ...clear, enabled: false }, 'win32', 22631), {
    transparent: false,
    systemMaterial: false,
    clientCornerRadius: 0,
  });
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(getWindowComposition({ ...clear, frosted: true }, platform, 22631), {
      transparent: platform !== 'darwin',
      systemMaterial: false,
      clientCornerRadius: 0,
    });
  }
  assert.equal(getWindowComposition(clear, 'win32', 19045).clientCornerRadius, 0);
});

test('explicit active frost state takes precedence over saved preferences', () => {
  const saved = { enabled: true, frosted: true, transparency: 62, color: '#123456' };
  assert.equal(resolveWindowBackground(saved, true, false).frosted, false);
  const pendingClear = { ...saved, frosted: false };
  assert.equal(resolveWindowBackground(pendingClear, true, true).frosted, true);
  assert.equal(resolveWindowBackground(saved, true, null).frosted, true);
  assert.deepEqual(resolveWindowBackground(saved, false, false), DEFAULT_WINDOW_BACKGROUND);
  assert.equal(resolveWindowBackground(pendingClear, true, false).transparency, 62);
});

const clear = { enabled: true, frosted: false, transparency: 60, color: '' };
const frost = { ...clear, frosted: true };
test('legacy Windows selects an Electron transparent window for clear and frost', () => {
  for (const build of [19045, 22000, 22620]) {
    assert.equal(getWindowComposition(clear, 'win32', build).transparent, true);
    assert.equal(getWindowComposition(frost, 'win32', build).transparent, true);
    assert.equal(
      getWindowComposition(DEFAULT_WINDOW_BACKGROUND, 'win32', build).transparent,
      false,
    );
    for (const transparent of [false, true]) {
      for (const wanted of [DEFAULT_WINDOW_BACKGROUND, clear, frost]) {
        const restartRequired = wanted.enabled !== transparent;
        assert.deepEqual(resolveRunningWindowBackground(wanted, 'win32', transparent, build), {
          background: restartRequired ? DEFAULT_WINDOW_BACKGROUND : wanted,
          restartRequired,
        });
      }
    }
  }
});
test('modern Windows retains live native composition at the build boundary', () => {
  for (const build of [22621, 26100]) {
    for (const background of [DEFAULT_WINDOW_BACKGROUND, clear, frost]) {
      assert.equal(getWindowComposition(background, 'win32', build).transparent, false);
      assert.deepEqual(resolveRunningWindowBackground(background, 'win32', false, build), {
        background,
        restartRequired: false,
      });
    }
  }
});
test('legacy Windows can cancel a pending clear selection without restarting', () => {
  assert.equal(resolveRunningWindowBackground(clear, 'win32', false, 19045).restartRequired, true);
  assert.deepEqual(resolveRunningWindowBackground(DEFAULT_WINDOW_BACKGROUND, 'win32', false, 19045), {
    background: DEFAULT_WINDOW_BACKGROUND,
    restartRequired: false,
  });
  const saved = { ...clear, transparency: 87, color: '#123456' };
  const pending = resolveRunningWindowBackground(saved, 'win32', false, 19045);
  assert.equal(pending.background.enabled, false);
  assert.deepEqual(resolveRunningWindowBackground(saved, 'win32', true, 19045), {
    background: saved,
    restartRequired: false,
  });
});
test('macOS ordinary windows toggle Vibrancy live and require recreation for clear and frost', () => {
  for (const background of [DEFAULT_WINDOW_BACKGROUND, frost]) {
    assert.deepEqual(resolveRunningWindowBackground(background, 'darwin', false), {
      background,
      restartRequired: false,
    });
    assert.equal(getWindowComposition(background, 'darwin', 0).transparent, false);
  }
  assert.deepEqual(resolveRunningWindowBackground(clear, 'darwin', false), {
    background: DEFAULT_WINDOW_BACKGROUND,
    restartRequired: true,
  });
  assert.deepEqual(resolveRunningWindowBackground(clear, 'darwin', true), {
    background: clear,
    restartRequired: false,
  });
  for (const background of [DEFAULT_WINDOW_BACKGROUND, frost]) {
    assert.deepEqual(resolveRunningWindowBackground(background, 'darwin', true), {
      background,
      restartRequired: true,
    });
  }
});
test('Linux preserves native transparency until recreation and never enables Vibrancy', () => {
  assert.deepEqual(resolveRunningWindowBackground(clear, 'linux', false), {
    background: DEFAULT_WINDOW_BACKGROUND,
    restartRequired: true,
  });
  assert.deepEqual(resolveRunningWindowBackground(frost, 'linux', true), {
    background: clear,
    restartRequired: false,
  });
  assert.deepEqual(resolveRunningWindowBackground({ ...clear, enabled: false }, 'linux', true), {
    background: clear,
    restartRequired: true,
  });
  assert.deepEqual(resolveRunningWindowBackground(DEFAULT_WINDOW_BACKGROUND, 'linux', false), {
    background: DEFAULT_WINDOW_BACKGROUND,
    restartRequired: false,
  });
});
