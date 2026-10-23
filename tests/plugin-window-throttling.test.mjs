import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as throttling from '../src/main/windowBackgroundThrottling.ts';

const code = transformSync(
  readFileSync(new URL('../src/main/plugins/windows.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

function fixture(platform) {
  const windows = [];
  const descriptor = {
    pluginId: 'test',
    id: 'floating',
    title: 'Test Floating Window',
    defaultWidth: 300,
    defaultHeight: 100,
    minWidth: 100,
    minHeight: 50,
    maxWidth: 800,
    maxHeight: 600,
    alwaysOnTop: false,
    rememberBounds: false,
    transparent: true,
  };
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    constructor(options) {
      super();
      this.options = options;
      this.throttled = options.webPreferences.backgroundThrottling;
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        setBackgroundThrottling: (value) => {
          this.throttled = value;
        },
        send() {},
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    getBounds() {
      return { x: 0, y: 0, width: 300, height: 100 };
    }
    setBackgroundColor() {}
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    showInactive() {
      this.visible = true;
      this.emit('show');
    }
    hide() {
      this.visible = false;
      this.emit('hide');
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
    async loadFile() {
      this.emit('ready-to-show');
    }
  }
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const dependencies = {
    electron: {
      BrowserWindow: Window,
      screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display },
    },
    path: { join },
    '../ipc/registry': {},
    '../windowBackgroundThrottling': throttling,
    '../macBackgroundMode': {},
    '../plugins': {
      normalizePluginId: (id) => id,
      getPluginSafeMode: () => false,
      getPluginDescriptor: () => ({ enabled: true, compatibility: { compatible: true } }),
      getPluginWindowDescriptor: () => descriptor,
      isPluginAccessCurrent: () => true,
    },
    '../storage/kv': {},
    '../logger': {},
    '../windowDrag': {
      WindowDragController: class {
        cancelAll() {
          return {};
        }
        dispose() {}
      },
    },
    '../networkPolicy': { registerNetworkSession: async () => {} },
    '../windowBoundsPersistence': {
      bindWindowBoundsPersistenceEvents() {},
      shouldFlushWindowBounds: () => false,
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    __dirname: '/test',
    process: { platform, env: {} },
    setTimeout: () => 0,
    clearTimeout() {},
    require: (id) => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
  });
  return { api: module.exports, windows };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} plugin window resumes on reuse and cleans up on recreation`, async () => {
    const { api, windows } = fixture(platform);
    assert.equal((await api.showPluginWindow('test', 'floating')).ok, true);
    const win = windows[0];
    assert.equal(win.options.webPreferences.backgroundThrottling, true);
    assert.equal(win.throttled, false);
    win.emit('blur');
    assert.equal(win.throttled, false);
    assert.equal(api.hidePluginWindow('test', 'floating').ok, true);
    assert.equal(win.throttled, true);
    assert.equal((await api.showPluginWindow('test', 'floating')).ok, true);
    assert.equal(windows.length, 1);
    assert.equal(win.throttled, false);
    assert.equal(win.listenerCount('show'), 1);
    api.closePluginWindow('test', 'floating');
    assert.equal(win.listenerCount('show'), 0);
    assert.equal((await api.showPluginWindow('test', 'floating')).ok, true);
    assert.equal(windows.length, 2);
    assert.equal(windows[1].throttled, false);
    api.closePluginWindows();
  });
}
