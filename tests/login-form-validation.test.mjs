import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const { descriptor } = parse(
  readFileSync(new URL('../src/renderer/views/Login.vue', import.meta.url), 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'login-validation' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(api = {}) {
  const calls = [];
  const successes = [];
  const defaults = Object.fromEntries(
    ['loginBySms', 'loginByPassword', 'sendSmsCode'].map((name) => [
      name,
      async (...args) => {
        calls.push([name, ...args]);
        return api[name] ? api[name](...args) : { status: 0, error: '服务端提示' };
      },
    ]),
  );
  const deps = {
    vue: { ...vue, onMounted() {}, onUnmounted() {} },
    'vue-router': { useRouter: () => ({ currentRoute: vue.ref({ query: {} }) }) },
    '@/stores/user': {
      useUserStore: () => ({
        isLoggedIn: false,
        handleLoginSuccess: (data) => successes.push(data),
      }),
    },
    '@/api/user': defaults,
    '@/utils/kugouVerification': {
      kugouVerificationState: {},
      completeKugouLoginVerification() {},
    },
    '@/utils/logger': { info() {}, warn() {}, error() {} },
    '@/utils/navigation': { closeTransientView() {} },
    '@/icons': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', code)(
    (name) => {
      if (name.startsWith('@/components/') || name.startsWith('@/layouts/')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
    () => 1,
    () => {},
  );
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { view, calls, successes, stop: () => scope.stop() };
}

test('SMS submission reports the first missing or invalid field without sending a request', async () => {
  const f = fixture();
  try {
    for (const [mobile, code, error] of [
      ['', '', '请输入手机号'],
      ['  ', '1234', '请输入手机号'],
      ['123', '1234', '请输入正确的手机号'],
      ['13800138000', '  ', '请输入验证码'],
    ]) {
      Object.assign(f.view.smsData, { mobile, code });
      await f.view.handleSmsLogin();
      assert.equal(f.view.smsData.error, error);
      assert.equal(f.view.smsData.isSending, false);
    }
    assert.deepEqual(f.calls, []);
  } finally {
    f.stop();
  }
});

test('password submission reports the first missing field without sending a request', async () => {
  const f = fixture();
  try {
    for (const [username, password, error] of [
      ['', '', '请输入用户名'],
      ['  ', 'password', '请输入用户名'],
      ['user', '  ', '请输入密码'],
    ]) {
      Object.assign(f.view.accountData, { username, password });
      await f.view.handleAccountLogin();
      assert.equal(f.view.accountData.error, error);
      assert.equal(f.view.accountData.isSubmitting, false);
    }
    assert.deepEqual(f.calls, []);
  } finally {
    f.stop();
  }
});

for (const method of ['sms', 'account']) {
  test(`${method} clears stale validation on submit, rejects duplicate requests and releases busy after failure`, async () => {
    const pending = deferred();
    const apiName = method === 'sms' ? 'loginBySms' : 'loginByPassword';
    const f = fixture({ [apiName]: () => pending.promise });
    try {
      const data = method === 'sms' ? f.view.smsData : f.view.accountData;
      const busyKey = method === 'sms' ? 'isSending' : 'isSubmitting';
      const submit = method === 'sms' ? f.view.handleSmsLogin : f.view.handleAccountLogin;
      Object.assign(
        data,
        method === 'sms'
          ? { mobile: ' 13800138000 ', code: ' 1234 ', error: '旧校验错误' }
          : { username: ' user ', password: ' password ', error: '旧校验错误' },
      );
      const operation = submit();
      assert.equal(data[busyKey], true);
      assert.equal(data.error, '');
      await submit();
      assert.equal(f.calls.length, 1);
      assert.equal(data.error, '');
      assert.deepEqual(
        f.calls[0],
        method === 'sms' ? [apiName, '13800138000', '1234'] : [apiName, 'user', 'password'],
      );
      pending.resolve({ status: 0, error: '登录信息有误' });
      await operation;
      assert.equal(data.error, '登录信息有误');
      assert.equal(data[busyKey], false);
    } finally {
      f.stop();
    }
  });
}

test('SMS send-code is guarded while submitting and during countdown, and does not submit login', async () => {
  const pending = deferred();
  const f = fixture({ sendSmsCode: () => pending.promise });
  try {
    f.view.smsData.mobile = '13800138000';
    const operation = f.view.handleSendCode();
    await f.view.handleSendCode();
    await f.view.handleSmsLogin();
    assert.deepEqual(f.calls, [['sendSmsCode', '13800138000']]);
    assert.equal(f.view.smsData.error, '');
    pending.resolve({ status: 1 });
    await operation;
    assert.equal(f.view.smsData.countdown, 60);
    assert.equal(f.view.smsData.isSending, false);
    await f.view.handleSendCode();
    assert.equal(f.calls.length, 1);
  } finally {
    f.stop();
  }
});

test('SMS multi-account selection retains normalized credentials and completes login', async () => {
  const f = fixture({
    loginBySms: async (mobile, code, userid) =>
      userid
        ? { status: 1, data: { userid, token: 'token' } }
        : { error_code: 34175, data: { info_list: [{ userid: 7, nickname: '用户' }] } },
  });
  try {
    Object.assign(f.view.smsData, { mobile: ' 13800138000 ', code: ' 1234 ' });
    await f.view.handleSmsLogin();
    assert.equal(f.view.smsData.accountCandidates.length, 1);
    await f.view.handleSmsAccountLogin(f.view.smsData.accountCandidates[0]);
    assert.deepEqual(f.calls[1], ['loginBySms', '13800138000', '1234', 7]);
    assert.deepEqual(f.successes, [{ userid: 7, token: 'token' }]);
    assert.equal(f.view.smsData.isSending, false);
  } finally {
    f.stop();
  }
});

test('password security-verification cancellation remains visible and releases submission', async () => {
  const f = fixture({
    loginByPassword: async () => {
      throw new Error('已取消安全验证');
    },
  });
  try {
    Object.assign(f.view.accountData, { username: 'user', password: 'password' });
    await f.view.handleAccountLogin();
    assert.equal(f.view.accountData.error, '已取消安全验证');
    assert.equal(f.view.accountData.isSubmitting, false);
  } finally {
    f.stop();
  }
});
