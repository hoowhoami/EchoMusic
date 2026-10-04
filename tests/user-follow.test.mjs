import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const source = readFileSync(new URL('../src/renderer/views/Profile.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const profileCode = transformSync(
  compileScript(descriptor, { id: 'profile-follow-test' }).content,
  {
    loader: 'ts',
    format: 'cjs',
  },
).code;
const sessionModule = { exports: {} };
new Function(
  'module',
  'exports',
  transformSync(
    readFileSync(new URL('../src/renderer/utils/userSession.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code,
)(sessionModule, sessionModule.exports);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await vue.nextTick();
};
const fan = (id = 123, isFriend = 0) => ({ userid: id, nickname: 'Fan', is_friend: isFriend });
const list = (lists) => ({ status: 1, data: { lists } });
const failure = (body) => Object.assign(new Error('API Error: 502'), { response: { body } });

function fixture() {
  const calls = [];
  const notifications = [];
  const records = { follow: [{ userid: 0 }], friends: [], fans: [fan()], visitors: [] };
  const user = vue.reactive({
    isLoggedIn: true,
    info: { userid: 7, extendsInfo: { detail: { follows: 9, friends: 5 } } },
  });
  const api = {};
  for (const [name, tab] of Object.entries({
    getUserFollow: 'follow',
    getUserFriends: 'friends',
    getUserFans: 'fans',
    getUserVisitors: 'visitors',
  })) {
    api[name] = async () => {
      calls.push(tab);
      return list(records[tab]);
    };
  }
  api.addUserFollow = async (params) => {
    calls.push(['add', params]);
    records.follow = [{ userid: 0 }, fan()];
    records.friends = [fan()];
    records.fans = [fan(123, 1)];
    return { status: 1, error_code: 0, data: { is_friend: 1 } };
  };
  api.deleteUserFollow = async (params) => {
    calls.push(['del', params]);
    records.follow = [{ userid: 0 }];
    records.friends = [];
    records.fans = [fan()];
    return { status: 1, error_code: 0 };
  };
  const deps = {
    vue: { ...vue, onMounted() {}, onUnmounted() {} },
    '@/utils/userSession': sessionModule.exports,
    'vue-router': { useRouter: () => ({}) },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/loginDevices': { useLoginDeviceStore: () => ({}) },
    '@/stores/toast': {
      useToastStore: () =>
        Object.fromEntries(
          ['success', 'info', 'warning'].map((name) => [
            name,
            (message) => notifications.push([name, message]),
          ]),
        ),
    },
    '@/utils/logger': { error() {} },
    '@/api/user': api,
    '@/utils/cover': { normalizeCoverUrl: (value) => value },
    '@/icons': {},
    '../../shared/birthday': {},
    '../../shared/profileStats': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', profileCode)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    mod,
    mod.exports,
  );
  const scope = vue.effectScope();
  const view = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  return { view, api, calls, notifications, records, user, stop: () => scope.stop() };
}

test('user follow wrappers send POST tuid/source to the new social modules, not artist APIs', async () => {
  const code = transformSync(
    readFileSync(new URL('../src/renderer/api/user.ts', import.meta.url), 'utf8'),
    {
      loader: 'ts',
      format: 'cjs',
    },
  ).code;
  const calls = [];
  const encrypted = [];
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    () => ({
      post: async (url, data) => {
        calls.push({ url, data });
        const server = { exports: {} };
        const filename = url === '/user/follow/add' ? 'user_follow_add' : 'user_follow_del';
        new Function(
          'require',
          'module',
          'exports',
          readFileSync(new URL(`../server/module/${filename}.js`, import.meta.url), 'utf8'),
        )(
          (name) => {
            if (name === '../util/config.json') return {};
            assert.equal(name, '../util');
            return {
              appid: 1005,
              clientver: 12345,
              signParamsKey: () => 'key',
              cryptoRSAEncrypt: (value) => {
                encrypted.push(value);
                return 'encrypted';
              },
            };
          },
          server,
          server.exports,
        );
        return server.exports(
          { ...data, cookie: { userid: '7', token: 'test-token' } },
          async (config) => config,
        );
      },
    }),
    mod,
    mod.exports,
  );
  const added = await mod.exports.addUserFollow({ tuid: '123' });
  const removed = await mod.exports.deleteUserFollow({ tuid: 123, source: 23 });
  assert.deepEqual(calls, [
    { url: '/user/follow/add', data: { tuid: '123' } },
    { url: '/user/follow/del', data: { tuid: 123, source: 23 } },
  ]);
  assert.equal(added.url, '/v2/follow');
  assert.equal(removed.url, '/v1/unfollow');
  assert.equal(added.method, 'POST');
  assert.equal(removed.method, 'POST');
  assert.equal(added.data.userid, 7);
  assert.equal(added.data.source, 0);
  assert.equal(removed.data.source, 23);
  assert.deepEqual(
    encrypted.map(({ t_userid, token }) => ({ t_userid, token })),
    [
      { t_userid: 123, token: 'test-token' },
      { t_userid: 123, token: 'test-token' },
    ],
  );
});

test('buttons use confirmed relationships and never send singer IDs, invalid IDs or self IDs', async () => {
  const f = fixture();
  try {
    assert.equal(f.view.mapSocialUser(fan(), 0, 'fans').friendAction, 'follow');
    assert.equal(f.view.mapSocialUser(fan(123, 1), 0, 'fans').friendAction, 'unfollow');
    assert.equal(f.view.mapSocialUser(fan(), 0, 'follow').friendAction, 'unfollow');
    assert.equal(f.view.mapSocialUser(fan(), 0, 'friends').friendAction, 'unfollow');
    for (const record of [
      { userid: 0 },
      { userid: 7 },
      { singerid: 123 },
      { id: 123 },
      { userid: -1 },
    ]) {
      const mapped = f.view.mapSocialUser(record, 0, 'fans');
      assert.equal(mapped.friendAction, '');
      await f.view.toggleSocialFollow(mapped);
    }
    assert.equal(f.view.mapSocialUser({ userid: 123 }, 0, 'fans').friendAction, '');
    assert.equal(f.view.mapSocialUser(fan(), 0, 'visitors').friendAction, '');
    assert.deepEqual(f.calls, []);
    assert.match(descriptor.template.content, /@click\.stop\.prevent="toggleSocialFollow\(item\)"/);
    assert.match(
      descriptor.template.content,
      /:loading="socialFollowPending\.has\(item\.userId\)"/,
    );
  } finally {
    f.stop();
  }
});

test('follow and unfollow refresh all relationship lists and filtered counts without clearing existing rows', async () => {
  const f = fixture();
  try {
    await f.view.loadSocialList('fans');
    const original = f.view.socialUsers.fans;
    const gate = deferred();
    const add = f.api.addUserFollow;
    f.api.addUserFollow = async (params) => {
      await gate.promise;
      return add(params);
    };
    const following = f.view.toggleSocialFollow(original[0]);
    assert.equal(f.view.socialFollowPending.has('123'), true);
    assert.equal(f.view.socialUsers.fans, original);
    gate.resolve();
    await following;
    assert.deepEqual(f.calls, ['fans', ['add', { tuid: '123' }], 'follow', 'friends', 'fans']);
    assert.equal(f.view.socialUsers.fans[0].friendAction, 'unfollow');
    assert.equal(f.view.followCount.value, 1);
    assert.equal(f.view.friendCount.value, 1);
    assert.equal(f.view.socialFollowPending.size, 0);
    await f.view.toggleSocialFollow(f.view.socialUsers.follow[0]);
    assert.equal(f.view.socialUsers.fans[0].friendAction, 'follow');
    assert.equal(f.view.followCount.value, 0);
    assert.equal(f.view.friendCount.value, 0);
    assert.deepEqual(f.calls.at(-4), ['del', { tuid: '123' }]);
  } finally {
    f.stop();
  }
});

test('duplicate clicks across tabs are ignored through both the write and refresh phases', async () => {
  const f = fixture();
  try {
    const gate = deferred();
    const refresh = deferred();
    let writes = 0;
    f.api.addUserFollow = async () => {
      writes++;
      await gate.promise;
      return { status: 1 };
    };
    f.api.getUserFollow = () => refresh.promise;
    const item = f.view.mapSocialUser(fan(), 0, 'fans');
    const operation = f.view.toggleSocialFollow(item);
    await f.view.toggleSocialFollow(item);
    assert.equal(writes, 1);
    gate.resolve();
    await flush();
    await f.view.toggleSocialFollow(item);
    assert.equal(writes, 1);
    assert.equal(f.view.socialFollowPending.has('123'), true);
    refresh.resolve(list([]));
    await operation;
    assert.equal(f.view.socialFollowPending.size, 0);
  } finally {
    f.stop();
  }
});

test('business or transport failures preserve state and expose the upstream error', async () => {
  for (const result of ['reject', 'status-zero', 'nonzero-code']) {
    const f = fixture();
    try {
      await f.view.loadSocialList('fans');
      const original = f.view.socialUsers.fans;
      f.api.addUserFollow = async () => {
        if (result === 'reject') throw failure({ error_code: 2001, error: '参数检查错误' });
        return {
          status: result === 'status-zero' ? 0 : 1,
          error_code: 2001,
          errmsg: '参数检查错误',
        };
      };
      await f.view.toggleSocialFollow(original[0]);
      assert.equal(f.view.socialUsers.fans, original);
      assert.equal(original[0].friendAction, 'follow');
      assert.deepEqual(f.calls, ['fans']);
      assert.deepEqual(f.notifications, [['warning', '参数检查错误']]);
      assert.equal(f.view.socialFollowPending.size, 0);
    } finally {
      f.stop();
    }
  }
});

test('already-followed error 31702 refreshes authoritative state, but is not success for unfollow', async () => {
  const f = fixture();
  try {
    f.records.fans = [fan(123, 1)];
    f.records.follow = [fan()];
    f.api.addUserFollow = async () => {
      throw failure({ error_code: 31702 });
    };
    await f.view.toggleSocialFollow(f.view.mapSocialUser(fan(), 0, 'fans'));
    assert.deepEqual(f.calls, ['follow', 'friends', 'fans']);
    assert.equal(f.view.socialUsers.fans[0].friendAction, 'unfollow');
    assert.deepEqual(f.notifications, [['info', '已关注该用户']]);
    f.api.deleteUserFollow = async () => {
      throw failure({ error_code: 31702 });
    };
    await f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
    assert.equal(f.notifications.at(-1)[0], 'warning');
    assert.equal(f.calls.length, 3);
  } finally {
    f.stop();
  }
});

test('post-write refresh waits for pre-write list requests and fetches again', async () => {
  const f = fixture();
  try {
    const old = deferred();
    let reads = 0;
    f.api.getUserFollow = async () => {
      reads++;
      return reads === 1 ? old.promise : list([fan()]);
    };
    const loading = f.view.loadSocialList('follow');
    const operation = f.view.toggleSocialFollow(f.view.mapSocialUser(fan(), 0, 'fans'));
    await flush();
    assert.equal(reads, 1);
    old.resolve(list([{ userid: 0 }]));
    await loading;
    await operation;
    assert.equal(reads, 2);
    assert.equal(f.view.followCount.value, 1);
    assert.equal(f.view.socialUsers.follow[0].userId, '123');
  } finally {
    f.stop();
  }
});

test('refresh failure does not report a successful write as failed or discard cached lists', async () => {
  const f = fixture();
  try {
    await f.view.loadSocialList('fans');
    const original = f.view.socialUsers.fans;
    f.api.getUserFans = async () => {
      throw new Error('network unavailable');
    };
    await f.view.toggleSocialFollow(original[0]);
    assert.equal(f.view.socialUsers.fans, original);
    assert.equal(f.view.followCount.value, 1);
    assert.deepEqual(f.notifications, [
      ['success', '关注成功'],
      ['warning', '关系已更新，部分列表刷新失败，请重试'],
    ]);
    assert.equal(f.view.socialFollowPending.size, 0);
  } finally {
    f.stop();
  }
});

test('logged-out sessions do not write relationships', async () => {
  const f = fixture();
  try {
    f.user.isLoggedIn = false;
    await f.view.toggleSocialFollow(f.view.mapSocialUser(fan(), 0, 'fans'));
    assert.deepEqual(f.calls, []);
  } finally {
    f.stop();
  }
});
