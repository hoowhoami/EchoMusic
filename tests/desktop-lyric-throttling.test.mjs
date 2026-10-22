import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as path from 'node:path';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/main/desktopLyric/window.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

function fixture(platform, alwaysOnTop = false) {
  class Window extends EventEmitter {
    destroyed = false;
    changes = [];
    constructor(options) {
      super();
      this.options = options;
      this.throttled = options.webPreferences.backgroundThrottling;
      this.webContents = {
        setBackgroundThrottling: (value) => {
          this.throttled = value;
          this.changes.push(value);
        },
      };
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    showInactive() {
      this.emit('show');
    }
    setBackgroundColor() {}
    setAlwaysOnTop(value) {
      this.topmost = value;
    }
    setSkipTaskbar() {}
  }
  const dependencies = {
    electron: { BrowserWindow: Window, app: { isPackaged: true } },
    path,
    '../../shared/windowing': { isWaylandWindowingBackend: () => false },
    './store': {
      resolveInitialBounds: () => ({ x: 0, y: 0, width: 800, height: 150 }),
      getDesktopLyricSettings: () => ({ alwaysOnTop }),
      getDesktopLyricWindowLimits: () => ({}),
    },
    '../networkPolicy': {},
    '../macBackgroundMode': {},
    '../windowBoundsPersistence': { bindWindowBoundsPersistenceEvents() {} },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', 'process', code)(
    (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
    '/test/main',
    { platform, env: {} },
  );
  return module.exports;
}

for (const alwaysOnTop of [false, true]) {
  test(`Windows desktop lyric stays unthrottled when shown (alwaysOnTop=${alwaysOnTop})`, () => {
    const api = fixture('win32', alwaysOnTop);
    const win = api.createDesktopLyricWindow();
    assert.equal(win.throttled, false);
    assert.equal(win.options.alwaysOnTop, alwaysOnTop);
    win.emit('ready-to-show');
    assert.equal(win.throttled, false);
    api.syncWindowPresentation(!alwaysOnTop);
    assert.equal(win.topmost, !alwaysOnTop);
    assert.equal(win.throttled, false, 'z-order must not pause the lyric animation');
    win.emit('blur');
    assert.equal(win.throttled, false, 'loss of focus is not an explicit hide');
    win.emit('hide');
    assert.equal(win.throttled, true, 'explicitly hidden lyrics can save resources');
    win.emit('show');
    assert.equal(win.throttled, false, 'restoring lyrics resumes normal frame production');
    assert.equal(api.createDesktopLyricWindow(), win);
    assert.equal(win.listenerCount('show'), 1, 'reusing the window must not duplicate listeners');
    assert.equal(win.listenerCount('hide'), 1);
    win.destroyed = true;
    const replacement = api.createDesktopLyricWindow();
    assert.notEqual(replacement, win);
    assert.equal(replacement.throttled, false);
  });
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform} retains the default background throttling policy`, () => {
    const win = fixture(platform).createDesktopLyricWindow();
    assert.equal(win.throttled, true);
    win.emit('hide');
    win.emit('show');
    assert.deepEqual(win.changes, []);
  });
}
