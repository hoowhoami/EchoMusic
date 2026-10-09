import { userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (code) => transformSync(code, { loader: 'ts', format: 'cjs' }).code;
function load(code, dependencies, globals = {}, names = []) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...names, code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    ...names.map((name) => globals[name]),
  );
  return module.exports;
}
const mainScript = compile(read('../src/main/ipc/recognize.ts'));
const session = load(compile(read('../src/renderer/utils/userSession.ts')), {});
const { descriptor } = parse(read('../src/renderer/views/Recognize.vue'));
const pageScript = compile(compileScript(descriptor, { id: 'recognize-test' }).content);
const deferred = (t, fallback) => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  t.after(() => resolve(fallback));
  return { promise, resolve, reject };
};
const flush = async () => {
  await vue.nextTick();
  await new Promise((resolve) => setImmediate(resolve));
};
const bounded = async (request) => {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('request did not settle within 500ms')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const running = { running: true, sampleRate: 48000, channels: 2 };
const bytes = new Uint8Array([1, 0, 2, 0]);
const song = (id) => ({ id: String(id), name: String(id), hash: `hash-${id}` });
const match = (id) => ({ song: song(id), confidence: 0.9 });
const device = (id) => ({ id, name: id, isDefault: false, sampleRate: 48000, channels: 1 });
class Sender extends EventEmitter {
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
function mainFixture(t, platform = 'darwin') {
  const handlers = new Map();
  const calls = { starts: [], stops: [], cancels: 0, permissions: [], warnings: [] };
  let permission = async () => true;
  let start = () => running;
  let cancel = () => {};
  let stop = () => ({ data: Buffer.from(bytes) });
  const sender = new Sender();
  const addon = {
    listInputDevices: () => [device('mic')],
    startCapture: (options) => {
      calls.starts.push(options);
      return start(options);
    },
    stopCapture: (options) => {
      calls.stops.push(options);
      return stop(options);
    },
    cancelCapture: () => {
      calls.cancels++;
      return cancel();
    },
  };
  load(
    mainScript,
    {
      electron: {
        systemPreferences: {
          askForMediaAccess: (kind) => {
            calls.permissions.push(kind);
            return permission();
          },
        },
      },
      '../audioCapture': { requireAudioCapture: () => addon },
      '../logger': { warn: (...args) => calls.warnings.push(args) },
      './registry': {
        ipcRegistry: { registerHandler: (key, handler) => handlers.set(key, handler) },
      },
    },
    { process: { platform } },
    ['process'],
  ).registerRecognizeHandlers();
  t.after(() => sender.destroy());
  const invoke = (name, owner, ...args) =>
    handlers.get(`recognize:${name}`)({ sender: owner }, ...args);
  return {
    sender,
    calls,
    begin: (request = { source: 'mic' }, owner = sender) =>
      invoke('start-audio-capture', owner, request),
    end: (owner = sender) => invoke('stop-audio-capture', owner),
    cancel: (owner = sender) => invoke('cancel-audio-capture', owner),
    list: () => invoke('list-input-devices', sender),
    permission: (fn) => {
      permission = fn;
    },
    start: (fn) => {
      start = fn;
    },
    stop: (fn) => {
      stop = fn;
    },
    cancelNative: (fn) => {
      cancel = fn;
    },
  };
}
function pageFixture(t, native) {
  const hooks = Object.fromEntries(
    ['onMounted', 'onActivated', 'onDeactivated', 'onBeforeUnmount', 'onUnmounted'].map((key) => [
      key,
      [],
    ]),
  );
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'one' },
  });
  const setting = vue.reactive({ recognizeAudioSource: 'system', inputDevice: 'default' });
  const calls = {
    devices: 0,
    starts: [],
    stops: 0,
    cancels: 0,
    recognition: [],
    loads: 0,
    adds: [],
    actions: [],
    notices: [],
    logs: [],
  };
  let devices = async () => [device('one')];
  let start = async () => running;
  let stop = async () => bytes;
  let cancel = async () => {};
  let recognize = async () => [match('one')];
  let fetch = async () => {};
  let add = async () => 'added';
  const playlist = vue.reactive({
    userPlaylists: [{ listid: 3, id: 'local', listCreateUserid: 7 }],
    getCreatedPlaylists: (id) =>
      playlist.userPlaylists.filter((row) => row.listCreateUserid === id),
    fetchUserPlaylists: (...args) => {
      calls.loads++;
      return fetch(...args);
    },
    addToPlaylist: (...args) => {
      calls.adds.push(args);
      return add(...args);
    },
    isFavoriteSong: () => false,
    addToFavorites: (value) => calls.actions.push(['favorite', value]),
    removeFavoriteSong: (value) => calls.actions.push(['unfavorite', value]),
  });
  const timers = new Map(),
    cleared = [];
  let timerId = 0;
  const bridge = native || {
    listInputDevices: () => {
      calls.devices++;
      return devices();
    },
    startAudioCapture: (request) => {
      calls.starts.push(request);
      return start(request);
    },
    stopAudioCapture: () => {
      calls.stops++;
      return stop();
    },
    cancelAudioCapture: () => {
      calls.cancels++;
      return cancel();
    },
  };
  const page = load(
    pageScript,
    {
      vue: {
        ...vue,
        ...Object.fromEntries(
          Object.entries(hooks).map(([key, list]) => [key, (fn) => list.push(fn)]),
        ),
      },
      'vue-router': {
        useRouter: () => ({ push: (value) => calls.actions.push(['detail', value]) }),
      },
      '@/icons': {},
      '@/api/recognize': {
        recognizeAudio: (pcm) => {
          calls.recognition.push(pcm);
          return recognize(pcm);
        },
      },
      '@/stores/playlist': { usePlaylistStore: () => playlist },
      '@/stores/player': { usePlayerStore: () => ({}) },
      '@/stores/user': { useUserStore: () => user },
      '@/stores/setting': { useSettingStore: () => setting },
      '@/stores/toast': {
        useToastStore: () =>
          new Proxy(
            {},
            {
              get:
                (_, key) =>
                (...args) =>
                  calls.notices.push([key, ...args]),
            },
          ),
      },
      '@/utils/playback': {
        queueAndPlaySong: async (_, __, value) => calls.actions.push(['play', value]),
      },
      '@/utils/logger': {
        logger: new Proxy(
          {},
          {
            get:
              (_, key) =>
              (...args) =>
                calls.logs.push([key, ...args]),
          },
        ),
      },
      '@/utils/watchUserSession': userSessionWatch,
      '@/utils/userSession': session,
    },
    {
      window: { electron: { recognize: bridge } },
      setInterval: (fn) => {
        const id = ++timerId;
        timers.set(id, fn);
        return id;
      },
      clearInterval: (id) => {
        cleared.push(id);
        timers.delete(id);
      },
    },
    ['window', 'setInterval', 'clearInterval'],
  );
  const scope = vue.effectScope();
  const view = scope.run(() => page.default.setup({}, { expose() {} }));
  let disposed = false;
  const unmount = () => {
    if (disposed) return;
    disposed = true;
    hooks.onBeforeUnmount.forEach((fn) => fn());
    hooks.onUnmounted.forEach((fn) => fn());
    scope.stop();
  };
  t.after(unmount);
  return {
    view,
    user,
    setting,
    playlist,
    calls,
    timers,
    cleared,
    unmount,
    mount: () => hooks.onMounted.forEach((fn) => fn()),
    activate: () => hooks.onActivated.forEach((fn) => fn()),
    deactivate: () => hooks.onDeactivated.forEach((fn) => fn()),
    devices: (fn) => {
      devices = fn;
    },
    start: (fn) => {
      start = fn;
    },
    stop: (fn) => {
      stop = fn;
    },
    cancel: (fn) => {
      cancel = fn;
    },
    recognize: (fn) => {
      recognize = fn;
    },
    fetch: (fn) => {
      fetch = fn;
    },
    add: (fn) => {
      add = fn;
    },
    result: (ids = ['one', 'two']) => {
      view.status.value = 'success';
      view.matches.value = ids.map(match);
      return view.matches.value.map((row) => row.song);
    },
  };
}

for (const invalidation of ['cancel', 'stop', 'destroy', 'crash', 'reload', 'new-start']) {
  for (const outcome of ['grant', 'deny', 'error']) {
    test(`round17: main ${invalidation} invalidates late permission ${outcome}`, async (t) => {
      const f = mainFixture(t),
        pending = deferred(t, true);
      f.permission(() => pending.promise);
      const old = f.begin();
      if (invalidation === 'cancel') f.cancel();
      if (invalidation === 'stop') {
        assert.throws(() => f.end(), /not running/);
      }
      if (invalidation === 'destroy') f.sender.destroy();
      if (invalidation === 'crash') f.sender.emit('render-process-gone', {}, {});
      if (invalidation === 'reload')
        f.sender.emit(
          'did-start-navigation',
          { url: 'url', isSameDocument: false, isMainFrame: true, frame: null },
          'url',
          false,
          true,
        );
      if (invalidation === 'new-start') await f.begin({ source: 'system' });
      if (outcome === 'error') pending.reject(new Error('permission failure'));
      else pending.resolve(outcome === 'grant');
      const status = await old;
      assert.equal(status.running, false);
      assert.equal(f.calls.starts.length, invalidation === 'new-start' ? 1 : 0);
      if (invalidation === 'new-start') assert.deepEqual(f.end(), Buffer.from(bytes));
    });
  }
}
for (const invalidation of ['destroy', 'crash', 'reload']) {
  test(`round17: main ${invalidation} releases active capture and listeners`, async (t) => {
    const f = mainFixture(t);
    await f.begin({ source: 'system' });
    if (invalidation === 'destroy') f.sender.destroy();
    if (invalidation === 'crash') f.sender.emit('render-process-gone', {}, {});
    if (invalidation === 'reload')
      f.sender.emit(
        'did-start-navigation',
        { url: 'url', isSameDocument: false, isMainFrame: true, frame: null },
        'url',
        false,
        true,
      );
    assert.equal(f.calls.cancels, 1);
    for (const key of ['destroyed', 'render-process-gone', 'did-start-navigation'])
      assert.equal(f.sender.listenerCount(key), 0);
    assert.throws(() => f.end(), /not running/);
  });
}
test('round17: other renderer cancellation and stop cannot release current capture', async (t) => {
  const f = mainFixture(t),
    other = new Sender();
  await f.begin({ source: 'system' });
  f.cancel(other);
  assert.equal(f.calls.cancels, 0);
  assert.throws(() => f.end(other), /not running/);
  assert.deepEqual(f.end(), Buffer.from(bytes));
});
test('round17: replacing owner releases old capture without leaking listeners', async (t) => {
  const f = mainFixture(t),
    other = new Sender();
  t.after(() => other.destroy());
  await f.begin({ source: 'system' });
  await f.begin({ source: 'system' }, other);
  assert.equal(f.calls.cancels, 1);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  f.cancel();
  assert.deepEqual(f.end(other), Buffer.from(bytes));
});
test('round17: repeat start/cancel retains no renderer cleanup listeners', async (t) => {
  const f = mainFixture(t);
  for (let i = 0; i < 15; i++) {
    await f.begin({ source: 'system' });
    assert.equal(f.sender.listenerCount('destroyed'), 1);
    f.cancel();
    assert.equal(f.sender.listenerCount('destroyed'), 0);
  }
  assert.equal(f.calls.cancels, 15);
});
test('round17: same-page and subframe navigation preserve active capture', async (t) => {
  const f = mainFixture(t);
  await f.begin({ source: 'system' });
  f.sender.emit(
    'did-start-navigation',
    { url: 'url', isSameDocument: true, isMainFrame: true, frame: null },
    'url',
    true,
    true,
  );
  f.sender.emit(
    'did-start-navigation',
    { url: 'url', isSameDocument: false, isMainFrame: false, frame: null },
    'url',
    false,
    false,
  );
  assert.equal(f.calls.cancels, 0);
  assert.deepEqual(f.end(), Buffer.from(bytes));
});
test('round17: cleanup cancellation failures are caught and leave operation invalid', async (t) => {
  const f = mainFixture(t);
  await f.begin({ source: 'system' });
  f.cancelNative(() => {
    throw new Error('cancel failure');
  });
  assert.doesNotThrow(() => f.sender.destroy());
  assert.equal(f.calls.warnings.length, 1);
  assert.throws(() => f.end(), /not running/);
});
test('round17: actual IPC capture options and PCM result contract are preserved', async (t) => {
  const f = mainFixture(t);
  assert.deepEqual(f.list(), [device('mic')]);
  await f.begin({ source: 'mic', deviceId: '  selected  ' });
  assert.deepEqual(f.calls.starts[0], {
    source: 'input',
    deviceId: 'selected',
    maxBufferDurationMs: 15000,
  });
  assert.deepEqual(f.calls.permissions, ['microphone']);
  assert.deepEqual(f.end(), Buffer.from(bytes));
  assert.deepEqual(f.calls.stops[0], {
    durationMs: 10000,
    sampleRate: 8000,
    channels: 1,
    sampleFormat: 's16le',
  });
});
for (const platform of ['win32', 'linux']) {
  test(`round17: ${platform} microphone start bypasses macOS permission`, async (t) => {
    const f = mainFixture(t, platform);
    await f.begin({ source: 'mic', deviceId: 'default' });
    assert.deepEqual(f.calls.permissions, []);
    assert.deepEqual(f.calls.starts[0], { source: 'input', maxBufferDurationMs: 15000 });
  });
}
test('round17: permission denial remains retryable without retained listeners', async (t) => {
  const f = mainFixture(t);
  f.permission(async () => false);
  await assert.rejects(f.begin(), /权限未授权/);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  f.permission(async () => true);
  assert.equal((await f.begin()).running, true);
});
test('round17: stopped and failed captures release listeners and allow retry', async (t) => {
  const f = mainFixture(t);
  f.start(() => {
    throw new Error('start error');
  });
  await assert.rejects(f.begin({ source: 'system' }), /start error/);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  f.start(() => ({ ...running, running: false, error: 'device failed' }));
  assert.equal((await f.begin({ source: 'system' })).running, false);
  assert.equal(f.calls.cancels, 1);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  f.start(() => running);
  await f.begin({ source: 'system' });
  f.stop(() => {
    throw new Error('no samples');
  });
  assert.throws(() => f.end(), /no samples/);
  assert.equal(f.sender.listenerCount('destroyed'), 0);
});
test('round17: destroyed sender and invalid source do not access native capture', async (t) => {
  const f = mainFixture(t);
  await assert.rejects(f.begin({ source: 'bad' }), /不支持/);
  f.sender.destroy();
  assert.equal((await f.begin()).running, false);
  assert.deepEqual(f.calls.starts, []);
});

for (const stage of ['devices', 'start', 'stop', 'recognize']) {
  for (const invalidation of ['reset', 'deactivate', 'unmount']) {
    for (const outcome of ['success', 'error']) {
      test(`round17: page ${invalidation} ignores late ${stage} ${outcome}`, async (t) => {
        const f = pageFixture(t),
          value =
            stage === 'devices'
              ? [device('old')]
              : stage === 'start'
                ? running
                : stage === 'stop'
                  ? bytes
                  : [match('old')];
        const pending = deferred(t, value);
        let request;
        if (stage === 'devices') {
          f.setting.recognizeAudioSource = 'mic';
          f.devices(() => pending.promise);
          request = f.view.startRecording();
        } else if (stage === 'start') {
          f.start(() => pending.promise);
          request = f.view.startRecording();
        } else {
          await f.view.startRecording();
          if (stage === 'stop') f.stop(() => pending.promise);
          else f.recognize(() => pending.promise);
          request = f.view.stopRecording();
        }
        await flush();
        if (invalidation === 'reset') f.view.resetAndRestart();
        if (invalidation === 'deactivate') {
          f.deactivate();
          f.activate();
        }
        if (invalidation === 'unmount') f.unmount();
        const snapshot = {
          status: f.view.status.value,
          devices: f.view.micDevices.value,
          calls: f.calls.recognition.length,
          logs: f.calls.logs.length,
        };
        if (outcome === 'error') pending.reject(new Error('old failure'));
        else pending.resolve(value);
        await request;
        await flush();
        assert.equal(f.view.status.value, snapshot.status);
        assert.deepEqual(f.view.matches.value, []);
        assert.equal(f.calls.recognition.length, snapshot.calls);
        assert.equal(f.calls.logs.length, snapshot.logs);
        assert.deepEqual(f.view.micDevices.value, snapshot.devices);
        assert.equal(f.timers.size, 0);
      });
    }
  }
}
for (const stage of ['stop', 'recognize']) {
  for (const outcome of ['success', 'error']) {
    test(`round17: newer completed cycle survives old ${stage} ${outcome}`, async (t) => {
      const f = pageFixture(t),
        pending = deferred(t, stage === 'stop' ? bytes : [match('old')]);
      await f.view.startRecording();
      if (stage === 'stop') f.stop(() => pending.promise);
      else f.recognize(() => pending.promise);
      const old = f.view.stopRecording();
      await flush();
      f.view.resetAndRestart();
      f.stop(async () => bytes);
      f.recognize(async () => [match('new')]);
      await f.view.startRecording();
      await f.view.stopRecording();
      if (outcome === 'error') pending.reject(new Error('old failure'));
      else pending.resolve(stage === 'stop' ? bytes : [match('old')]);
      await old;
      assert.equal(f.view.status.value, 'success');
      assert.equal(f.view.matches.value[0].song.id, 'new');
      assert.equal(f.calls.recognition.length, stage === 'stop' ? 1 : 2);
    });
  }
}
for (const outcome of ['success', 'error']) {
  test(`round17: latest device discovery survives old ${outcome}`, async (t) => {
    const f = pageFixture(t),
      pending = deferred(t, [device('old')]);
    f.devices(() => pending.promise);
    const old = f.view.fetchMicDevices();
    f.devices(async () => [device('new')]);
    await f.view.fetchMicDevices();
    if (outcome === 'error') pending.reject(new Error('old device failure'));
    else pending.resolve([device('old')]);
    await old;
    assert.deepEqual(
      f.view.micDevices.value.map((row) => row.value),
      ['default', 'new'],
    );
  });
}
test('round17: microphone selection is captured before device discovery await', async (t) => {
  const f = pageFixture(t),
    pending = deferred(t, []);
  f.setting.recognizeAudioSource = 'mic';
  f.setting.inputDevice = 'selected';
  f.devices(() => pending.promise);
  const start = f.view.startRecording();
  f.setting.inputDevice = 'changed';
  pending.resolve([]);
  await start;
  assert.deepEqual(f.calls.starts[0], { source: 'mic', deviceId: 'selected' });
});
test('round17: pending stop cancellation rejects without unhandled error', async (t) => {
  const f = pageFixture(t),
    pending = deferred(t, running);
  f.start(() => pending.promise);
  f.cancel(async () => {
    throw new Error('native cancel failure');
  });
  const start = f.view.startRecording();
  await f.view.stopRecording();
  pending.resolve(running);
  await start;
  await flush();
  assert.equal(f.view.status.value, 'idle');
  assert.equal(f.calls.logs.filter(([key]) => key === 'debug').length, 1);
});
test('round17: canceled timer callback cannot advance or stop new capture', async (t) => {
  const f = pageFixture(t);
  await f.view.startRecording();
  const old = [...f.timers.values()][0];
  f.view.resetAndRestart();
  await f.view.startRecording();
  for (let i = 0; i < 10; i++) old();
  assert.equal(f.view.recordingSeconds.value, 0);
  assert.equal(f.calls.stops, 0);
  assert.equal(f.timers.size, 1);
});
for (const invalidation of ['deactivate', 'unmount']) {
  test(`round17: ${invalidation} blocks hidden-page starts and song actions`, async (t) => {
    const f = pageFixture(t),
      [current] = f.result();
    if (invalidation === 'deactivate') f.deactivate();
    else f.unmount();
    await f.view.startRecording();
    await f.view.fetchMicDevices();
    await f.view.handlePlay(current);
    f.view.handleFavorite(current);
    f.view.goToDetail(current);
    await f.view.handleAddToPlaylist(current);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(f.calls.devices, 0);
    assert.deepEqual(f.calls.actions, []);
    assert.equal(f.view.showPlaylistDialog.value, false);
  });
}
test('round17: page cancellation reaches real main while permission is pending', async (t) => {
  const main = mainFixture(t),
    permission = deferred(t, true);
  main.permission(() => permission.promise);
  const f = pageFixture(t, {
    listInputDevices: async () => main.list(),
    startAudioCapture: (request) => main.begin(request),
    stopAudioCapture: async () => main.end(),
    cancelAudioCapture: async () => main.cancel(),
  });
  f.setting.recognizeAudioSource = 'mic';
  const old = f.view.startRecording();
  await flush();
  f.view.resetAndRestart();
  f.setting.recognizeAudioSource = 'system';
  await f.view.startRecording();
  permission.resolve(true);
  await old;
  assert.deepEqual(
    main.calls.starts.map((row) => row.source),
    ['system'],
  );
  assert.equal(f.timers.size, 1);
  await f.view.stopRecording();
  assert.equal(f.view.status.value, 'success');
});
test('round17: timer completes at ten seconds with exact PCM and no duplicate stop', async (t) => {
  const f = pageFixture(t);
  await f.view.startRecording();
  const timer = [...f.timers.values()][0];
  for (let i = 0; i < 12; i++) timer();
  await flush();
  assert.equal(f.view.recordingSeconds.value, 10);
  assert.equal(f.calls.stops, 1);
  assert.deepEqual(new Uint8Array(f.calls.recognition[0]), bytes);
  assert.equal(f.view.status.value, 'success');
  assert.equal(f.timers.size, 0);
});
test('round17: anonymous recognition, no match and capture error retry remain usable', async (t) => {
  const f = pageFixture(t);
  f.user.isLoggedIn = false;
  f.user.info = null;
  f.start(async () => {
    throw new Error('no default output device');
  });
  await f.view.startRecording();
  assert.match(f.view.errorMsg.value, /默认输出设备/);
  f.start(async () => running);
  f.recognize(async () => []);
  await f.view.startRecording();
  await f.view.stopRecording();
  assert.match(f.view.errorMsg.value, /未识别到/);
  f.recognize(async () => [match('ok')]);
  await f.view.startRecording();
  await f.view.stopRecording();
  assert.equal(f.view.status.value, 'success');
  await f.view.handlePlay(f.view.matches.value[0].song);
  assert.equal(f.calls.actions[0][0], 'play');
});

const invalidateDialog = (f, kind) => {
  if (kind === 'close') f.view.showPlaylistDialog.value = false;
  if (kind === 'reopen') {
    const [next] = f.result(['new']);
    void f.view.handleAddToPlaylist(next);
  }
  if (kind === 'reset') f.view.resetAndRestart();
  if (kind === 'deactivate') f.deactivate();
  if (kind === 'unmount') f.unmount();
  if (kind === 'revision') f.user.accountRevision++;
  if (kind === 'token') f.user.info.token = 'two';
  if (kind === 'userid') f.user.info.userid = 8;
  if (kind === 'logout') f.user.isLoggedIn = false;
};
for (const kind of [
  'close',
  'reopen',
  'reset',
  'deactivate',
  'unmount',
  'revision',
  'token',
  'userid',
  'logout',
]) {
  for (const outcome of ['added', 'exists', 'failed', 'error']) {
    test(`round17: dialog ${kind} ignores late submission ${outcome}`, async (t) => {
      const f = pageFixture(t),
        pending = deferred(t, 'added'),
        [current] = f.result();
      await f.view.handleAddToPlaylist(current);
      f.add(() => pending.promise);
      const old = f.view.handleSelectPlaylist(3);
      invalidateDialog(f, kind);
      await flush();
      const open = f.view.showPlaylistDialog.value;
      if (outcome === 'error') pending.reject(new Error('old add failure'));
      else pending.resolve(outcome);
      await old;
      assert.deepEqual(f.calls.notices, []);
      assert.equal(f.view.showPlaylistDialog.value, open);
      if (kind === 'reopen') assert.equal(f.view.pendingSong.value.id, 'new');
      else assert.equal(f.view.pendingSong.value, null);
    });
  }
}
for (const outcome of ['success', 'error']) {
  test(`round17: old dialog load ${outcome} does not release reopened busy state`, async (t) => {
    const f = pageFixture(t),
      oldLoad = deferred(t),
      newLoad = deferred(t),
      [one, two] = f.result();
    f.playlist.userPlaylists = [];
    f.fetch(() => oldLoad.promise);
    const old = f.view.handleAddToPlaylist(one);
    f.view.showPlaylistDialog.value = false;
    f.fetch(() => newLoad.promise);
    const next = f.view.handleAddToPlaylist(two);
    if (outcome === 'error') oldLoad.reject(new Error('old load'));
    else oldLoad.resolve();
    await old;
    assert.equal(f.view.isPlaylistLoading.value, true);
    assert.equal(f.view.pendingSong.value.id, 'two');
    assert.deepEqual(f.calls.notices, []);
    newLoad.resolve();
    await next;
    assert.equal(f.view.isPlaylistLoading.value, false);
  });
  test(`round17: old submission ${outcome} does not release new dialog submission`, async (t) => {
    const f = pageFixture(t),
      oldAdd = deferred(t, 'added'),
      newAdd = deferred(t, 'added'),
      [one, two] = f.result();
    await f.view.handleAddToPlaylist(one);
    f.add(() => oldAdd.promise);
    const old = f.view.handleSelectPlaylist(3);
    await f.view.handleAddToPlaylist(two);
    f.add(() => newAdd.promise);
    const next = f.view.handleSelectPlaylist(3);
    if (outcome === 'error') oldAdd.reject(new Error('old add'));
    else oldAdd.resolve('added');
    await old;
    assert.equal(f.view.isPlaylistSubmitting?.value ?? false, true);
    assert.equal(f.view.showPlaylistDialog.value, true);
    newAdd.resolve('added');
    await next;
    assert.equal(f.view.isPlaylistSubmitting?.value ?? false, false);
    assert.equal(f.calls.notices.length, 1);
  });
}
test('round17: double submission sends one captured song and target', async (t) => {
  const f = pageFixture(t),
    pending = deferred(t, 'added'),
    [one] = f.result();
  await f.view.handleAddToPlaylist(one);
  f.add(() => pending.promise);
  const old = f.view.handleSelectPlaylist(3);
  await bounded(f.view.handleSelectPlaylist(3));
  assert.equal(f.calls.adds.length, 1);
  assert.equal(f.calls.adds[0][0], '3');
  assert.equal(f.calls.adds[0][1].id, 'one');
  pending.resolve('added');
  await old;
  assert.equal(f.view.showPlaylistDialog.value, false);
});
test('round17: invisible songs and unavailable playlist targets cannot submit', async (t) => {
  const f = pageFixture(t),
    [one] = f.result();
  await f.view.handleAddToPlaylist(song('one'));
  assert.equal(f.view.showPlaylistDialog.value, false);
  await f.view.handleAddToPlaylist(one);
  await f.view.handleSelectPlaylist('foreign');
  assert.deepEqual(f.calls.adds, []);
  f.user.isLoggedIn = false;
  await f.view.handleSelectPlaylist(3);
  assert.deepEqual(f.calls.adds, []);
});
for (const result of ['added', 'exists', 'failed', 'error']) {
  test(`round17: current dialog ${result} feedback and retry remain correct`, async (t) => {
    const f = pageFixture(t),
      [one] = f.result();
    await f.view.handleAddToPlaylist(one);
    f.add(async () => {
      if (result === 'error') throw new Error('current failure');
      return result;
    });
    await f.view.handleSelectPlaylist(3);
    assert.equal(f.calls.notices.length, 1);
    assert.equal(f.view.showPlaylistDialog.value, result === 'failed' || result === 'error');
    assert.equal(f.view.isPlaylistSubmitting?.value ?? false, false);
    if (result === 'failed' || result === 'error') {
      f.add(async () => 'added');
      await f.view.handleSelectPlaylist(3);
      assert.equal(f.view.showPlaylistDialog.value, false);
    }
  });
}

test('round17: cached completed results remain playable after activation', async (t) => {
  const f = pageFixture(t),
    [one] = f.result();
  f.deactivate();
  f.activate();
  assert.equal(f.view.status.value, 'success');
  await f.view.handlePlay(one);
  f.view.handleFavorite(one);
  f.view.goToDetail(one);
  assert.deepEqual(
    f.calls.actions.map(([kind]) => kind),
    ['play', 'favorite', 'detail'],
  );
});
test('round17: ordinary user profile changes preserve open playlist dialog', async (t) => {
  const f = pageFixture(t),
    [one] = f.result();
  await f.view.handleAddToPlaylist(one);
  f.user.info.nickname = 'changed';
  await flush();
  assert.equal(f.view.showPlaylistDialog.value, true);
  assert.equal(f.view.pendingSong.value.id, 'one');
});
test('round17: stop errors use captured source despite external setting changes', async (t) => {
  const f = pageFixture(t),
    pending = deferred(t, bytes);
  f.setting.recognizeAudioSource = 'mic';
  await f.view.startRecording();
  f.stop(() => pending.promise);
  const old = f.view.stopRecording();
  f.setting.recognizeAudioSource = 'system';
  pending.reject(new Error('no samples'));
  await old;
  assert.match(f.view.errorMsg.value, /麦克风声音/);
});
test('round17: current microphone permission error and device refresh fallback remain usable', async (t) => {
  const f = pageFixture(t);
  f.setting.recognizeAudioSource = 'mic';
  f.start(async () => {
    throw new Error('permission denied');
  });
  await f.view.startRecording();
  assert.match(f.view.errorMsg.value, /麦克风权限/);
  f.devices(async () => {
    throw new Error('device failure');
  });
  await f.view.fetchMicDevices();
  assert.deepEqual(f.view.micDevices.value, [{ label: '系统默认', value: 'default' }]);
  f.start(async () => running);
  await f.view.startRecording();
  assert.equal(f.view.status.value, 'recording');
});
test('round17: new capture deduplicates start and closes pending playlist target', async (t) => {
  const f = pageFixture(t),
    pending = deferred(t, running),
    [one] = f.result();
  await f.view.handleAddToPlaylist(one);
  f.start(() => pending.promise);
  const old = f.view.startRecording();
  await f.view.startRecording();
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.view.showPlaylistDialog.value, false);
  assert.equal(f.view.pendingSong.value, null);
  pending.resolve(running);
  await old;
});
