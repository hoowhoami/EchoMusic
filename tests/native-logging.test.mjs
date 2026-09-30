import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const noop = () => {};

function load(file, dependencies = {}) {
  const url = new URL(file, import.meta.url);
  const code = transformSync(readFileSync(url, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', code)(
    (name) => {
      if (name in dependencies) return dependencies[name];
      assert.ok(isBuiltin(name), `Unexpected dependency: ${name}`);
      return require(name);
    },
    module,
    module.exports,
    dirname(fileURLToPath(url)),
  );
  return module.exports;
}

function fixture() {
  const messages = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => messages.push({ level, args }),
    ]),
  );
  const bridge = load('../src/main/native/logging.ts', { '../logger': logger });
  return { messages, logger, bridge };
}

test('native logs preserve all four levels, module names, Unicode and multiline messages', () => {
  for (const errorFirst of [true, false]) {
    const { messages, bridge } = fixture();
    let handler;
    const addon = {
      registerLogHandler(callback) {
        assert.equal(this, addon);
        handler = callback;
      },
    };
    bridge.registerNativeLogHandler(addon, 'AudioPlayerNative');
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const entry = { level, message: '音频输出\nsecond line' };
      if (errorFirst) handler(null, entry);
      else handler(entry);
    }
    assert.deepEqual(
      messages,
      ['debug', 'info', 'warn', 'error'].map((level) => ({
        level,
        args: ['[AudioPlayerNative] 音频输出\nsecond line'],
      })),
    );
  }
});

test('unknown levels and absent entries follow the bridge default contract', () => {
  const { messages, bridge } = fixture();
  let handler;
  bridge.registerNativeLogHandler(
    {
      registerLogHandler: (callback) => {
        handler = callback;
      },
    },
    'Test',
  );
  for (const level of [undefined, null, '', 'trace', 'WARN', 42])
    handler({ level, message: 'message' });
  for (const entry of [undefined, null, {}, { level: 'info', message: '' }]) handler(entry);
  assert.deepEqual(
    messages.slice(0, 6),
    Array.from({ length: 6 }, () => ({ level: 'info', args: ['[Test] message'] })),
  );
  assert.deepEqual(
    messages.slice(6),
    Array.from({ length: 4 }, () => ({ level: 'info', args: ['[Test] -'] })),
  );
});

test('callback errors produce one warning and do not forward the accompanying entry', () => {
  const { messages, bridge } = fixture();
  let handler;
  bridge.registerNativeLogHandler(
    {
      registerLogHandler: (callback) => {
        handler = callback;
      },
    },
    'AirPlayNative',
  );
  handler(new Error('callback closed'), { level: 'error', message: 'not emitted' });
  assert.deepEqual(messages, [
    { level: 'warn', args: ['[NativeLog] AirPlayNative 日志回调失败: callback closed'] },
  ]);
  handler(null, { level: 'info', message: 'next event' });
  assert.deepEqual(messages[1], { level: 'info', args: ['[AirPlayNative] next event'] });
});

test('missing optional ABI is harmless and registration errors never escape', () => {
  const { messages, bridge } = fixture();
  for (const addon of [undefined, null, {}]) bridge.registerNativeLogHandler(addon, 'Legacy');
  assert.deepEqual(messages, []);
  for (const failure of [new Error('closed'), 'unavailable']) {
    assert.doesNotThrow(() =>
      bridge.registerNativeLogHandler(
        {
          registerLogHandler() {
            throw failure;
          },
        },
        'Test',
      ),
    );
    assert.deepEqual(messages.at(-1), {
      level: 'warn',
      args: [`[NativeLog] Test 日志回调注册失败: ${String(failure)}`],
    });
  }
});

test('separate native modules retain their own log labels', () => {
  const { messages, bridge } = fixture();
  const callbacks = [];
  for (const name of ['AudioPlayerNative', 'AirPlayNative', 'MediaControlsNative']) {
    bridge.registerNativeLogHandler(
      { registerLogHandler: (callback) => callbacks.push(callback) },
      name,
    );
  }
  callbacks.forEach((callback) => callback(null, { level: 'debug', message: 'ready' }));
  assert.deepEqual(
    messages.map((entry) => entry.args[0]),
    ['[AudioPlayerNative] ready', '[AirPlayNative] ready', '[MediaControlsNative] ready'],
  );
});

test('audio player registers the bridge before initialization, including after restart', () => {
  const { logger, bridge, messages } = fixture();
  const order = [];
  let handler;
  const addon = {
    registerLogHandler(callback) {
      order.push('log');
      handler = callback;
    },
    registerEventHandler() {
      order.push('event');
    },
    initialize() {
      order.push('initialize');
      handler(null, { level: 'info', message: 'initialized' });
    },
    destroy() {
      order.push('destroy');
    },
  };
  const { PlayerController } = load('../src/main/player/controller.ts', {
    electron: { app: {} },
    '../logger': logger,
    '../native/logging': bridge,
    '../networkSettings': { refreshNetworkSettingsFromStorage: () => ({}) },
    '../storage/persistedStores': { getPersistedRendererSettings: () => ({}) },
    '../networkPolicy': {},
    '../../shared/audioEffectSupport': {},
  });
  const controller = new PlayerController();
  controller.resolveAddonPath = () => '/test/audio.node';
  controller.loadAddon = () => addon;
  assert.equal(controller.start(), true);
  assert.equal(controller.start(), true);
  controller.destroy();
  assert.deepEqual(order, [
    'log',
    'event',
    'initialize',
    'destroy',
    'log',
    'event',
    'initialize',
    'destroy',
  ]);
  assert.equal(
    messages.filter((entry) => entry.args[0] === '[AudioPlayerNative] initialized').length,
    2,
  );
});

for (const fallback of [false, true]) {
  test(`media controls register native logging before initialization (${fallback ? 'fallback' : 'primary'} load)`, () => {
    const { logger, bridge, messages } = fixture();
    const order = [];
    const paths = [];
    let handler;
    const addon = {
      registerLogHandler(callback) {
        order.push('log');
        handler = callback;
      },
      initialize() {
        order.push('initialize');
        handler(null, { level: 'debug', message: 'initialized' });
      },
      registerEventHandler() {
        order.push('event');
      },
      shutdown() {
        order.push('shutdown');
      },
    };
    const module = load('../src/main/mediaControls.ts', {
      electron: { app: { isPackaged: false }, ipcMain: { handle: noop } },
      'node:module': {
        createRequire: () => (path) => {
          paths.push(path);
          if (fallback && paths.length === 1) throw Error('primary missing');
          return addon;
        },
      },
      './logger': logger,
      './native/logging': bridge,
      '../shared/abortError': {},
      './taskbarThumbnail': {},
      './networkPolicy': {},
    });
    module.initMediaControls(() => null);
    module.destroyMediaControls();
    assert.equal(paths.length, fallback ? 2 : 1);
    assert.deepEqual(order, ['log', 'initialize', 'event', 'shutdown']);
    assert(messages.some((entry) => entry.args[0] === '[MediaControlsNative] initialized'));
  });
}

test('AirPlay logs are wired before connect and output initialization does not double-register', async () => {
  const { logger, bridge, messages } = fixture();
  const order = [];
  let handler;
  let host;
  let options;
  const addon = {
    registerLogHandler(callback) {
      order.push('log');
      handler = callback;
    },
    discover: async () => [],
    connect: async () => {
      order.push('connect');
      handler(null, { level: 'warn', message: 'connecting' });
      return { ok: true };
    },
  };
  const { initOutputRuntime } = load('../src/main/outputs/outputRuntime.ts', {
    electron: { app: { isPackaged: false, once: noop } },
    'node:fs': { existsSync: (path) => basename(path) === 'echo-airplay.node' },
    'node:module': { createRequire: () => () => addon },
    '../logger': logger,
    '../native/logging': bridge,
    '../window': {},
    '../player': {},
    '../mediaTransport/discovery': { createSsdpDiscovery: () => ({ stop: noop }) },
    '../mediaTransport/genaReceiver': { GenaReceiver: class {} },
    '../mediaTransport/mediaServer': { MediaServer: class {}, pickLanIpv4: () => '127.0.0.1' },
    '../mediaTransport/upnpClient': {},
    './outputHost': {
      getOutputHost: () => host,
      initOutputHost: (value) => {
        options = value;
        host = {};
      },
    },
    './airplayBonjourDiagnostics': {},
  });
  initOutputRuntime(() => null);
  initOutputRuntime(() => null);
  assert.equal(options.airplay.available, true);
  assert.deepEqual(await options.airplay.connect('test-device'), { ok: true });
  assert.deepEqual(order, ['log', 'connect']);
  assert(messages.some((entry) => entry.args[0] === '[AirPlayNative] connecting'));
});
