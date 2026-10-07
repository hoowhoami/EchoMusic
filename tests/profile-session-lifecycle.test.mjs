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
const code = transformSync(compileScript(descriptor, { id: 'profile-lifecycle' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
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
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((done) => setImmediate(done));
const list = (id) => ({
  status: 1,
  data: { lists: id === undefined ? [] : [{ userid: id, nickname: `user ${id}`, is_friend: 0 }] },
});
const history = (id, text = `message ${id}`, uid = '123') => ({
  errcode: 0,
  list: [{ msgid: id, tag: 'chat:123_7', uid, type: 201, message: { alert: text, msgtype: 201 } }],
});

function fixture(t) {
  const calls = [],
    notices = [],
    errors = [],
    readers = [],
    timers = new Map(),
    unmounts = [];
  let timerId = 0;
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'one', nickname: 'me', extendsInfo: { detail: {} } },
    fetchUserInfo: () => new Promise(() => {}),
    fetchGradeInfo: async () => {},
    updateProfile: async () => {},
    updateAvatar: async () => ({ reviewPending: true }),
  });
  const devices = { fetchDevices: async () => {}, kickDevice: async () => true };
  const api = {};
  for (const [name, tab] of Object.entries({
    getUserFollow: 'follow',
    getUserFriends: 'friends',
    getUserFans: 'fans',
    getUserVisitors: 'visitors',
  })) {
    api[name] = async () => {
      calls.push(tab);
      return list(tab === 'fans' ? 123 : undefined);
    };
  }
  api.getUserFollowMessages = async (params) => {
    calls.push(['history', params]);
    return { errcode: 0, list: [] };
  };
  api.sendUserFollowChat = async (params) => {
    calls.push(['send', params]);
    return { errcode: 0, data: { msgid: 'sent', tag: 'chat:123_7' } };
  };
  api.addUserFollow = async (params) => {
    calls.push(['add', params]);
    return { status: 1 };
  };
  api.deleteUserFollow = async (params) => {
    calls.push(['del', params]);
    return { status: 1 };
  };
  const deps = {
    vue: { ...vue, onMounted() {}, onUnmounted: (fn) => unmounts.push(fn) },
    'vue-router': { useRouter: () => ({ push() {} }) },
    '@/utils/userSession': sessionModule.exports,
    '@/stores/user': { useUserStore: () => user },
    '@/stores/loginDevices': { useLoginDeviceStore: () => devices },
    '@/stores/toast': {
      useToastStore: () =>
        Object.fromEntries(
          ['success', 'info', 'warning', 'danger'].map((type) => [
            type,
            (message) => notices.push([type, message]),
          ]),
        ),
    },
    '@/utils/logger': { error: (...args) => errors.push(args) },
    '@/api/user': api,
    '@/utils/cover': { normalizeCoverUrl: (x) => x },
    '@/icons': {},
    '../../shared/birthday': { formatBirthdayForInput: (x) => x ?? '' },
    '../../shared/profileStats': {
      getGradeProgress: () => ({}),
      formatListeningDuration: () => '',
      formatAccountAge: () => '',
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'FileReader', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    mod,
    mod.exports,
    {
      setTimeout: (fn) => {
        const id = ++timerId;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    class {
      constructor() {
        readers.push(this);
      }
      readAsDataURL() {}
    },
  );
  const scope = vue.effectScope();
  const view = scope.run(() => mod.exports.default.setup({}, { expose() {} }));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unmounts.forEach((fn) => fn());
    scope.stop();
    timers.clear();
  };
  t.after(stop);
  const target = (id = 123) =>
    view.mapSocialUser({ userid: id, nickname: `user ${id}`, is_friend: 0 }, 0, 'fans');
  const avatar = () =>
    view.handleAvatarSelected({
      target: { files: [{ type: 'image/png', name: 'a.png', size: 100 }], value: 'a.png' },
    });
  const finishRead = (index) => {
    readers[index].result = 'data:image/png;base64,abc';
    readers[index].onload();
  };
  return {
    view,
    user,
    devices,
    api,
    calls,
    notices,
    errors,
    timers,
    readers,
    stop,
    target,
    avatar,
    finishRead,
  };
}

for (const signature of ['签'.repeat(100), '']) {
  test(`profile saves ${signature ? 'a 100-character signature' : 'an empty signature'}`, async (t) => {
    const f = fixture(t);
    f.user.info.extendsInfo.detail.descri = '旧签名';
    f.view.openProfileEditor();
    f.view.profileForm.signature = signature;
    const writes = [];
    f.user.updateProfile = async (params) => writes.push(params);
    await f.view.saveProfile();
    assert.deepEqual(writes, [{ signature }]);
    assert.equal(f.view.showProfileEditor.value, false);
  });
}

test('profile rejects an oversized signature without changing the draft or sending a write', async (t) => {
  const f = fixture(t);
  f.view.openProfileEditor();
  const signature = '签'.repeat(101);
  f.view.profileForm.signature = signature;
  const writes = [];
  f.user.updateProfile = async (params) => writes.push(params);
  await f.view.saveProfile();
  assert.deepEqual(writes, []);
  assert.deepEqual(f.notices, [['warning', '个性签名最多 100 个字符']]);
  assert.equal(f.view.profileForm.signature, signature);
  assert.equal(f.view.showProfileEditor.value, true);
});

for (const [name, change] of Object.entries({
  token: (u) => {
    u.info.token = 'two';
  },
  revision: (u) => {
    u.accountRevision++;
  },
  user: (u) => {
    u.info.userid = 8;
  },
  logout: (u) => {
    u.isLoggedIn = false;
  },
})) {
  test(`profile state and old row actions are invalidated synchronously on ${name}`, async (t) => {
    const f = fixture(t);
    await f.view.loadSocialList('fans');
    const item = f.view.socialUsers.fans[0];
    f.view.openSocialChat(item);
    await flush();
    f.view.socialDrawerOpen.value = true;
    f.view.showProfileEditor.value = true;
    f.view.profileForm.nickname = 'old';
    f.view.showKickConfirm.value = true;
    f.view.socialChatDraft.value = 'old draft';
    change(f.user);
    assert.equal(f.view.socialUsers.fans.length, 0);
    assert.equal(f.view.socialLoaded.fans, false);
    assert.equal(f.view.socialChatTarget.value, null);
    assert.equal(f.view.socialChatDraft.value, '');
    assert.equal(f.view.showProfileEditor.value, false);
    assert.equal(f.view.profileForm.nickname, '');
    assert.equal(f.view.showKickConfirm.value, false);
    assert.equal(f.view.socialDrawerOpen.value, false);
    const count = f.calls.length;
    await f.view.toggleSocialFollow(item);
    f.view.openSocialChat(item);
    assert.equal(f.calls.length, count);
  });
}

test('ordinary user info replacement preserves profile dialogs and does not reload the session', async (t) => {
  const f = fixture(t);
  await f.view.loadSocialList('fans');
  f.view.showProfileEditor.value = true;
  f.view.profileForm.nickname = 'editing';
  let loads = 0;
  f.user.fetchUserInfo = async () => {
    loads++;
  };
  f.user.info = { ...f.user.info, nickname: 'updated' };
  await flush();
  assert.equal(f.view.socialUsers.fans.length, 1);
  assert.equal(f.view.socialLoaded.fans, true);
  assert.equal(f.view.showProfileEditor.value, true);
  assert.equal(f.view.profileForm.nickname, 'editing');
  assert.equal(loads, 0);
});

test('account patch resets synchronously and batches one reload with the new identity', async (t) => {
  const f = fixture(t);
  let loads = 0,
    grades = 0,
    devices = 0;
  f.user.fetchUserInfo = async () => {
    loads++;
    f.user.info = { ...f.user.info, nickname: 'new me' };
  };
  f.user.fetchGradeInfo = async () => {
    grades++;
  };
  f.devices.fetchDevices = async () => {
    devices++;
  };
  f.user.info = { ...f.user.info, userid: 8, token: 'two' };
  f.user.accountRevision++;
  await flush();
  await flush();
  assert.deepEqual([loads, grades, devices], [1, 1, 1]);
  assert.equal(f.view.isLoading.value, false);
  assert.deepEqual(f.calls, ['follow']);
});

test('old list completion cannot release or delete the new account list flight', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.getUserFans = () => (++calls === 1 ? old.promise : fresh.promise);
  const first = f.view.loadSocialList('fans');
  f.user.accountRevision++;
  const second = f.view.loadSocialList('fans');
  old.resolve(list(123));
  assert.equal(await first, false);
  assert.equal(f.view.socialLoading.fans, true);
  const third = f.view.loadSocialList('fans');
  assert.equal(calls, 2);
  fresh.resolve(list(456));
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(f.view.socialUsers.fans[0].userId, '456');
  assert.equal(f.view.socialLoading.fans, false);
});

test('forced refresh waiting on an old request stops after session invalidation', async (t) => {
  const f = fixture(t),
    gate = deferred();
  let calls = 0;
  f.api.getUserFans = () => {
    calls++;
    return gate.promise;
  };
  const first = f.view.loadSocialList('fans'),
    forced = f.view.loadSocialList('fans', true);
  f.user.info.token = 'two';
  gate.resolve(list(123));
  assert.deepEqual(await Promise.all([first, forced]), [false, false]);
  assert.equal(calls, 1);
  assert.equal(f.view.socialUsers.fans.length, 0);
});

const emptyFriendsResponse = {
  data: { total: 0, list_ver: 2, lists: {} },
  status: 1,
  error_code: 0,
};

for (const hasCachedFriends of [false, true]) {
  test(`real empty friends response succeeds with cached friends=${hasCachedFriends}`, async (t) => {
    const f = fixture(t);
    if (hasCachedFriends) {
      f.api.getUserFriends = async () => list(123);
      assert.equal(await f.view.loadSocialList('friends'), true);
      assert.equal(f.view.socialUsers.friends.length, 1);
    }
    f.api.getUserFriends = async () => structuredClone(emptyFriendsResponse);
    assert.equal(await f.view.loadSocialList('friends', true), true);
    assert.deepEqual(f.view.socialUsers.friends, []);
    assert.equal(f.view.socialLoaded.friends, true);
    assert.equal(f.view.socialLoading.friends, false);
    assert.equal(f.view.socialError.friends, '');
    assert.equal(f.view.friendCount.value, 0);
    assert.deepEqual(f.errors, []);
  });
}

for (const fails of [false, true]) {
  test(`old follow ${fails ? 'failure' : 'success'} cannot notify or refresh the new account`, async (t) => {
    const f = fixture(t),
      gate = deferred();
    f.api.addUserFollow = () => gate.promise;
    const pending = f.view.toggleSocialFollow(f.target());
    f.user.accountRevision++;
    if (fails) gate.reject(new Error('old failure'));
    else gate.resolve({ status: 1 });
    await pending;
    assert.deepEqual(f.notices, []);
    assert.deepEqual(f.calls, []);
    assert.equal(f.view.socialFollowPending.size, 0);
  });
}

test('old follow finally does not release a new operation for the same user', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.addUserFollow = () => (++calls === 1 ? old.promise : fresh.promise);
  const first = f.view.toggleSocialFollow(f.target());
  f.user.accountRevision++;
  const second = f.view.toggleSocialFollow(f.target());
  old.resolve({ status: 1 });
  await first;
  assert.equal(f.view.socialFollowPending.has('123'), true);
  await f.view.toggleSocialFollow(f.target());
  assert.equal(calls, 2);
  fresh.resolve({ status: 1 });
  await second;
  assert.equal(f.view.socialFollowPending.size, 0);
});

test('follow success immediately updates every list and count before slow refreshes finish', async (t) => {
  const f = fixture(t),
    gate = deferred();
  await Promise.all(['follow', 'friends', 'fans'].map((tab) => f.view.loadSocialList(tab)));
  const item = f.view.socialUsers.fans[0];
  for (const name of ['getUserFollow', 'getUserFriends', 'getUserFans']) {
    f.api[name] = () => gate.promise;
  }
  const pending = f.view.toggleSocialFollow(item);
  await flush();
  assert.equal(item.friendAction, 'unfollow');
  assert.equal(f.view.followCount.value, 1);
  assert.equal(f.view.friendCount.value, 1);
  assert.equal(f.view.socialUsers.friends[0].meta, '互相关注');
  assert.equal(f.view.socialFollowPending.has('123'), false);
  gate.resolve(list()); // 上游列表暂时还未同步写操作。
  await pending;
  assert.equal(f.view.followCount.value, 1);
  assert.equal(f.view.friendCount.value, 1);
});

test('unfollow immediately removes follow and friend rows and updates the fan button despite stale responses', async (t) => {
  const f = fixture(t),
    gate = deferred();
  for (const name of ['getUserFollow', 'getUserFriends', 'getUserFans']) {
    f.api[name] = async () => ({ status: 1, data: { lists: [{ userid: 123, is_friend: 1 }] } });
  }
  await Promise.all(['follow', 'friends', 'fans'].map((tab) => f.view.loadSocialList(tab)));
  const item = f.view.socialUsers.friends[0];
  for (const name of ['getUserFollow', 'getUserFriends', 'getUserFans']) {
    f.api[name] = () => gate.promise;
  }
  const pending = f.view.toggleSocialFollow(item);
  await flush();
  assert.equal(f.view.followCount.value, 0);
  assert.equal(f.view.friendCount.value, 0);
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'follow');
  gate.resolve({ status: 1, data: { lists: [{ userid: 123, is_friend: 1 }] } });
  await pending;
  assert.equal(f.view.followCount.value, 0);
  assert.equal(f.view.friendCount.value, 0);
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'follow');
});

test('confirmed relationship survives a list started before the write, then yields to synchronized server state', async (t) => {
  const f = fixture(t),
    old = deferred();
  await f.view.loadSocialList('fans');
  f.api.getUserFollow = () => old.promise;
  const oldList = f.view.loadSocialList('follow');
  const pending = f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  await flush();
  f.api.getUserFollow = async () => list(123);
  f.api.getUserFriends = async () => list(123);
  f.api.getUserFans = async () => ({ status: 1, data: { lists: [{ userid: 123, is_friend: 1 }] } });
  old.resolve(list());
  await oldList;
  assert.equal(f.view.followCount.value, 1);
  await pending;
  await Promise.all(['friends', 'fans'].map((tab) => f.view.loadSocialList(tab, true)));
  assert.equal(f.view.confirmedFollows.size, 0);
  f.api.getUserFollow = async () => list();
  await f.view.loadSocialList('follow', true);
  assert.equal(f.view.followCount.value, 0);
});

test('write failure leaves relationships and counters unchanged and allows retry', async (t) => {
  const f = fixture(t);
  await f.view.loadSocialList('fans');
  f.api.addUserFollow = async () => ({ status: 0, error_code: 123 });
  await f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'follow');
  assert.equal(f.view.followCount.value, 0);
  assert.equal(f.view.friendCount.value, 0);
  assert.equal(f.view.confirmedFollows.size, 0);
  assert.equal(f.view.socialFollowPending.size, 0);
  assert.deepEqual(f.calls, ['fans']);
  assert.equal(f.notices[0][0], 'warning');
});

test('already-followed response repairs the local button and list without claiming a new follow', async (t) => {
  const f = fixture(t);
  await f.view.loadSocialList('fans');
  f.api.addUserFollow = async () => ({ status: 0, error_code: 31702 });
  await f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'unfollow');
  assert.equal(f.view.socialUsers.follow[0].userId, '123');
  assert.deepEqual(f.notices, [['info', '已关注该用户']]);
});

test('an earlier refresh cannot unlock a subsequent opposite write for the same user', async (t) => {
  const f = fixture(t),
    refresh = deferred(),
    write = deferred();
  await f.view.loadSocialList('fans');
  for (const name of ['getUserFollow', 'getUserFriends', 'getUserFans']) {
    f.api[name] = () => refresh.promise.then(() => (name === 'getUserFans' ? list(123) : list()));
  }
  const first = f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  await flush();
  f.api.deleteUserFollow = () => write.promise;
  const second = f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  assert.equal(f.view.socialFollowPending.has('123'), true);
  refresh.resolve(list());
  await first;
  assert.equal(f.view.socialFollowPending.has('123'), true);
  write.resolve({ status: 1 });
  await second;
  assert.equal(f.view.socialFollowPending.has('123'), false);
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'follow');
  assert.equal(f.view.followCount.value, 0);
  assert.equal(f.view.friendCount.value, 0);
});

test('unloaded counts update immediately and failed refreshes preserve the successful relationship', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.user.info.extendsInfo.detail = { follows: 5, friends: 2 };
  await f.view.loadSocialList('fans');
  for (const name of ['getUserFollow', 'getUserFriends', 'getUserFans']) {
    f.api[name] = () => gate.promise;
  }
  const pending = f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  await flush();
  assert.equal(f.view.followCount.value, 6);
  assert.equal(f.view.friendCount.value, 3);
  gate.reject(new Error('refresh failed'));
  await pending;
  assert.equal(f.view.socialUsers.fans[0].friendAction, 'unfollow');
  assert.equal(f.view.followCount.value, 6);
  assert.equal(f.view.friendCount.value, 3);
  assert.deepEqual(
    f.notices.map(([type]) => type),
    ['success', 'warning'],
  );
});

test('the write response determines mutual friendship when following', async (t) => {
  const f = fixture(t);
  await f.view.loadSocialList('fans');
  f.api.addUserFollow = async () => ({ status: 1, data: { is_friend: 0 } });
  await f.view.toggleSocialFollow(f.view.socialUsers.fans[0]);
  assert.equal(f.view.followCount.value, 1);
  assert.equal(f.view.friendCount.value, 0);
});

test('rapid chat switching starts the new history and ignores old response and finally', async (t) => {
  const f = fixture(t),
    a = deferred(),
    b = deferred();
  const ids = [];
  f.api.getUserFollowMessages = ({ id }) => {
    ids.push(id);
    return id === '123' ? a.promise : b.promise;
  };
  f.view.openSocialChat(f.target());
  f.view.openSocialChat(f.target(456));
  assert.deepEqual(ids, ['123', '456']);
  a.resolve(history('old'));
  await flush();
  assert.equal(f.view.socialChatMessages.value.length, 0);
  assert.equal(f.view.socialChatLoading.value, true);
  b.resolve(history('new', 'hello', '456'));
  await flush();
  assert.equal(f.view.socialChatMessages.value[0].text, 'hello');
  assert.equal(f.view.socialChatMessages.value[0].nickname, 'user 456');
  assert.equal(f.view.socialChatLoading.value, false);
});

test('closing and reopening the same chat rejects the old history by generation', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.getUserFollowMessages = () => (++calls === 1 ? old.promise : fresh.promise);
  const item = f.target();
  f.view.openSocialChat(item);
  f.view.closeSocialChat();
  f.view.openSocialChat(item);
  old.resolve(history('old'));
  await flush();
  assert.equal(f.view.socialChatMessages.value.length, 0);
  fresh.resolve(history('new'));
  await flush();
  assert.equal(f.view.socialChatMessages.value[0].id, 'new');
});

test('latest chat refresh wins even if the older history finishes last', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.getUserFollowMessages = () => (++calls === 1 ? old.promise : fresh.promise);
  f.view.openSocialChat(f.target());
  const pending = f.view.loadChatMessages();
  fresh.resolve(history('new'));
  await pending;
  old.resolve(history('old'));
  await flush();
  assert.equal(f.view.socialChatMessages.value[0].id, 'new');
});

test('history request failure preserves current messages and shows the server error', async (t) => {
  const f = fixture(t);
  f.api.getUserFollowMessages = async () => history('existing');
  f.view.openSocialChat(f.target());
  await flush();
  const messages = f.view.socialChatMessages.value;
  f.api.getUserFollowMessages = async () => {
    throw new Error('请求被拒绝');
  };
  await f.view.loadChatMessages();
  assert.equal(f.view.socialChatMessages.value, messages);
  assert.deepEqual(f.notices, [['warning', '请求被拒绝']]);
  assert.equal(f.view.socialChatLoading.value, false);
});

test('late history failure after closing a chat does not warn or refill state', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.api.getUserFollowMessages = () => gate.promise;
  f.view.openSocialChat(f.target());
  f.view.closeSocialChat();
  gate.reject(new Error('late failure'));
  await flush();
  assert.deepEqual(f.notices, []);
  assert.equal(f.view.socialChatLoading.value, false);
});

test('old send cannot append to another chat or release its sending state', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.sendUserFollowChat = () => (++calls === 1 ? old.promise : fresh.promise);
  f.view.openSocialChat(f.target());
  await flush();
  f.view.socialChatDraft.value = 'old';
  const first = f.view.sendSocialChat();
  f.view.openSocialChat(f.target(456));
  await flush();
  f.view.socialChatDraft.value = 'new';
  const second = f.view.sendSocialChat();
  old.resolve({ errcode: 0, data: { msgid: 'old', tag: 'old-tag' } });
  await first;
  assert.equal(f.view.socialChatSending.value, true);
  assert.equal(f.view.socialChatDraft.value, 'new');
  assert.equal(f.view.socialChatMessages.value.length, 0);
  assert.deepEqual(f.notices, []);
  fresh.resolve({ errcode: 0, data: { msgid: 'new', tag: 'new-tag' } });
  await second;
  assert.equal(f.view.socialChatMessages.value[0].text, 'new');
  assert.equal(f.view.socialChatTag.value, 'new-tag');
});

for (const payload of [
  { status: 0, errcode: 3006, error: '需要对方关注或回复' },
  { status: 1, errcode: 3006, error: '被拒绝' },
  {},
]) {
  test(`rejected chat send keeps the draft and never claims success: ${JSON.stringify(payload)}`, async (t) => {
    const f = fixture(t);
    f.view.openSocialChat(f.target());
    await flush();
    f.view.socialChatDraft.value = 'hello';
    f.api.sendUserFollowChat = async () => {
      throw Object.assign(new Error('发送失败'), { response: { body: payload } });
    };
    await f.view.sendSocialChat();
    assert.equal(f.view.socialChatDraft.value, 'hello');
    assert.equal(f.view.socialChatMessages.value.length, 0);
    assert.equal(f.view.socialChatSending.value, false);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0][0], 'warning');
    assert.equal(f.timers.size, 0);
  });
}

test('successful send retains server tag, direction, and a newly edited draft', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.view.openSocialChat(f.target());
  await flush();
  f.api.sendUserFollowChat = async (params) => {
    f.calls.push(['send', params]);
    return gate.promise;
  };
  f.view.socialChatDraft.value = 'first';
  const pending = f.view.sendSocialChat();
  f.view.socialChatDraft.value = 'next';
  gate.resolve({ errcode: 0, data: { msgid: 'sent', tag: 'chat:123_7' }, tip_content: '仍有额度' });
  await pending;
  assert.equal(f.view.socialChatDraft.value, 'next');
  assert.equal(f.view.socialChatMessages.value[0].isSelf, true);
  assert.equal(f.view.socialChatTag.value, 'chat:123_7');
  assert.deepEqual(f.calls.at(-1), ['send', { tuid: '123', alert: 'first', nickname: 'me' }]);
  f.api.sendUserFollowChat = async (params) => {
    f.calls.push(['send', params]);
    return { status: 1, errcode: 0, data: { msgid: 'second' } };
  };
  await f.view.sendSocialChat();
  assert.deepEqual(f.calls.at(-1), ['send', { tag: 'chat:123_7', alert: 'next', nickname: 'me' }]);
  assert.equal(f.timers.size, 1);
  assert.equal(f.view.socialChatDraft.value, '');
  assert.deepEqual(
    f.view.socialChatMessages.value.map((m) => m.id),
    ['sent', 'second'],
  );
});

test('pre-send history cannot remove the just-sent optimistic message', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.api.getUserFollowMessages = () => gate.promise;
  f.view.openSocialChat(f.target());
  f.view.socialChatDraft.value = 'new';
  await f.view.sendSocialChat();
  gate.resolve({ errcode: 0, list: [] });
  await flush();
  assert.equal(f.view.socialChatMessages.value[0].id, 'sent');
  assert.equal(f.view.socialChatLoading.value, false);
});

for (const action of ['close', 'drawer', 'account', 'unmount']) {
  test(`delayed post-send refresh is cancelled on ${action}`, async (t) => {
    const f = fixture(t);
    f.view.socialDrawerOpen.value = true;
    f.view.openSocialChat(f.target());
    await flush();
    f.view.socialChatDraft.value = 'hello';
    await f.view.sendSocialChat();
    const callback = [...f.timers.values()][0];
    assert.ok(callback);
    if (action === 'close') f.view.closeSocialChat();
    if (action === 'drawer') f.view.socialDrawerOpen.value = false;
    if (action === 'account') f.user.accountRevision++;
    if (action === 'unmount') f.stop();
    assert.equal(f.timers.size, 0);
    const count = f.calls.length;
    callback();
    await flush();
    assert.equal(f.calls.length, count);
    assert.equal(f.view.socialChatTarget.value, null);
  });
}

test('old profile load does not start new-account follow-up requests or release new loading', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let loads = 0,
    grades = 0;
  f.user.fetchUserInfo = () => (++loads === 1 ? old.promise : fresh.promise);
  f.user.fetchGradeInfo = async () => {
    grades++;
  };
  const first = f.view.loadData();
  f.user.accountRevision++;
  await flush();
  assert.equal(loads, 2);
  old.resolve();
  await first;
  assert.equal(f.view.isLoading.value, true);
  assert.equal(grades, 0);
  assert.deepEqual(f.calls, []);
  fresh.resolve();
  await flush();
  assert.equal(grades, 1);
  assert.equal(f.view.isLoading.value, false);
});

test('old profile save result cannot close a new editor or release a new save', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred();
  let saves = 0;
  f.user.updateProfile = () => (++saves === 1 ? old.promise : fresh.promise);
  f.view.openProfileEditor();
  f.view.profileForm.nickname = 'first';
  const first = f.view.saveProfile();
  f.user.accountRevision++;
  f.view.openProfileEditor();
  f.view.profileForm.nickname = 'second';
  const second = f.view.saveProfile();
  old.resolve();
  await first;
  assert.equal(f.view.isSavingProfile.value, true);
  assert.equal(f.view.showProfileEditor.value, true);
  assert.deepEqual(f.notices, []);
  fresh.resolve();
  await second;
  assert.equal(f.view.showProfileEditor.value, false);
  assert.equal(f.view.isSavingProfile.value, false);
});

test('avatar file read cannot dispatch to a new session or release a new upload', async (t) => {
  const f = fixture(t);
  let uploads = 0;
  f.user.updateAvatar = async () => {
    uploads++;
    return { reviewPending: true };
  };
  const old = f.avatar();
  f.user.accountRevision++;
  const fresh = f.avatar();
  f.finishRead(0);
  await old;
  assert.equal(uploads, 0);
  assert.equal(f.view.isUploadingAvatar.value, true);
  f.finishRead(1);
  await fresh;
  assert.equal(uploads, 1);
  assert.equal(f.view.isUploadingAvatar.value, false);
});

test('avatar response after session change cannot show success', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.user.updateAvatar = () => gate.promise;
  const pending = f.avatar();
  f.finishRead(0);
  await flush();
  f.user.accountRevision++;
  gate.resolve({ reviewPending: true });
  await pending;
  assert.deepEqual(f.notices, []);
});

test('old grade finally and device confirmation do not dismiss new account dialogs', async (t) => {
  const f = fixture(t),
    old = deferred(),
    fresh = deferred(),
    kick = deferred();
  let grades = 0;
  f.user.fetchGradeInfo = () => (++grades === 1 ? old.promise : fresh.promise);
  f.devices.kickDevice = () => kick.promise;
  const grade = f.view.openGradeDetail();
  f.view.requestKickDevice({ id: 'old', canKick: true });
  const removing = f.view.confirmKickDevice();
  f.user.accountRevision++;
  const nextGrade = f.view.openGradeDetail();
  f.view.requestKickDevice({ id: 'new', canKick: true });
  old.resolve();
  kick.resolve(true);
  await Promise.all([grade, removing]);
  assert.equal(f.view.gradeLoading.value, true);
  assert.equal(f.view.showKickConfirm.value, true);
  assert.equal(f.view.pendingKickDevice.value.id, 'new');
  fresh.resolve();
  await nextGrade;
});

test('unmount invalidates late list, profile load and avatar file read', async (t) => {
  const f = fixture(t),
    gate = deferred(),
    profile = deferred();
  let uploads = 0,
    grades = 0;
  f.api.getUserFans = () => gate.promise;
  f.user.fetchUserInfo = () => profile.promise;
  f.user.updateAvatar = async () => {
    uploads++;
    return {};
  };
  f.user.fetchGradeInfo = async () => {
    grades++;
  };
  const listRequest = f.view.loadSocialList('fans'),
    load = f.view.loadData(),
    avatar = f.avatar();
  f.stop();
  gate.resolve(list(123));
  profile.resolve();
  f.finishRead(0);
  await Promise.all([listRequest, load, avatar]);
  assert.equal(f.view.socialUsers.fans.length, 0);
  assert.equal(uploads, 0);
  assert.equal(grades, 0);
  assert.deepEqual(f.notices, []);
});

test('synchronous session change inside a fetcher cannot install its old list flight', async (t) => {
  const f = fixture(t),
    old = deferred();
  let reads = 0;
  f.api.getUserFans = () => {
    reads++;
    if (reads === 1) {
      f.user.accountRevision++;
      return old.promise;
    }
    return Promise.resolve(list(456));
  };
  const first = f.view.loadSocialList('fans');
  const second = f.view.loadSocialList('fans');
  await flush();
  assert.equal(reads, 2);
  assert.equal(await second, true);
  old.resolve(list(123));
  assert.equal(await first, false);
  assert.equal(f.view.socialUsers.fans[0].userId, '456');
});

test('normal history keeps chronological order, actual uid direction, and the server conversation tag', async (t) => {
  const f = fixture(t);
  f.api.getUserFollowMessages = async () => ({
    errcode: 0,
    list: [
      { msgid: 'new', tag: 'chat:123_7', uid: 7, message: { msgtype: 201, alert: 'mine' } },
      { msgid: 'old', tag: 'chat:123_7', uid: 123, message: { msgtype: 201, alert: 'theirs' } },
    ],
  });
  f.view.openSocialChat(f.target());
  await flush();
  assert.deepEqual(
    f.view.socialChatMessages.value.map((m) => [m.id, m.text, m.isSelf, m.nickname]),
    [
      ['old', 'theirs', false, 'user 123'],
      ['new', 'mine', true, 'me'],
    ],
  );
  f.view.socialChatDraft.value = 'reply';
  await f.view.sendSocialChat();
  assert.deepEqual(f.calls.at(-1), ['send', { tag: 'chat:123_7', alert: 'reply', nickname: 'me' }]);
});

test('duplicate sends and over-limit drafts do not dispatch extra messages', async (t) => {
  const f = fixture(t),
    gate = deferred();
  let writes = 0;
  f.view.openSocialChat(f.target());
  await flush();
  f.api.sendUserFollowChat = () => {
    writes++;
    return gate.promise;
  };
  f.view.socialChatDraft.value = 'x'.repeat(201);
  await f.view.sendSocialChat();
  assert.equal(writes, 0);
  f.view.socialChatDraft.value = 'valid';
  const first = f.view.sendSocialChat();
  await f.view.sendSocialChat();
  assert.equal(writes, 1);
  gate.resolve({ errcode: 0, data: { msgid: 'one' } });
  await first;
  assert.equal(f.view.socialChatMessages.value.length, 1);
});
