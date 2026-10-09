import { userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
const compile = (path, mocks = {}, window = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
};
const session = compile('../src/renderer/utils/userSession.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('device operation did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const row = (mid, t = 10) => ({
  mid,
  t,
  appid: 100,
  ver: 200,
  app: 'Android',
  dev: `device ${mid}`,
  mt: `dfid ${mid}`,
});
const response = (rows) => ({ status: 1, data: { li: rows } });
const setup = ({
  get = async () => response([row('remote'), row('local', 1)]),
  kick = async () => ({ status: 1 }),
  ensure = async () => {},
  identity = async () => ({ mid: 'local' }),
} = {}) => {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 1, token: 'first' },
  });
  const { useLoginDeviceStore } = compile(
    '../src/renderer/stores/loginDevices.ts',
    {
      vue,
      pinia,
      '@/api/user': { getLoginDevices: get, kickLoginDevice: kick },
      '@/stores/user': { useUserStore: () => user },
      '@/utils/watchUserSession': userSessionWatch,
      '@/utils/userSession': session,
      '@/stores/device': { useDeviceStore: () => ({ info: { mid: 'local' } }) },
      '@/utils/device': { ensureDevice: ensure },
      '@/utils/logger': { warn() {} },
    },
    { electron: { apiServer: { identity } } },
  );
  return { store: useLoginDeviceStore(pinia.createPinia()), user };
};

test('normalization retains actual kick fields, puts the current device first and orders remote sessions by time', async () => {
  const calls = [];
  const { store } = setup({
    get: async () => response([row('a', 2), row('b', 20), row('local', 1)]),
    kick: async (...args) => {
      calls.push(args);
      return { status: 1 };
    },
  });
  await store.fetchDevices();
  assert.deepEqual(
    store.devices.map((item) => item.id),
    ['local', 'b', 'a'],
  );
  assert.equal(store.currentDevice.id, 'local');
  assert.equal(await store.kickDevice(store.currentDevice), false);
  assert.equal(await store.kickDevice(vue.reactive(store.devices[1])), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], {
    t_mid: 'b',
    t: '20',
    t_appid: '100',
    t_clientver: '200',
    mid: 'b',
    dfid: 'dfid b',
    uuid: '',
  });
});

test('concurrent refresh callers share device initialization and the same list request', async () => {
  const pending = deferred();
  let reads = 0,
    ensures = 0;
  const { store } = setup({
    get: () => {
      reads += 1;
      return pending.promise;
    },
    ensure: async () => {
      ensures += 1;
    },
  });
  const a = store.fetchDevices(),
    b = store.fetchDevices();
  await flush();
  assert.equal(reads, 1);
  assert.equal(ensures, 1);
  pending.resolve(response([]));
  await Promise.all([a, b]);
  assert.equal(store.loaded, true);
  assert.equal(store.loading, false);
});

for (const change of ['reset', 'token', 'revision']) {
  test(`${change} while preparing device identity prevents an old-account list request`, async () => {
    const pending = deferred();
    let reads = 0;
    const { store, user } = setup({
      ensure: () => pending.promise,
      get: async () => {
        reads += 1;
        return response([]);
      },
    });
    const operation = store.fetchDevices();
    if (change === 'reset') store.reset();
    else if (change === 'token') user.info.token = 'new';
    else user.accountRevision += 1;
    pending.resolve();
    await operation;
    assert.equal(reads, 0);
    assert.equal(store.loaded, false);
    assert.equal(store.loading, false);
  });
}

for (const rejected of [false, true]) {
  test(`late ${rejected ? 'failed' : 'successful'} list response cannot overwrite or release a new load`, async () => {
    const old = deferred(),
      fresh = deferred();
    let reads = 0;
    const { store, user } = setup({ get: () => (++reads === 1 ? old.promise : fresh.promise) });
    const a = store.fetchDevices();
    await flush();
    user.info.userid = 2;
    const b = store.fetchDevices();
    await flush();
    if (rejected) old.reject(new Error('old failure'));
    else old.resolve(response([row('old')]));
    await a;
    assert.equal(store.loading, true);
    assert.equal(store.error, '');
    assert.deepEqual(store.devices, []);
    const c = store.fetchDevices();
    assert.equal(reads, 2);
    fresh.resolve(response([row('fresh')]));
    await Promise.all([b, c]);
    assert.deepEqual(
      store.devices.map((item) => item.id),
      ['fresh'],
    );
  });
}

test('a delayed main-process identity read cannot resurrect a reset device list', async () => {
  const pending = deferred();
  const { store } = setup({ identity: () => pending.promise });
  const operation = store.fetchDevices();
  await flush();
  store.reset();
  pending.resolve({ mid: 'local' });
  await operation;
  assert.deepEqual(store.devices, []);
  assert.equal(store.loaded, false);
});

test('renderer identity is used if main identity lookup fails', async () => {
  const { store } = setup({
    identity: async () => {
      throw new Error('IPC failure');
    },
  });
  await store.fetchDevices();
  assert.equal(store.currentDevice.id, 'local');
  assert.equal(store.error, '');
});

test('a confirmation row from a previous account cannot remove a device under the new account', async () => {
  let kicks = 0;
  const { store, user } = setup({
    kick: async () => {
      kicks += 1;
      return { status: 1 };
    },
  });
  await store.fetchDevices();
  const stale = vue.reactive(store.devices.find((item) => item.id === 'remote'));
  user.info.token = 'new';
  await store.fetchDevices();
  assert.equal(await store.kickDevice(stale), false);
  assert.equal(kicks, 0);
  assert.equal(await store.kickDevice(store.devices.find((item) => item.id === 'remote')), true);
  assert.equal(kicks, 1);
});

test('duplicate kick submissions share the pending intent without sending another destructive request', async () => {
  const pending = deferred();
  let kicks = 0;
  const { store } = setup({
    kick: () => {
      kicks += 1;
      return pending.promise;
    },
  });
  await store.fetchDevices();
  const device = store.devices.find((item) => item.id === 'remote');
  const a = store.kickDevice(device);
  assert.equal(await bounded(store.kickDevice(device)), false);
  pending.resolve({ status: 1 });
  assert.equal(await a, true);
  assert.equal(kicks, 1);
});

for (const rejected of [false, true]) {
  test(`old kick ${rejected ? 'failure' : 'success'} cannot refresh a new account or clear its pending operation`, async () => {
    const old = deferred(),
      fresh = deferred();
    let kicks = 0,
      reads = 0;
    const { store, user } = setup({
      kick: () => (++kicks === 1 ? old.promise : fresh.promise),
      get: async () => {
        reads += 1;
        return response([row('remote')]);
      },
    });
    await store.fetchDevices();
    const a = store.kickDevice(store.devices[0]);
    user.accountRevision += 1;
    await store.fetchDevices();
    const b = store.kickDevice(store.devices[0]);
    if (rejected) old.reject(new Error('old failure'));
    else old.resolve({ status: 1 });
    assert.equal(await a, false);
    assert.equal(reads, 2);
    assert.equal(store.kickingId, 'remote');
    assert.equal(store.error, '');
    fresh.resolve({ status: 1 });
    assert.equal(await b, true);
    assert.equal(reads, 3);
  });
}

test('kick request failure is reported without refreshing or discarding the current list', async () => {
  let reads = 0;
  const { store } = setup({
    get: async () => {
      reads += 1;
      return response([row('remote')]);
    },
    kick: async () => {
      throw new Error('network');
    },
  });
  await store.fetchDevices();
  const snapshot = store.devices;
  assert.equal(await store.kickDevice(store.devices[0]), false);
  assert.equal(reads, 1);
  assert.equal(store.devices, snapshot);
  assert.match(store.error, /移除失败/);
  assert.equal(store.kickingId, '');
});

test('post-kick refresh replaces an in-flight pre-kick snapshot', async () => {
  const pending = deferred();
  let reads = 0;
  const { store } = setup({
    get: () =>
      ++reads === 2
        ? pending.promise
        : Promise.resolve(response(reads === 1 ? [row('remote')] : [])),
  });
  await store.fetchDevices();
  const target = store.devices[0];
  const staleRefresh = store.fetchDevices();
  await flush();
  assert.equal(await store.kickDevice(target), true);
  assert.equal(reads, 3);
  assert.deepEqual(store.devices, []);
  pending.resolve(response([row('remote')]));
  await staleRefresh;
  assert.deepEqual(store.devices, []);
  assert.equal(store.loading, false);
});

test('logged-out stores do not request login devices', async () => {
  let reads = 0;
  const { store, user } = setup({
    get: async () => {
      reads += 1;
      return response([]);
    },
  });
  user.isLoggedIn = false;
  await store.fetchDevices();
  assert.equal(reads, 0);
});

test('profile info replacement with the same session preserves devices and row permissions', async () => {
  let kicks = 0;
  const { store, user } = setup({
    kick: async () => {
      kicks++;
      return { status: 1 };
    },
  });
  await store.fetchDevices();
  const devices = store.devices;
  const remote = devices[1];
  user.info = { ...user.info, nickname: 'updated profile' };
  assert.equal(store.devices, devices);
  assert.equal(store.loaded, true);
  assert.equal(await store.kickDevice(remote), true);
  assert.equal(kicks, 1);
  store.$dispose();
});

test('profile info replacement does not cancel an in-flight device load with unchanged credentials', async () => {
  const gate = deferred();
  const { store, user } = setup({ get: () => gate.promise });
  const pending = store.fetchDevices();
  await flush();
  user.info = { ...user.info, nickname: 'updated profile' };
  assert.equal(store.loading, true);
  gate.resolve(response([row('local'), row('remote')]));
  await pending;
  assert.equal(store.devices.length, 2);
  assert.equal(store.loaded, true);
  store.$dispose();
});

test('device list retains the original null and missing-list handling', async () => {
  let body = response(null);
  const { store } = setup({ get: async () => body });
  await store.fetchDevices();
  assert.deepEqual(store.devices, []);
  assert.equal(store.error, '');
  body = { status: 1, data: {} };
  await store.fetchDevices();
  assert.deepEqual(store.devices, []);
  assert.equal(store.error, '');
});
