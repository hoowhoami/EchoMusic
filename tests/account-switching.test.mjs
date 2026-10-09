import { userIdentity } from './helpers/user-identity.mjs';
import { userSession, userSessionWatch } from './helpers/user-session.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as pinia from 'pinia';

const compile = (path, mocks = {}, window = {}, script = false, dev = false) => {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  if (script) source = compileScript(parse(source).descriptor, { id: 'account-switching' }).content;
  const code = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    define: { 'import.meta.env.DEV': String(dev) },
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
};
const object = compile('../src/shared/object.ts');
const mapperShared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': { normalizeCoverUrl: (value) => value },
  '../../../shared/object': object,
});
const mapper = compile('../src/renderer/utils/mappers/user.ts', { './shared': mapperShared });
const profileStats = compile('../src/shared/profileStats.ts');
const logger = { info() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const account = (userid, token = `token-${userid}`) => ({
  userid,
  token,
  nickname: `用户 ${userid}`,
  pic: `avatar-${userid}`,
  t1: `t1-${userid}`,
});
const fixture = (api = {}) => {
  let resets = 0;
  const reads = [];
  const { useUserStore } = compile('../src/renderer/stores/user.ts', {
    pinia,
    '@/api/user': {
      getUserGradeInfo: () => api.grade?.() ?? { status: 0 },
      getUserDetail: () => {
        reads.push('detail');
        return api.detail?.() ?? { status: 0 };
      },
      getUserInfo: () => {
        reads.push('info');
        return api.info?.() ?? { status: 0 };
      },
      getUserVipDetail: () => {
        reads.push('vip');
        return api.vip?.() ?? { status: 0 };
      },
    },
    '@/stores/listenReport': {
      useListenReportStore: () => ({
        reset() {
          resets++;
        },
      }),
    },
    '@/utils/mappers': mapper,
    '@/utils/userIdentity': userIdentity,
    '@/utils/logger': logger,
  });
  return { user: useUserStore(pinia.createPinia()), reads, resets: () => resets };
};

test('A to B to A restores credentials, reloads profile and only saves credential summaries', async () => {
  const { user, reads, resets } = fixture();
  user.setUserInfo({
    ...account(1),
    vip: { secret: true },
    password: 'never-save',
    mobile: 'private',
  });
  assert.deepEqual(user.savedAccounts, []);
  user.login(account(2));
  assert.equal(user.info.userid, 2);
  assert.equal(user.savedAccounts.length, 2);
  for (const saved of user.savedAccounts) {
    assert.deepEqual(Object.keys(saved).sort(), [
      'expires',
      'lastUsedAt',
      'nickname',
      'pic',
      't1',
      'token',
      'userid',
    ]);
  }
  await flush();
  const revision = user.accountRevision;
  user.switchAccount(1);
  assert.equal(user.info.token, 'token-1');
  assert.equal(user.info.t1, 't1-1');
  assert.equal(user.info.vip, undefined);
  assert.ok(user.accountRevision > revision);
  assert.deepEqual(reads, ['detail', 'vip', 'info', 'detail', 'vip', 'info']);
  assert.equal(resets(), 2);
  await flush();
});

test('same-account relogin replaces credentials and starts a fresh session without retaining old t1 or VIP', async () => {
  const { user } = fixture();
  user.login({ ...account(1), vip: { membership: 'old' } });
  await flush();
  const revision = user.accountRevision;
  user.login({ userid: 1, token: 'renewed' });
  assert.equal(user.savedAccounts.length, 1);
  assert.equal(user.savedAccounts[0].token, 'renewed');
  assert.equal(user.info.t1, undefined);
  assert.equal(user.info.vip, undefined);
  assert.ok(user.accountRevision > revision);
  await flush();
  const refreshedRevision = user.accountRevision;
  user.login({ userid: 1, token: 'renewed' });
  assert.ok(user.accountRevision > refreshedRevision);
  await flush();
});

test('invalid login and missing saved account leave the original session untouched', () => {
  const { user, reads, resets } = fixture();
  user.setUserInfo(account(1));
  const before = JSON.stringify(user.$state);
  for (const payload of [{ token: 'bad' }, { userid: 2 }, { userid: -1, token: 'bad' }]) {
    assert.throws(() => user.login(payload), /登录信息不完整/);
  }
  assert.throws(() => user.switchAccount(2), /账号已移除/);
  assert.equal(JSON.stringify(user.$state), before);
  assert.deepEqual(reads, []);
  assert.equal(resets(), 0);
});

test('late old-account profile and VIP results cannot overwrite the new session or saved summaries', async () => {
  const detail = deferred(),
    vip = deferred();
  let first = true;
  const { user } = fixture({
    detail: () =>
      first ? detail.promise : { status: 1, data: { userid: 2, nickname: '最新昵称' } },
    vip: () => (first ? vip.promise : { status: 1, data: { membership: 'B' } }),
  });
  user.login(account(1));
  first = false;
  user.login(account(2));
  await flush();
  detail.resolve({ status: 1, data: { userid: 1, nickname: '迟到的 A' } });
  vip.resolve({ status: 1, data: { membership: 'A' } });
  await flush();
  assert.equal(user.info.userid, 2);
  assert.equal(user.info.nickname, '最新昵称');
  assert.equal(user.info.extendsInfo.vip.membership, 'B');
  assert.equal(user.savedAccounts.find((entry) => entry.userid === 2).nickname, '最新昵称');
  assert.equal(user.hasFetchedUserInfo, true);
});

test('inactive account removal preserves login; current removal is blocked and explicit logout discards its credentials', async () => {
  const { user } = fixture();
  user.login(account(1));
  await flush();
  user.login(account(2));
  await flush();
  user.forgetAccount(1);
  assert.equal(user.info.userid, 2);
  assert.deepEqual(
    user.savedAccounts.map((entry) => entry.userid),
    [2],
  );
  user.login(account(1));
  await flush();
  user.logout();
  assert.equal(user.isLoggedIn, false);
  assert.equal(user.info, null);
  assert.deepEqual(
    user.savedAccounts.map((entry) => entry.userid),
    [2],
  );
  user.switchAccount(2);
  assert.equal(user.isLoggedIn, true);
  await flush();
  const revision = user.accountRevision;
  assert.throws(() => user.forgetAccount(2), /当前登录账号不能移除/);
  assert.equal(user.info.userid, 2);
  assert.equal(user.isLoggedIn, true);
  assert.equal(user.accountRevision, revision);
  assert.deepEqual(
    user.savedAccounts.map((entry) => entry.userid),
    [2],
  );
  user.logout();
  assert.equal(user.info, null);
  assert.deepEqual(user.savedAccounts, []);
});

test('selecting the current account does not reload or invalidate the current session', async () => {
  const { user, reads } = fixture();
  user.login(account(1));
  await flush();
  const revision = user.accountRevision;
  user.switchAccount(1);
  assert.equal(user.accountRevision, revision);
  assert.equal(reads.length, 3);
});

test('normal SQLite persistence restores the current account and saved credentials after restart', async (t) => {
  const values = new Map();
  const window = {
    setTimeout,
    clearTimeout,
    electron: {
      storage: {
        getKv: async (key) => values.get(key),
        setKv: async (key, value) => values.set(key, JSON.parse(JSON.stringify(value))),
        deleteKv: async (key) => values.delete(key),
      },
    },
  };
  const persistence = compile(
    '../src/renderer/stores/sqlitePersist.ts',
    {
      '../../shared/storePersistence': compile('../src/shared/storePersistence.ts'),
      '@/utils/logger': logger,
    },
    window,
  );
  const { user } = fixture();
  const options = { persist: { pick: ['info', 'isLoggedIn', 'savedAccounts'] } };
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  scope.run(() => persistence.sqlitePersistPlugin({ store: user, options }));
  await persistence.waitForSqlitePersistHydration();
  user.setUserInfo(account(1));
  user.login(account(2));
  user.updateSavedAccountListeningSeconds(1, 90060);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const restarted = fixture().user;
  scope.run(() => persistence.sqlitePersistPlugin({ store: restarted, options }));
  await persistence.waitForSqlitePersistHydration();
  assert.equal(restarted.info.userid, 2);
  assert.equal(restarted.isLoggedIn, true);
  assert.deepEqual(restarted.savedAccounts.map((entry) => entry.userid).sort(), [1, 2]);
  assert.equal(restarted.savedAccounts.find((entry) => entry.userid === 1).listeningSeconds, 90060);
  restarted.switchAccount(1);
  assert.equal(restarted.info.token, 'token-1');
  await new Promise((resolve) => setTimeout(resolve, 180));
});

test('every login method excludes current user auth while device registration and account APIs keep their contracts', async () => {
  const calls = [];
  const api = compile('../src/renderer/api/user.ts', {
    '@/utils/request': {
      get: async (path, config) => {
        calls.push({ path, config });
      },
    },
  });
  for (const [name, args] of [
    ['getLoginQrKey', []],
    ['createLoginQr', ['key']],
    ['checkLoginQr', ['key']],
    ['createQqLoginQr', []],
    ['checkQqLoginQr', [{ cookie: 'qq-session' }]],
    ['sendSmsCode', ['13800138000']],
    ['loginBySms', ['13800138000', '1234', 2]],
    ['loginByPassword', ['user', 'password']],
    ['createWxLogin', []],
    ['checkWxLogin', ['uuid']],
    ['loginByOpenPlat', ['code']],
  ])
    await api[name](...args);
  assert.ok(calls.every((call) => call.config.skipUserAuth === true));
  assert.equal(calls.find((call) => call.path === '/login/cellphone').config.params.userid, 2);
  calls.length = 0;
  await api.getUserDetail();
  assert.equal(calls[0].config, undefined);
  await api.registerDevice();
  assert.equal(calls[1].config.headers['X-Skip-Auth'], '1');
  await api.getUserGradeInfo();
  assert.equal(calls[2].config, undefined);
  await api.getUserGradeInfo(123);
  assert.deepEqual(calls[3], {
    path: '/user/grade/info',
    config: { params: { userid: 123 }, skipUserAuth: true, skipKugouVerification: true },
  });
});

test('account dialog displays the current unsaved account, sorts and deduplicates saved accounts and requires removal confirmation', (t) => {
  const calls = [];
  const { user } = fixture();
  user.setUserInfo(account(1));
  user.rememberAccount(account(2));
  user.rememberAccount(account(3));
  user.savedAccounts.find((entry) => entry.userid === 2).lastUsedAt = 10;
  user.savedAccounts.find((entry) => entry.userid === 3).lastUsedAt = 20;
  const { default: dialog } = compile(
    '../src/renderer/components/profile/AccountSwitcherDialog.vue',
    {
      vue: { ...vue, useModel: () => vue.ref(true) },
      'vue-router': {
        useRouter: () => ({
          currentRoute: vue.ref({ fullPath: '/main/profile' }),
          push: (path) => calls.push(path),
        }),
      },
      '@/utils/userSession': userSession,
      '@/utils/watchUserSession': userSessionWatch,
      '@/utils/userIdentity': userIdentity,
      '@/stores/user': { useUserStore: () => user },
      '@/api/user': { getUserGradeInfo: async () => ({ status: 0 }) },
      '../../../shared/profileStats': profileStats,
      '@/stores/toast': {
        useToastStore: () => ({
          success: (msg) => calls.push(msg),
          warning: (msg) => calls.push(msg),
        }),
      },
    },
    {},
    true,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const view = scope.run(() => dialog.setup({ open: true }, { expose() {}, emit() {} }));
  assert.deepEqual(
    view.accounts.value.map((entry) => entry.userid),
    [1, 3, 2],
  );
  assert.equal(user.savedAccounts.length, 2);
  view.removal.value = view.accounts.value[1];
  assert.equal(user.savedAccounts.length, 2);
  view.removal.value = null;
  view.removeAccount();
  assert.equal(user.savedAccounts.length, 2);
  view.removal.value = view.accounts.value[1];
  view.removeAccount();
  assert.deepEqual(
    user.savedAccounts.map((entry) => entry.userid),
    [2],
  );
  view.switchAccount(view.accounts.value[1]);
  assert.equal(user.info.userid, 2);
  assert.deepEqual(
    view.accounts.value.map((entry) => entry.userid),
    [2, 1],
  );
  view.addAccount();
  assert.deepEqual(calls.at(-1), { path: '/login', query: { from: '/main/profile' } });
});

test('expired-session reauthentication preserves the current account and a switch closes its obsolete dialog', async (t) => {
  const { user } = fixture();
  user.setUserInfo(account(1));
  const auth = vue.reactive({
    sessionExpiredDialogOpen: true,
    hideSessionExpiredDialog() {
      this.sessionExpiredDialogOpen = false;
    },
  });
  const paths = [];
  const { default: dialog } = compile(
    '../src/renderer/components/app/AuthExpiredDialog.vue',
    {
      vue,
      'vue-router': {
        useRouter: () => ({
          currentRoute: vue.ref({ name: 'profile', fullPath: '/main/profile' }),
          push: async (path) => paths.push(path),
        }),
      },
      '@/utils/userSession': userSession,
      '@/utils/watchUserSession': userSessionWatch,
      '@/utils/userIdentity': userIdentity,
      '@/stores/user': { useUserStore: () => user },
      '@/stores/auth': { useAuthStore: () => auth },
    },
    {},
    true,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const view = scope.run(() => dialog.setup({}, { expose() {} }));
  await view.handleLogin();
  assert.equal(user.info.token, 'token-1');
  assert.deepEqual(paths, [{ name: 'login', query: { from: '/main/profile' } }]);
  auth.sessionExpiredDialogOpen = true;
  user.login(account(2));
  await vue.nextTick();
  assert.equal(auth.sessionExpiredDialogOpen, false);
  assert.deepEqual(user.savedAccounts.map((entry) => entry.userid).sort(), [1, 2]);
  await flush();
});

const durationDialog = (t, user, query, messages = []) => {
  const open = vue.ref(true);
  const { default: dialog } = compile(
    '../src/renderer/components/profile/AccountSwitcherDialog.vue',
    {
      vue: { ...vue, useModel: () => open, onMounted() {}, onUnmounted() {} },
      'vue-router': { useRouter: () => ({ currentRoute: vue.ref({ fullPath: '/main/profile' }) }) },
      '@/utils/userSession': userSession,
      '@/utils/watchUserSession': userSessionWatch,
      '@/utils/userIdentity': userIdentity,
      '@/stores/user': { useUserStore: () => user },
      '@/stores/toast': {
        useToastStore: () => ({
          success: (message) => messages.push(message),
          warning: (message) => messages.push(message),
        }),
      },
      '@/api/user': { getUserGradeInfo: query },
      '../../../shared/profileStats': profileStats,
    },
    {},
    true,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  return { open, view: scope.run(() => dialog.setup({ open: true }, { expose() {}, emit() {} })) };
};

test('listening cache survives credential refresh and switching, rejects invalid data and never recreates removed accounts', async () => {
  const { user } = fixture();
  user.login(account(1));
  user.updateSavedAccountListeningSeconds(1, '90060');
  user.rememberAccount({ ...account(1), nickname: 'new' });
  assert.equal(user.savedAccounts[0].listeningSeconds, 90060);
  for (const value of [null, undefined, '', '  ', false, -1, Infinity, 'invalid']) {
    user.updateSavedAccountListeningSeconds(1, value);
    assert.equal(user.savedAccounts[0].listeningSeconds, 90060);
  }
  user.login(account(2));
  user.switchAccount(1);
  assert.equal(user.savedAccounts.find((item) => item.userid === 1).listeningSeconds, 90060);
  user.updateSavedAccountListeningSeconds(2, 0);
  assert.equal(user.savedAccounts.find((item) => item.userid === 2).listeningSeconds, 0);
  user.forgetAccount(2);
  user.updateSavedAccountListeningSeconds(2, 500);
  assert.equal(
    user.savedAccounts.some((item) => item.userid === 2),
    false,
  );
  await flush();
});

test('dialog queries each inactive account, displays cached and live cumulative seconds without switching login', async (t) => {
  const pending = deferred();
  const { user } = fixture({ grade: () => ({ status: 1, data: { d_sec: 90060 } }) });
  user.login(account(1));
  user.rememberAccount(account(2));
  user.rememberAccount(account(3));
  user.rememberAccount(account(4));
  user.updateSavedAccountListeningSeconds(2, 120);
  const ids = [];
  const { view } = durationDialog(t, user, (id) => {
    ids.push(id);
    return id === 2
      ? pending.promise
      : Promise.resolve({ status: 1, data: { d_sec: id === 3 ? 0 : null } });
  });
  const row = (id) => view.accounts.value.find((item) => item.userid === id);
  assert.equal(view.accountDuration(row(2)), '2 分钟');
  assert.equal(view.accountDuration(row(3)), '正在获取…');
  await flush();
  assert.equal(view.accountDuration(row(1)), '1,501 分钟');
  assert.equal(view.accountDuration(row(3)), '0 分钟');
  assert.equal(view.accountDuration(row(4)), '暂无数据');
  pending.resolve({ status: 1, data: { d_sec: 3660 } });
  await flush();
  assert.equal(view.accountDuration(row(2)), '61 分钟');
  assert.equal(user.savedAccounts.find((item) => item.userid === 2).listeningSeconds, 3660);
  user.info.extendsInfo.detail.d_sec = 540 * 86400 + 3600 + 48 * 60;
  assert.equal(view.accountDuration(row(1)), '777,708 分钟');
  assert.deepEqual(ids.sort(), [2, 3, 4]);
  assert.equal(user.info.userid, 1);
});

test('closed dialog responses cannot replace fresh listening data; failed refresh retains cache', async (t) => {
  const old = deferred(),
    fresh = deferred();
  const { user } = fixture();
  user.login(account(1));
  user.rememberAccount(account(2));
  user.updateSavedAccountListeningSeconds(2, 60);
  let count = 0;
  const { view, open } = durationDialog(t, user, () =>
    count++ === 0
      ? old.promise
      : count === 2
        ? fresh.promise
        : Promise.reject(new Error('offline')),
  );
  await vue.nextTick();
  open.value = false;
  await vue.nextTick();
  open.value = true;
  await vue.nextTick();
  fresh.resolve({ status: 1, data: { d_sec: 120 } });
  await flush();
  old.resolve({ status: 1, data: { d_sec: 9999 } });
  await flush();
  assert.equal(user.savedAccounts.find((item) => item.userid === 2).listeningSeconds, 120);
  open.value = false;
  open.value = true;
  await vue.nextTick();
  await flush();
  assert.equal(
    view.accountDuration(view.accounts.value.find((item) => item.userid === 2)),
    '2 分钟',
  );
  assert.equal(view.loadingDurations.value.size, 0);
});

test('account revision invalidates pending duration reads and removing an account does not resurrect its cache', async (t) => {
  const pending = deferred(),
    removed = deferred();
  const queriedCurrent = [];
  const { user } = fixture({
    grade: () => {
      queriedCurrent.push(user.info.userid);
      return { status: 0 };
    },
  });
  user.login(account(1));
  user.rememberAccount(account(2));
  user.rememberAccount(account(4));
  user.updateSavedAccountListeningSeconds(2, 60);
  let initial = true;
  const { view } = durationDialog(t, user, (id) => {
    if (id === 4) return removed.promise;
    return initial && id === 2 ? pending.promise : { status: 1, data: { d_sec: 120 } };
  });
  await flush();
  initial = false;
  user.login(account(3));
  user.forgetAccount(4);
  await flush();
  pending.resolve({ status: 1, data: { d_sec: 9999 } });
  removed.resolve({ status: 1, data: { d_sec: 500 } });
  await flush();
  assert.equal(user.savedAccounts.find((item) => item.userid === 2).listeningSeconds, 120);
  assert.equal(
    view.accountDuration(view.accounts.value.find((item) => item.userid === 2)),
    '2 分钟',
  );
  assert.equal(
    user.savedAccounts.some((item) => item.userid === 4),
    false,
  );
  assert.equal(user.info.userid, 3);
  assert.deepEqual(queriedCurrent, [1, 3]);
});

test('dialog displays only real accounts and blocks current removal even when invoked directly', async (t) => {
  const { user } = fixture();
  user.login(account(1));
  user.rememberAccount(account(2));
  const savedIds = user.savedAccounts.map((item) => item.userid);
  const queries = [];
  const messages = [];
  const { view } = durationDialog(
    t,
    user,
    (id) => {
      queries.push(id);
      return { status: 0 };
    },
    messages,
  );
  assert.deepEqual(
    view.accounts.value.map((item) => item.userid),
    [1, 2],
  );
  const revision = user.accountRevision;
  view.removal.value = view.accounts.value.find((item) => item.userid === 1);
  view.removeAccount();
  await flush();
  assert.deepEqual(queries, [2]);
  assert.deepEqual(
    user.savedAccounts.map((item) => item.userid),
    savedIds,
  );
  assert.equal(user.info.userid, 1);
  assert.equal(user.isLoggedIn, true);
  assert.equal(user.accountRevision, revision);
  assert.equal(view.removal.value, null);
  assert.deepEqual(messages, ['当前登录账号不能移除，请先切换账号']);
});

test('a pending removal cannot remove an account that becomes current before confirmation', async (t) => {
  const { user } = fixture();
  user.login(account(1));
  user.rememberAccount(account(2));
  const messages = [];
  const { view } = durationDialog(t, user, async () => ({ status: 0 }), messages);
  view.removal.value = view.accounts.value.find((entry) => entry.userid === 2);
  user.switchAccount(2);
  const revision = user.accountRevision;
  view.removeAccount();
  assert.equal(user.info.userid, 2);
  assert.equal(user.isLoggedIn, true);
  assert.equal(user.accountRevision, revision);
  assert.deepEqual(user.savedAccounts.map((entry) => entry.userid).sort(), [1, 2]);
  assert.equal(view.removal.value, null);
  assert.deepEqual(messages, ['当前登录账号不能移除，请先切换账号']);
  await flush();
});

test('student identity response is account scoped and persists only fields used for display', async () => {
  const oldInfo = deferred();
  let first = true;
  const { user } = fixture({
    detail: () => ({ status: 1, data: { nickname: first ? 'A' : 'B' } }),
    info: () =>
      first
        ? oldInfo.promise
        : {
            status: 1,
            data: {
              student_status: 1,
              student_school: 'B 学校',
              tags: '摇滚',
              login_mobile: 'private',
            },
          },
  });
  user.login(account(1));
  first = false;
  user.login(account(2));
  await flush();
  oldInfo.resolve({
    status: 1,
    data: { student_status: 1, student_school: 'A 学校', tags: '流行' },
  });
  await flush();
  assert.equal(user.info.userid, 2);
  assert.deepEqual(user.info.extendsInfo.identity, {
    student_status: 1,
    student_school: 'B 学校',
    student_expire_time: '',
    tags: '摇滚',
  });
  assert.equal(user.info.extendsInfo.identity.login_mobile, undefined);
  assert.equal(
    user.savedAccounts.some((item) => 'identity' in item),
    false,
  );
});

test('saved display summaries stay with their own account and refresh can clear obsolete identity', async (t) => {
  const { user } = fixture();
  user.login({
    ...account(1),
    detail: { kq_talent: 32, auth_info: '歌词制作达人', mobile: 'private' },
    vip: { user_type: 16 },
  });
  await flush();
  const snapshot = user.savedAccounts.find((saved) => saved.userid === 1).display;
  assert.deepEqual(
    snapshot.badges.map((badge) => badge.label),
    ['歌词制作达人'],
  );
  assert.equal(snapshot.membership.label, '超级VIP');
  assert.equal(snapshot.mobile, undefined);
  assert.equal(snapshot.token, undefined);
  user.login(account(2));
  await flush();
  assert.equal(user.savedAccounts.find((saved) => saved.userid === 2).display, undefined);
  const dialog = durationDialog(t, user, async () => ({ status: 0 })).view;
  assert.deepEqual(dialog.accountDisplay(dialog.accounts.value[0]).badges, []);
  assert.deepEqual(dialog.accountDisplay(dialog.accounts.value[1]).badges, snapshot.badges);
  user.switchAccount(1);
  await flush();
  assert.equal(user.info.extendsInfo.detail.kq_talent, undefined);
  assert.equal(dialog.accountDisplay(dialog.accounts.value[0]).membership.label, '超级VIP');
  user.setUserInfo({
    ...account(1),
    detail: { kq_talent: 0, auth_info: '' },
    extendsInfo: {
      detail: { kq_talent: 0, auth_info: '' },
      vip: { user_type: 0, vip_type: 0 },
    },
  });
  assert.deepEqual(user.savedAccounts.find((saved) => saved.userid === 1).display.badges, []);
  assert.equal(user.savedAccounts.find((saved) => saved.userid === 1).display.avatarIcon, '');
  assert.equal(user.savedAccounts.find((saved) => saved.userid === 1).display.membership, null);
});
