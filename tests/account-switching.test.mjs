import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import * as pinia from 'pinia';

const compile = (path, mocks = {}, window = {}, script = false) => {
  let source = readFileSync(new URL(path, import.meta.url), 'utf8');
  if (script) source = compileScript(parse(source).descriptor, { id: 'account-switching' }).content;
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
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
      getUserDetail: () => {
        reads.push('detail');
        return api.detail?.() ?? { status: 0 };
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
  assert.deepEqual(reads, ['detail', 'vip', 'detail', 'vip']);
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

test('logout and account removal discard only the requested credentials and never auto-switch', async () => {
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
  user.forgetAccount(2);
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
  assert.equal(reads.length, 2);
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
  await new Promise((resolve) => setTimeout(resolve, 180));
  const restarted = fixture().user;
  scope.run(() => persistence.sqlitePersistPlugin({ store: restarted, options }));
  await persistence.waitForSqlitePersistHydration();
  assert.equal(restarted.info.userid, 2);
  assert.equal(restarted.isLoggedIn, true);
  assert.deepEqual(restarted.savedAccounts.map((entry) => entry.userid).sort(), [1, 2]);
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
      '@/stores/user': { useUserStore: () => user },
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
