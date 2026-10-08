import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

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
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  verbose() {},
  settings: () => ({}),
  isEnabled: () => false,
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
        timer = setTimeout(() => reject(new Error('request did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const ok = (body = { status: 1 }) => ({ status: 200, body });
const challenge = (event = 'event') => ok({ status: 0, error_code: 20028, ssaCode: event });
const setup = (send, device = {}) => {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'first' },
  });
  const verification = compile('../src/renderer/utils/kugouVerification.ts', {
    vue,
    '@/utils/logger': logger,
  });
  let notices = 0,
    chains = 0;
  let origin = { type: 'host' };
  const calls = [],
    timers = [];
  const window = {
    electron: {
      api: {
        request: async (config) => {
          calls.push(config);
          return send(config, calls.length);
        },
      },
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  };
  const request = compile(
    '../src/renderer/utils/request.ts',
    {
      vue,
      '@/stores/user': { useUserStore: () => user },
      '@/stores/device': { useDeviceStore: () => ({ info: device }) },
      '@/stores/auth': {
        useAuthStore: () => ({
          showSessionExpiredDialog: () => {
            notices += 1;
          },
        }),
      },
      './logger': { logger },
      './userSession': session,
      './kugouVerification': verification,
      '../../shared/logging': {
        getPayloadSize: () => 0,
        maskSensitiveText: (value) => value,
        stringifyForLog: JSON.stringify,
      },
      './serverInterceptors': {
        getCurrentRequestOrigin: () => origin,
        hasServerInterceptors: () => true,
        runServerInterceptorChain: async (config, sender) => {
          chains += 1;
          return sender(config);
        },
      },
    },
    window,
  ).default;
  return {
    request,
    verification,
    user,
    calls,
    timers,
    get notices() {
      return notices;
    },
    get chains() {
      return chains;
    },
    setOrigin: (value) => {
      origin = value;
    },
  };
};

test('another account login retains device identity and excludes the active account credentials', async () => {
  const api = setup(() => ok(), { dfid: 'dfid', mid: 'mid', uuid: 'uuid', guid: 'guid' });
  api.user.info.t1 = 'first-t1';
  await api.request.get('/login', { skipUserAuth: true });
  const header = api.calls[0].headers.Authorization;
  assert.equal(header, 'dfid=dfid;KUGOU_API_MID=mid;uuid=uuid;KUGOU_API_GUID=guid');
  await api.request.get('/user/detail');
  assert.equal(api.calls[1].headers.Authorization, `token=first;userid=7;t1=first-t1;${header}`);
});

test('a login error for another account does not expire the active account', async () => {
  const api = setup(() => ({ status: 502, body: { error_code: 20018 } }));
  await assert.rejects(api.request.get('/login', { skipUserAuth: true }), /API Error/);
  assert.equal(api.notices, 0);
  assert.equal(api.user.info.token, 'first');
});

test('another account login verification and retry keep the same device-only auth', async () => {
  let logins = 0;
  const api = setup(
    ({ url }) => {
      if (url === '/login') return ++logins === 1 ? challenge() : ok();
      if (url === '/get/verify/info') return ok({ status: 1, data: { v_type: 23 } });
      return ok();
    },
    { dfid: 'device' },
  );
  const operation = api.request.get('/login', { skipUserAuth: true });
  await flush();
  assert.equal(await api.verification.submitKugouVerification('captcha'), true);
  await bounded(operation);
  assert.equal(logins, 2);
  assert.ok(api.calls.every((call) => call.headers.Authorization === 'dfid=device'));
  assert.equal(api.user.info.token, 'first');
});

test('normal verification retries once with the same params/body/auth and all API stages succeed', async () => {
  let writes = 0;
  const api = setup(({ url }) =>
    url === '/write'
      ? ++writes === 1
        ? challenge()
        : ok({ status: 1, data: 'saved' })
      : url === '/get/verify/info'
        ? ok({ status: 1, data: { v_type: 23 } })
        : ok(),
  );
  const pending = api.request.post('/write', { name: 'draft' }, { params: { listid: 12 } });
  await flush();
  assert.equal(api.verification.kugouVerificationState.open, true);
  assert.equal(await api.verification.submitKugouVerification('captcha'), true);
  assert.deepEqual(await pending, { status: 1, data: 'saved' });
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ['/write', '/get/verify/info', '/sidedt', '/write'],
  );
  assert.ok(api.calls.every((call) => call.headers.Authorization === 'token=first;userid=7'));
  assert.deepEqual(api.calls.at(-1).params, { listid: 12 });
  assert.deepEqual(api.calls.at(-1).data, { name: 'draft' });
});

for (const change of ['token', 'revision', 'logout']) {
  test(`${change} during verification cancels the old challenge without retrying under the new account`, async () => {
    const api = setup(({ url }) =>
      url === '/write' ? challenge() : ok({ status: 1, data: { v_type: 23 } }),
    );
    const pending = api.request.get('/write');
    const rejected = assert.rejects(bounded(pending), /登录状态已变化/);
    await flush();
    if (change === 'token') api.user.info.token = 'new';
    else if (change === 'revision') api.user.accountRevision += 1;
    else api.user.isLoggedIn = false;
    await rejected;
    assert.equal(api.verification.kugouVerificationState.open, false);
    assert.deepEqual(
      api.calls.map((call) => call.url),
      ['/write', '/get/verify/info'],
    );
  });
}

test('a verification response arriving after account change cannot open an old challenge', async () => {
  const response = deferred();
  const api = setup(() => response.promise);
  const pending = api.request.get('/write');
  const rejected = assert.rejects(bounded(pending), /登录状态已变化/);
  api.user.info.userid = 8;
  response.resolve(challenge());
  await rejected;
  assert.equal(api.calls.length, 1);
  assert.equal(api.verification.kugouVerificationState.open, false);
});

test('switching while captcha submission is in flight rejects the original action and ignores its late success', async () => {
  const submission = deferred();
  const api = setup(({ url }) =>
    url === '/write'
      ? challenge()
      : url === '/sidedt'
        ? submission.promise
        : ok({ status: 1, data: { v_type: 23 } }),
  );
  const pending = api.request.get('/write');
  const rejected = assert.rejects(bounded(pending), /登录状态已变化/);
  await flush();
  const verifying = api.verification.submitKugouVerification('captcha');
  api.user.accountRevision += 1;
  await rejected;
  submission.resolve(ok());
  assert.equal(await verifying, false);
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ['/write', '/get/verify/info', '/sidedt'],
  );
  assert.equal(api.verification.kugouVerificationState.open, false);
});

test('late auth expiration neither alerts nor consumes the new account expiration notification', async () => {
  const pending = deferred();
  let calls = 0;
  const api = setup(() => (++calls === 1 ? pending.promise : ok({ status: 0, error_code: 20018 })));
  const a = api.request.get('/old');
  api.user.info.token = 'new';
  pending.resolve(ok({ status: 0, error_code: 20018 }));
  await a;
  assert.equal(api.notices, 0);
  await api.request.get('/new');
  assert.equal(api.notices, 1);
});

test('plugin-origin verification follow-up and retry retain origin across asynchronous continuations', async () => {
  let writes = 0;
  const api = setup(({ url }) =>
    url === '/write'
      ? ++writes === 1
        ? challenge()
        : ok()
      : ok({ status: 1, data: { v_type: 23 } }),
  );
  api.setOrigin({ type: 'plugin', pluginId: 'test-plugin' });
  const pending = api.request.get('/write');
  api.setOrigin({ type: 'host' });
  await flush();
  await api.verification.submitKugouVerification('captcha');
  await pending;
  assert.equal(api.calls.length, 4);
  assert.equal(api.chains, 0);
});

test('a new-account challenge with the same event ID survives old promise cleanup and deduplicates fresh callers', async () => {
  let verified = false,
    infos = 0;
  const api = setup(({ url }) => {
    if (url === '/write') return verified ? ok() : challenge();
    if (url === '/get/verify/info') {
      infos += 1;
      return ok({ status: 1, data: { v_type: 23 } });
    }
    verified = true;
    return ok();
  });
  const old = api.request.get('/write');
  const rejected = assert.rejects(bounded(old), /登录状态已变化/);
  await flush();
  api.user.info.token = 'new';
  const fresh = api.request.get('/write');
  await rejected;
  await flush();
  const second = api.request.get('/write');
  await flush();
  assert.equal(infos, 2);
  await api.verification.submitKugouVerification('captcha');
  await Promise.all([fresh, second]);
  assert.ok(
    api.calls.slice(2).every((call) => call.headers.Authorization === 'token=new;userid=7'),
  );
});

test('expired queued verification requests cannot send any verification API under the next account', async () => {
  const api = setup(({ url }) =>
    url.startsWith('/write') ? challenge(url) : ok({ status: 1, data: { v_type: 23 } }),
  );
  const a = api.request.get('/write-a'),
    b = api.request.get('/write-b');
  const rejected = [
    assert.rejects(bounded(a), /登录状态已变化/),
    assert.rejects(bounded(b), /登录状态已变化/),
  ];
  await flush();
  api.user.info.token = 'new';
  await Promise.all(rejected);
  await flush();
  assert.equal(api.verification.kugouVerificationState.open, false);
  assert.equal(api.calls.filter((call) => call.url === '/get/verify/info').length, 1);
  assert.ok(api.calls.every((call) => call.headers.Authorization === 'token=first;userid=7'));
});

test('a verification retry rejected again remains bounded to one replay', async () => {
  const api = setup(({ url }) =>
    url === '/write' ? challenge() : ok({ status: 1, data: { v_type: 23 } }),
  );
  const pending = api.request.get('/write');
  const rejected = assert.rejects(bounded(pending), /仍拒绝/);
  await flush();
  await api.verification.submitKugouVerification('captcha');
  await rejected;
  assert.equal(api.calls.filter((call) => call.url === '/write').length, 2);
});

test('a synchronous session change during verification-info dispatch cannot miss cancellation', async () => {
  const api = setup(({ url }) => {
    if (url === '/write') return challenge();
    api.user.info.token = 'new';
    return ok({ status: 1, data: { v_type: 23 } });
  });
  await assert.rejects(bounded(api.request.get('/write')), /登录状态已变化/);
  assert.equal(api.verification.kugouVerificationState.open, false);
  assert.equal(api.calls.length, 2);
});

test('aborting a queued challenge leaves the active challenge usable and never starts the cancelled API', async () => {
  const api = setup(() => ok()).verification;
  const first = api.requestKugouVerification('active', async () => ({
    status: 1,
    data: { v_type: 23 },
  }));
  const controller = new AbortController();
  let cancelledCalls = 0;
  const queued = api.requestKugouVerification(
    'queued',
    async () => {
      cancelledCalls += 1;
      return { status: 1 };
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(bounded(queued), /cancel queued/);
  controller.abort(new Error('cancel queued'));
  await rejected;
  await flush();
  assert.equal(api.kugouVerificationState.eventId, 'active');
  assert.equal(await api.submitKugouVerification('captcha'), true);
  await first;
  assert.equal(cancelledCalls, 0);
});

test('an already aborted challenge never queues or sends requests', async () => {
  const api = setup(() => ok()).verification;
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const pending = api.requestKugouVerification(
    'event',
    async () => {
      calls += 1;
      return { status: 1 };
    },
    { signal: controller.signal },
  );
  await assert.rejects(bounded(pending));
  assert.equal(calls, 0);
  assert.equal(api.kugouVerificationState.open, false);
});

test('expiration notifications belong to each session and an old timeout cannot release a newer notification', async () => {
  const api = setup(() => ok({ status: 0, error_code: 20018 }));
  await api.request.get('/first');
  assert.equal(api.notices, 1);
  const oldTimer = api.timers[0];
  api.user.info.token = 'new';
  await api.request.get('/second');
  assert.equal(api.notices, 2);
  oldTimer();
  await api.request.get('/second');
  assert.equal(api.notices, 2);
  api.timers[1]();
  await api.request.get('/second');
  assert.equal(api.notices, 3);
});
