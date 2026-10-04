import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

function compile(file, mocks, globals = {}) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => {
      assert.ok(name in mocks, `unexpected dependency: ${name}`);
      return mocks[name];
    },
    mod,
    mod.exports,
    ...Object.values(globals),
  );
  return mod.exports;
}
function playerFixture(start, destroy = () => {}) {
  let controller;
  let destroyed = 0;
  let taskbarDestroyed = 0;
  const messages = [];
  const api = compile('../src/main/player/index.ts', {
    '../logger': { info() {}, warn() {} },
    '../window': {
      getMainWindow: () => ({ webContents: { send: (...args) => messages.push(args) } }),
    },
    './controller': {
      PlayerController: class extends EventEmitter {
        available = true;
        constructor() {
          super();
          controller = this;
        }
        start() {
          return start(this);
        }
        destroy() {
          destroyed++;
          destroy();
        }
      },
    },
    '../desktopLyric': {},
    '../miniPlayer': {},
    '../taskbarProgress': {
      setupTaskbarProgress() {},
      destroyTaskbarProgress: () => taskbarDestroyed++,
    },
    '../outputs/outputHost': { getOutputHost: () => null },
  });
  return {
    api,
    messages,
    get controller() {
      return controller;
    },
    get destroyed() {
      return destroyed;
    },
    get taskbarDestroyed() {
      return taskbarDestroyed;
    },
  };
}
test('a player that reports startup failure releases its addon and taskbar state', async () => {
  const f = playerFixture(() => false);
  assert.equal(await f.api.initPlayer(() => null), null);
  assert.equal(f.destroyed, 1);
  assert.equal(f.taskbarDestroyed, 1);
});
test('a player initialization exception releases resources and preserves the original error', async () => {
  const original = new Error('initialize failed');
  const f = playerFixture(() => {
    throw original;
  });
  await assert.rejects(
    f.api.initPlayer(() => null),
    (error) => error === original,
  );
  assert.equal(f.destroyed, 1);
  assert.equal(f.taskbarDestroyed, 1);
});
test('cleanup failure does not replace the player initialization error or skip taskbar cleanup', async () => {
  const original = new Error('initialize failed');
  const f = playerFixture(
    () => {
      throw original;
    },
    () => {
      throw new Error('destroy failed');
    },
  );
  await assert.rejects(
    f.api.initPlayer(() => null),
    (error) => error === original,
  );
  assert.equal(f.taskbarDestroyed, 1);
});
test('successful player initialization retains startup events and resources until normal teardown', async () => {
  const f = playerFixture((controller) => {
    controller.emit('core-state-change', 'ready');
    return true;
  });
  assert.equal(await f.api.initPlayer(() => null), f.controller);
  assert.deepEqual(f.messages, [['player:core-state-change', 'ready']]);
  assert.equal(f.destroyed, 0);
  assert.equal(f.taskbarDestroyed, 0);
  f.api.destroyPlayer();
  assert.equal(f.destroyed, 1);
  assert.equal(f.taskbarDestroyed, 1);
});

test('application shutdown waits for output resources and plugin processes before native teardown and app.exit', async () => {
  const app = new EventEmitter();
  const events = [];
  let completeOutput;
  const outputCleanup = new Promise((resolve) => {
    completeOutput = resolve;
  });
  let completeProcesses;
  const processCleanup = new Promise((resolve) => {
    completeProcesses = resolve;
  });
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    exit: () => events.push('exit'),
  });
  const empty = {};
  const mocks = Object.fromEntries(
    [
      './server',
      './ipc',
      './window/modeController',
      './window/mode',
      './desktopLyric',
      './outputs/outputRuntime',
      './audioSpectrum',
      './mediaControls',
      './audioCapture',
      './miniPlayer',
      './powerMonitor',
      './appIcons',
      './thumbar',
      './taskbarThumbnail',
      './taskbarProgress',
      './taskbarMediaBar',
      './applicationMenu',
      './diagnostics/memory',
      './share',
      './networkSettings',
    ].map((key) => [key, empty]),
  );
  Object.assign(mocks, {
    './outputs/outputRuntime': {
      shutdownOutputRuntime: () => {
        events.push('output cleanup');
        return outputCleanup;
      },
    },
    electron: {
      app,
      BrowserWindow: { getAllWindows: () => [] },
      dialog: {},
      globalShortcut: { unregisterAll() {} },
    },
    './logger': {
      initLogger() {},
      setDiagnosticStateListener() {},
      info() {},
      warn() {},
      error() {},
    },
    './eventLoopMonitor': { stopEventLoopMonitor() {} },
    './networkPolicy': { installNetworkPolicyLifecycle() {} },
    './window': { getMainWindow: () => null },
    './share': { registerShareProtocol() {} },
    './ipc': { registerIpcHandlers() {} },
    './tray': { destroyTray() {} },
    './taskbarThumbnail': { destroyTaskbarThumbnail() {} },
    './taskbarMediaBar': { cleanupTaskbarPlayer() {} },
    './outputs/outputHost': { getOutputHost: () => null },
    './plugins': {
      terminatePluginProcesses: () => {
        events.push('process cleanup');
        return processCleanup;
      },
      clearPluginRuntimeSession() {},
    },
    './updateInstallQuit': { isUpdateInstallQuitRequested: () => false },
    './player': { destroyPlayer: () => events.push('player destroyed') },
    './audioSpectrum': { unregisterAudioSpectrumIpc() {} },
    './desktopLyric': { cleanupDesktopLyric() {}, destroyDesktopLyricWindow() {} },
    './miniPlayer': { cleanupMiniPlayer() {} },
    './audioCapture': { destroyAudioCapture() {} },
    './mediaControls': { destroyMediaControls() {} },
  });
  const immediates = [];
  compile('../src/main/app.ts', mocks, { setImmediate: (callback) => immediates.push(callback) });
  let prevented = false;
  app.emit('before-quit', {
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  const cleanup = immediates[0]();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(events, ['output cleanup']);
  completeOutput();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(events, ['output cleanup', 'process cleanup']);
  completeProcesses();
  await cleanup;
  assert.deepEqual(events, ['output cleanup', 'process cleanup', 'player destroyed', 'exit']);
});
