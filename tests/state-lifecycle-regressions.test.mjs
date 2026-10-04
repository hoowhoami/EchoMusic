import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync, buildSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
const { createPinia, setActivePinia } = pinia;

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function compile(file, mocks = {}, window = {}) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'setTimeout', 'clearTimeout', code)(
    (name) =>
      name in mocks ? mocks[name] : name === 'pinia' ? pinia : name === 'vue' ? vue : require(name),
    mod,
    mod.exports,
    window,
    window.setTimeout ?? setTimeout,
    window.clearTimeout ?? clearTimeout,
  );
  return mod.exports;
}
const logger = { warn() {}, error() {}, info() {} };
function fakeTimers() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn) {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    run() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}

function cloudFixture() {
  const user = { isLoggedIn: true, info: { userid: 1, token: 'A' }, accountRevision: 0 };
  const pending = [];
  const api = compile('../src/renderer/services/cloudAudioIndex.ts', {
    '@/api/user': {
      getUserCloud: (page) => {
        const task = deferred();
        pending.push({ ...task, page });
        return task.promise;
      },
    },
    '@/stores/user': { useUserStore: () => user },
    '@/utils/mappers': { mapCloudSong: (value) => value },
    '@/utils/logger': logger,
  });
  const response = (hash, count = 1) => ({
    data: { list_count: count, list: [{ cloudAudioSource: { hash } }] },
  });
  return { user, pending, api, response };
}
test('cloud index invalidation discards old pages and cannot release a newer refresh', async () => {
  const s = cloudFixture();
  const old = s.api.refreshCloudAudioIndex();
  s.api.clearCloudAudioIndex();
  const fresh = s.api.refreshCloudAudioIndex();
  s.pending[0].resolve(s.response('old'));
  await old;
  const joined = s.api.refreshCloudAudioIndex(true);
  assert.equal(s.pending.length, 2, 'stale finally must preserve the new in-flight request');
  s.pending[1].resolve(s.response('new'));
  await Promise.all([fresh, joined]);
  assert.equal(await s.api.getCloudAudioSourceForSong({ hash: 'old' }), null);
  assert.equal((await s.api.getCloudAudioSourceForSong({ hash: 'NEW' })).hash, 'new');
});
test('cloud index switches account without sharing or publishing the previous account request', async () => {
  const s = cloudFixture();
  const old = s.api.getCloudAudioSourceForSong({ hash: 'old' });
  s.user.info = { userid: 2, token: 'B' };
  const fresh = s.api.refreshCloudAudioIndex();
  assert.equal(s.pending.length, 2);
  s.pending[1].resolve(s.response('new'));
  await fresh;
  s.pending[0].resolve(s.response('old'));
  assert.equal(await old, null);
  assert.equal((await s.api.getCloudAudioSourceForSong({ hash: 'new' })).hash, 'new');
});
test('logging out while cloud index is loading leaves the cache empty', async () => {
  const s = cloudFixture();
  const old = s.api.refreshCloudAudioIndex();
  s.user.isLoggedIn = false;
  s.api.clearCloudAudioIndex();
  s.pending[0].resolve(s.response('old'));
  await old;
  assert.equal(await s.api.getCloudAudioSourceForSong({ hash: 'old' }), null);
});

test('cloud refresh stops paging after invalidation even when a response has more pages', async () => {
  const s = cloudFixture();
  const old = s.api.refreshCloudAudioIndex();
  s.api.clearCloudAudioIndex();
  s.pending[0].resolve(s.response('old', 200));
  await flush();
  assert.equal(s.pending.length, 1);
  await old;
});

test('cloud requests from an earlier login cannot share work with a new session of the same user', async () => {
  const s = cloudFixture();
  const old = s.api.refreshCloudAudioIndex();
  s.user.accountRevision += 2;
  const fresh = s.api.refreshCloudAudioIndex();
  assert.equal(s.pending.length, 2);
  s.pending[0].resolve(s.response('old'));
  await old;
  s.pending[1].resolve(s.response('new'));
  await fresh;
  assert.equal(await s.api.getCloudAudioSourceForSong({ hash: 'old' }), null);
});

const mapperCode = buildSync({
  entryPoints: [new URL('../src/renderer/utils/mappers/user.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const mapper = { exports: {} };
new Function('module', 'exports', mapperCode)(mapper, mapper.exports);
function userFixture() {
  setActivePinia(createPinia());
  const pending = {};
  const api = Object.fromEntries(
    [
      'getUserDetail',
      'getUserVipDetail',
      'getUserGradeInfo',
      'getUserFollow',
      'updateUserProfile',
      'updateUserAvatar',
    ].map((key) => [
      key,
      () => {
        const task = deferred();
        (pending[key] ??= []).push(task);
        return task.promise;
      },
    ]),
  );
  const { useUserStore } = compile('../src/renderer/stores/user.ts', {
    '@/api/user': api,
    '@/utils/mappers': mapper.exports,
    '@/utils/logger': logger,
    '@/stores/listenReport': { useListenReportStore: () => ({ reset() {} }) },
  });
  const store = useUserStore();
  store.setUserInfo({
    userid: 1,
    token: 'A',
    nickname: 'Alice',
    extendsInfo: { vip: { private: 'A' } },
  });
  return { store, pending };
}
const ok = (data) => ({ status: 1, data });
test('late detail and VIP responses cannot restore a logged-out session', async () => {
  const s = userFixture();
  const task = s.store.fetchUserInfoOnce();
  s.store.logout();
  s.pending.getUserDetail[0].resolve(ok({ userid: 1, nickname: 'old' }));
  s.pending.getUserVipDetail[0].resolve(ok({ level: 9 }));
  await task;
  assert.equal(s.store.info, null);
  assert.equal(s.store.hasFetchedUserInfo, false);
});
test('old account completion cannot unlock a new account refresh or patch profile mutations', async () => {
  const s = userFixture();
  const old = s.store.fetchUserInfoOnce();
  const update = s.store.updateProfile({ nickname: 'old' });
  const avatar = s.store.updateAvatar('data:image/png;base64,AA==');
  const grade = s.store.fetchGradeInfo();
  const follows = s.store.fetchFollowedArtists();
  s.store.setUserInfo({ userid: 2, token: 'B', nickname: 'Bob' });
  const fresh = s.store.fetchUserInfoOnce();
  assert.equal(s.pending.getUserDetail.length, 2);
  s.pending.getUserDetail[0].resolve(ok({ userid: 1, nickname: 'old' }));
  s.pending.getUserVipDetail[0].resolve(ok({ level: 9 }));
  s.pending.updateUserProfile[0].resolve(ok({}));
  s.pending.updateUserAvatar[0].resolve({ pic: 'old-avatar' });
  s.pending.getUserGradeInfo[0].resolve(ok({ d_sec: 999 }));
  s.pending.getUserFollow[0].resolve(ok({ lists: [{ singerid: 10 }] }));
  await Promise.all([old, update, avatar, grade, follows]);
  assert.equal(s.store.info.nickname, 'Bob');
  assert.equal(s.store.info.pic, undefined);
  assert.equal(s.store.info.extendsInfo, undefined);
  assert.equal(s.store.followedArtistIds.size, 0);
  assert.equal(s.store.hasFetchedUserInfo, false);
  assert.equal(s.store.isFetchingUserInfo, true);
  s.pending.getUserDetail[1].resolve(ok({ nickname: 'Robert' }));
  s.pending.getUserVipDetail[1].resolve(ok({ level: 1 }));
  await fresh;
  assert.equal(s.store.info.nickname, 'Robert');
  assert.equal(s.store.hasFetchedUserInfo, true);
});
test('failed user fetch remains retryable and a detail success survives VIP failure', async () => {
  const s = userFixture();
  const first = s.store.fetchUserInfoOnce();
  s.pending.getUserDetail[0].reject(new Error('offline'));
  s.pending.getUserVipDetail[0].reject(new Error('offline'));
  await first;
  assert.equal(s.store.hasFetchedUserInfo, false);
  const second = s.store.fetchUserInfoOnce();
  assert.equal(s.pending.getUserDetail.length, 2);
  s.pending.getUserDetail[1].resolve(ok({ nickname: 'updated' }));
  s.pending.getUserVipDetail[1].reject(new Error('VIP unavailable'));
  await second;
  assert.equal(s.store.info.nickname, 'updated');
  assert.equal(s.store.hasFetchedUserInfo, true);
});
test('login to another account does not inherit personal data from the prior account', () => {
  const s = userFixture();
  s.store.handleLoginSuccess({ userid: 2, token: 'B', nickname: 'Bob' });
  assert.equal(s.store.info.userid, 2);
  assert.equal(s.store.info.extendsInfo.vip, undefined);
});

function historyFixture() {
  setActivePinia(createPinia());
  const clock = fakeTimers();
  const load = deferred();
  const writes = [];
  const storage = {
    getHistoryEntries: () => load.promise,
    recordHistoryPlay: () => {
      const task = deferred();
      writes.push(task);
      return task.promise;
    },
    removeHistoryEntries: async () => ({}),
    clearHistory: async () => ({}),
  };
  const store = compile(
    '../src/renderer/stores/historyStore.ts',
    { '@/utils/logger': logger },
    { ...clock, electron: { storage } },
  ).useHistoryStore();
  return { store, clock, load, writes };
}
const entry = (id) => ({ song: { id }, historyKey: `${id}:1`, lastPlayedAt: 1, playCount: 1 });
test('rapid individual and batch history removals remove every marked entry', async () => {
  const s = historyFixture();
  const load = s.store.hydrate();
  s.load.resolve(['a', 'b', 'c', 'd'].map(entry));
  await load;
  s.store.removeEntry('a:1');
  s.store.removeEntries(['b:1', 'c:1']);
  s.clock.run();
  assert.deepEqual(
    s.store.entries.map((item) => item.song.id),
    ['d'],
  );
  assert.equal(s.store.removingKeys.size, 0);
});
test('clearing history invalidates loading and record responses', async () => {
  const s = historyFixture();
  const load = s.store.hydrate();
  s.store.clear();
  s.load.resolve([entry('old')]);
  await load;
  assert.equal(s.store.entries.length, 0);
  const play = s.store.recordPlay({ id: 'old' });
  await flush();
  s.store.clear();
  s.writes[0].resolve(entry('old'));
  await play;
  assert.equal(s.store.entries.length, 0);
});
test('a new playback cancels older promotion so it cannot reorder the latest song', async () => {
  const s = historyFixture();
  const load = s.store.hydrate();
  s.load.resolve(['a', 'b'].map(entry));
  await load;
  const b = s.store.recordPlay({ id: 'b' });
  await flush();
  s.writes[0].resolve({ ...entry('b'), playCount: 11 });
  await b;
  const a = s.store.recordPlay({ id: 'a' });
  await flush();
  s.writes[1].resolve(entry('a'));
  await a;
  s.clock.run();
  assert.equal(s.store.entries[0].song.id, 'a');
  assert.equal(s.store.promotedKey, null);
  assert.equal(s.store.entries.find((item) => item.song.id === 'b').playCount, 11);
});

function persistFixture() {
  const clock = fakeTimers();
  const load = deferred();
  const calls = [];
  const writes = [];
  const storage = {
    getKv: () => load.promise,
    setKv: (key, value) => {
      const task = deferred();
      calls.push(['set', structuredClone(value)]);
      writes.push(task);
      return task.promise;
    },
    deleteKv: async () => {
      calls.push(['delete']);
    },
  };
  let subscriber;
  const store = {
    $id: 'example',
    $state: { count: 0, transient: false },
    $patch(patch) {
      Object.assign(this.$state, patch);
    },
    $subscribe(fn) {
      subscriber = fn;
    },
  };
  const api = compile(
    '../src/renderer/stores/sqlitePersist.ts',
    {
      '../../shared/storePersistence': { getStorePersistenceKey: (id) => id },
      '@/utils/logger': logger,
    },
    { ...clock, electron: { storage } },
  );
  const plugin = api.sqlitePersistPlugin({ store, options: { persist: { pick: ['count'] } } });
  return {
    clock,
    load,
    calls,
    writes,
    store,
    plugin,
    api,
    change(count) {
      store.$state.count = count;
      subscriber({}, store.$state);
    },
  };
}
test('persistence filters hydration using current config and handles read failures', async () => {
  const s = persistFixture();
  s.load.resolve({ count: 1, transient: true });
  await s.api.waitForSqlitePersistHydration();
  assert.equal(s.store.$state.transient, false);
  const failed = persistFixture();
  failed.load.reject(new Error('read error'));
  await failed.api.waitForSqlitePersistHydration();
  failed.change(2);
  failed.clock.run();
  await flush();
  assert.equal(failed.calls.length, 1);
  failed.writes[0].resolve();
  await flush();
});
test('failed writes stay retryable and later snapshots are serialized', async () => {
  const s = persistFixture();
  s.load.resolve(null);
  await s.api.waitForSqlitePersistHydration();
  s.change(1);
  s.clock.run();
  await flush();
  s.change(2);
  s.clock.run();
  await flush();
  assert.equal(s.calls.length, 1, 'second write waits for first completion');
  s.writes[0].resolve();
  await flush();
  assert.equal(s.calls.length, 2);
  s.writes[1].reject(new Error('disk full'));
  await flush();
  s.change(2);
  s.clock.run();
  await flush();
  assert.equal(s.calls.length, 3, 'same state retries after failure');
  s.writes[2].resolve();
  await flush();
  s.change(2);
  s.clock.run();
  await flush();
  assert.equal(s.calls.length, 3);
});
test('clearing persistence waits for older writes before deleting', async () => {
  const s = persistFixture();
  s.load.resolve(null);
  await s.api.waitForSqlitePersistHydration();
  s.change(1);
  s.clock.run();
  await flush();
  const clear = s.plugin.$clearPersistedState();
  await flush();
  assert.equal(s.calls.length, 1);
  s.writes[0].resolve();
  await clear;
  assert.deepEqual(
    s.calls.map(([type]) => type),
    ['set', 'delete'],
  );
});
