import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const code = transformSync(
  readFileSync(new URL('../src/main/plugins/process.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function childFixture(pid = 123) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, killed: false, signals: [] });
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.killed = true;
    return true;
  };
  child.exit = (signal = 'SIGTERM') => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
  };
  return child;
}
function fixture(options = {}) {
  const app = new EventEmitter();
  const child = options.child ?? childFixture();
  const plugin = {
    id: 'test',
    name: 'Test',
    version: '1',
    directory: '/plugin',
    enabled: true,
    manifest: { capabilities: { process: true } },
  };
  const timers = new Set();
  const storage = new Map();
  let spawnCount = 0;
  const mocks = {
    electron: {
      app,
      dialog: { showMessageBox: options.confirm ?? (async () => ({ response: 0 })) },
    },
    child_process: {
      spawn(...args) {
        spawnCount++;
        if (options.spawn) return options.spawn(...args);
        if (options.autoSpawn !== false) queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    },
    'fs/promises': {
      access: async () => {},
      realpath: async (path) => path,
      stat: async () => ({ mode: 0o755, isFile: () => true, isDirectory: () => true }),
      readFile: async () => Buffer.from('executable'),
    },
    '../storage/kv': {
      getKvStorage: () => ({
        get: (key) => storage.get(key),
        set: (key, value) => storage.set(key, value),
      }),
    },
    '../logger': { warn() {} },
    './common': {
      BLOCKED_PLUGIN_PROCESS_ENV_KEYS: new Set(),
      MAX_PLUGIN_PROCESS_ARGS: 64,
      MAX_PLUGIN_PROCESS_ARG_LENGTH: 8192,
      MAX_PLUGIN_PROCESS_ENV_ENTRIES: 64,
      MAX_PLUGIN_PROCESS_ENV_VALUE_LENGTH: 8192,
      PLUGIN_PROCESS_CONSENTS_KEY: 'consents',
      WINDOWS_EXECUTABLE_EXTENSIONS: new Set(['.exe', '.com']),
      normalizePluginId: (id) => id,
    },
    './path': {
      isPathInside: () => true,
      resolvePluginFile: () => '/plugin/tool.exe',
      toPortableRelativePath: () => 'tool.exe',
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', code)(
    (name) => mocks[name] ?? require(name),
    mod,
    mod.exports,
    options.setTimeout ??
      ((fn) => {
        const timer = { fn };
        timers.add(timer);
        return timer;
      }),
    options.clearTimeout ?? ((timer) => timers.delete(timer)),
  );
  const api = mod.exports.createPluginProcessApi({
    findPlugin: (id) => (id === plugin.id ? plugin : null),
    getPluginCompatibilityError: () => '',
    getPluginSafeMode: () => false,
  });
  return {
    api,
    app,
    child,
    plugin,
    timers,
    get spawnCount() {
      return spawnCount;
    },
    launch: () => api.launchPluginProcess('test', { executable: 'tool.exe' }),
    fireTimer() {
      const timer = timers.values().next().value;
      assert.ok(timer, 'expected a termination timeout');
      timers.delete(timer);
      timer.fn();
    },
  };
}

test('a successful terminate signal retains process ownership until the child exits', async () => {
  const f = fixture();
  assert.equal((await f.launch()).ok, true);
  assert.equal(f.api.terminatePluginProcess('test', 123).terminated, true);
  assert.equal(f.api.terminatePluginProcess('test', 123).ok, true);
  assert.equal(f.api.terminatePluginProcess('other', 123).ok, false);
  f.child.exit();
  assert.equal(f.api.terminatePluginProcess('test', 123).ok, false);
});

test('group cleanup waits for exit even after the child has already received a signal', async () => {
  const f = fixture();
  await f.launch();
  f.api.terminatePluginProcess('test', 123);
  let finished = false;
  const pending = f.api.terminatePluginProcesses('test').then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(f.timers.size, 1);
  f.child.exit();
  await pending;
  assert.equal(finished, true);
  assert.equal(f.timers.size, 0);
});

test('concurrent cleanup shares one timeout and escalates ignored SIGTERM to SIGKILL', async () => {
  const f = fixture();
  await f.launch();
  const first = f.api.terminatePluginProcesses('test');
  const second = f.api.terminatePluginProcesses();
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  assert.equal(f.timers.size, 1);
  f.fireTimer();
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  f.child.exit('SIGKILL');
  await Promise.all([first, second]);
  assert.equal(f.timers.size, 0);
  assert.equal(f.child.listenerCount('exit'), 0);
});

test('failed signal delivery and timeouts retain ownership for a later retry', async () => {
  const f = fixture();
  await f.launch();
  f.child.kill = (signal) => {
    f.child.signals.push(signal);
    f.child.emit('error', new Error('EPERM'));
    return false;
  };
  const pending = f.api.terminatePluginProcesses('test');
  f.fireTimer();
  f.fireTimer();
  await pending;
  assert.equal(f.api.terminatePluginProcess('test', 123).ok, true);
  const retry = f.api.terminatePluginProcesses('test');
  assert.equal(f.timers.size, 1);
  f.child.exit();
  await retry;
  assert.equal(f.timers.size, 0);
});

test('a synchronous kill exception still permits escalation and exit cleanup', async () => {
  const f = fixture();
  await f.launch();
  f.child.kill = (signal) => {
    if (signal === 'SIGTERM') throw new Error('EPERM');
    f.child.exit('SIGKILL');
    return true;
  };
  const pending = f.api.terminatePluginProcesses('test');
  f.fireTimer();
  await pending;
  assert.equal(f.timers.size, 0);
  assert.equal(f.api.terminatePluginProcess('test', 123).ok, false);
});

test('quitting invalidates a pending launch confirmation and prevents later launches', async () => {
  let confirm;
  const f = fixture({
    confirm: () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  });
  const pending = f.launch();
  await flush();
  assert.equal(typeof confirm, 'function');
  f.app.emit('before-quit');
  confirm({ response: 0 });
  assert.equal((await pending).ok, false);
  assert.equal((await f.launch()).ok, false);
  assert.equal(f.spawnCount, 0);
});

test('revocation while spawn is pending still tracks and forcefully cleans up the new child', async () => {
  const f = fixture({ autoSpawn: false });
  const pending = f.launch();
  await flush();
  assert.equal(f.spawnCount, 1);
  f.plugin.enabled = false;
  f.child.emit('spawn');
  await flush();
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  f.fireTimer();
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  f.child.exit('SIGKILL');
  assert.equal((await pending).ok, false);
  assert.equal(f.api.terminatePluginProcess('test', 123).ok, false);
});

test(
  'a real child that ignores SIGTERM exits after the cleanup escalation',
  {
    skip: process.platform === 'win32',
    timeout: 10000,
  },
  async () => {
    let child;
    const f = fixture({
      spawn() {
        child = spawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        return child;
      },
      setTimeout,
      clearTimeout,
    });
    try {
      const ready = new Promise((resolve) => {
        // spawn() executes after asynchronous launch path validation.
        const poll = () => {
          if (!child) return queueMicrotask(poll);
          child.stdout.once('data', resolve);
        };
        poll();
      });
      assert.equal((await f.launch()).ok, true);
      await ready;
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(8000) });
      await f.api.terminatePluginProcesses('test');
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      assert.equal(f.api.terminatePluginProcess('test', child.pid).ok, false);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
