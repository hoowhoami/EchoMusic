import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

function load(path, mocks) {
  const code = transformSync(readFileSync(path, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id in mocks) return mocks[id];
      throw new Error(`Unexpected dependency ${id}`);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

async function fixture() {
  const sessions = new Map();
  const logs = [];
  const webContentsList = [];
  const createSession = (partition) => ({
    calls: [],
    userAgent: undefined,
    async setProxy(config) {
      this.calls.push(['setProxy', config]);
    },
    async closeAllConnections() {
      this.calls.push(['close']);
    },
    async clearHostResolverCache() {
      this.calls.push(['dns']);
    },
    async forceReloadProxyConfig() {
      this.calls.push(['proxy']);
    },
    async fetch(input) {
      this.calls.push(['fetch', input]);
      return { ok: true };
    },
    setUserAgent(userAgent) {
      this.userAgent = userAgent;
      this.calls.push(['setUserAgent', userAgent]);
    },
    getUserAgent() {
      return this.userAgent ?? 'EchoMusic-Default-UA';
    },
    partition,
  });
  const fromPartition = (partition) => {
    if (!sessions.has(partition)) sessions.set(partition, createSession(partition));
    return sessions.get(partition);
  };
  const shared = load('src/shared/network.ts', {});
  const app = new EventEmitter();
  const policy = load('src/main/networkPolicy.ts', {
    electron: {
      app,
      session: { defaultSession: fromPartition('default'), fromPartition },
      webContents: { getAllWebContents: () => webContentsList },
    },
    '../shared/network': shared,
    './logger': {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
  });
  await policy.initializeNetworkPolicy(shared.DEFAULT_NETWORK_SETTINGS);
  sessions.forEach((s) => (s.calls.length = 0));
  return {
    policy,
    sessions,
    fromPartition,
    logs,
    settings: shared.DEFAULT_NETWORK_SETTINGS,
    app,
    webContentsList,
  };
}

function addWebContents(webContentsList, session) {
  const contents = {
    session,
    userAgents: [],
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setUserAgent(userAgent) {
      this.userAgents.push(userAgent);
    },
  };
  webContentsList.push(contents);
  return contents;
}

test('wake resets all registered sessions despite unchanged proxy settings and keeps stored state', async () => {
  const s = await fixture();
  s.policy.installNetworkPolicyLifecycle();
  const extra = s.fromPartition('plugin-custom');
  s.app.emit('session-created', extra);
  await s.policy.getManagedNetworkSession('plugin-custom');
  extra.calls.length = 0;
  await s.policy.recoverNetworkAfterWake();
  assert.equal(s.sessions.size, 7);
  for (const session of s.sessions.values()) {
    assert.deepEqual(session.calls, [['close'], ['dns'], ['proxy']]);
  }
  assert.equal(s.policy.hasProxyPassword(), false);
  await s.policy.getManagedNetworkSession();
  assert.equal(s.sessions.get('echo-app-network').calls.length, 3);
});

test('wake recovery coalesces while new requests wait for the session reset', async () => {
  const s = await fixture();
  const pending = deferred();
  s.sessions.get('echo-kugou-api').closeAllConnections = () => pending.promise;
  const recovery = s.policy.recoverNetworkAfterWake();
  assert.equal(s.policy.recoverNetworkAfterWake(), recovery);
  const request = s.policy.networkFetch('https://example.test/read');
  await turn();
  assert.ok(!s.sessions.get('echo-app-network').calls.some(([name]) => name === 'fetch'));
  pending.resolve();
  await Promise.all([recovery, request]);
  assert.deepEqual(s.sessions.get('echo-app-network').calls.at(-1), [
    'fetch',
    'https://example.test/read',
  ]);
  await s.policy.recoverNetworkAfterWake();
  assert.equal(
    s.sessions.get('echo-app-network').calls.filter(([name]) => name === 'close').length,
    2,
  );
});

test('failure in one operation still resets other sessions and releases subsequent requests', async () => {
  const s = await fixture();
  s.sessions.get('echo-kugou-api').closeAllConnections = () => {
    throw new Error('close failed');
  };
  await assert.rejects(s.policy.recoverNetworkAfterWake(), /failed for 1 sessions/);
  assert.deepEqual(s.sessions.get('echo-kugou-api').calls, [['dns'], ['proxy']]);
  assert.deepEqual(s.sessions.get('echo-app-network').calls, [['close'], ['dns'], ['proxy']]);
  await s.policy.networkFetch('https://example.test/after-failure');
  assert.equal(s.sessions.get('echo-app-network').calls.at(-1)[0], 'fetch');
  assert.ok(s.logs.some((entry) => entry[0] === 'warn' && entry[2].operation === 'connections'));
});

test('proxy changes during recovery run afterward and retain credentials', async () => {
  const s = await fixture();
  const pending = deferred();
  s.sessions.get('echo-kugou-api').closeAllConnections = () => pending.promise;
  const recovery = s.policy.recoverNetworkAfterWake();
  await turn();
  const update = s.policy.updateNetworkPolicy(
    {
      ...s.settings,
      proxyMode: 'fixed_servers',
      proxyRules: 'localhost:1080',
      proxyUsername: 'user',
    },
    'secret',
  );
  await turn();
  assert.ok(!s.sessions.get('echo-app-network').calls.some(([name]) => name === 'setProxy'));
  pending.resolve();
  await Promise.all([recovery, update]);
  assert.deepEqual(s.policy.getProxyCredentials(), { username: 'user', password: 'secret' });
  assert.deepEqual(s.sessions.get('echo-app-network').calls[3], [
    'setProxy',
    {
      mode: 'fixed_servers',
      proxyRules: 'localhost:1080',
      proxyBypassRules: '<local>',
    },
  ]);
});

test('custom user agent applies to every session and existing web contents without closing connections', async () => {
  const s = await fixture();
  const mainContents = addWebContents(s.webContentsList, s.sessions.get('default'));
  const kugouContents = addWebContents(s.webContentsList, s.sessions.get('echo-kugou-api'));

  await s.policy.updateNetworkPolicy({ ...s.settings, userAgent: 'EchoTest/1.0' });

  for (const [partition, session] of s.sessions) {
    if (partition === 'echo-kugou-api') {
      // 酷狗 API 分区隔离全局 UA，避免误伤同分区的第三方 OAuth 请求
      assert.equal(session.userAgent, undefined);
    } else {
      assert.equal(session.userAgent, 'EchoTest/1.0');
    }
    assert.ok(!session.calls.some(([name]) => name === 'close'), '改 UA 不应断连');
  }
  assert.deepEqual(mainContents.userAgents, ['EchoTest/1.0']);
  assert.deepEqual(kugouContents.userAgents, []);
});

test('clearing custom user agent restores the captured default and keeps connections open', async () => {
  const s = await fixture();
  await s.policy.updateNetworkPolicy({ ...s.settings, userAgent: 'EchoTest/1.0' });
  s.sessions.forEach((session) => (session.calls.length = 0));

  await s.policy.updateNetworkPolicy({ ...s.settings, userAgent: '' });

  for (const [partition, session] of s.sessions) {
    if (partition === 'echo-kugou-api') {
      assert.equal(session.userAgent, undefined);
    } else {
      assert.equal(session.userAgent, 'EchoMusic-Default-UA');
    }
    assert.ok(!session.calls.some(([name]) => name === 'close'), '清空 UA 不应断连');
  }
});

test('kugou user agent stays out of session scope and only targets kugou hosts', async () => {
  const s = await fixture();
  const before = [...s.sessions.values()].map((session) => session.userAgent);

  await s.policy.updateNetworkPolicy({ ...s.settings, kugouUserAgent: 'KugouUA/2.0' });

  assert.deepEqual(
    [...s.sessions.values()].map((session) => session.userAgent),
    before,
    '酷狗 UA 不应写入任何 session',
  );
});

test('proxy changes still close existing connections while keeping the same user agent', async () => {
  const s = await fixture();
  await s.policy.updateNetworkPolicy({ ...s.settings, userAgent: 'EchoTest/1.0' });
  s.sessions.forEach((session) => (session.calls.length = 0));

  await s.policy.updateNetworkPolicy({
    ...s.settings,
    userAgent: 'EchoTest/1.0',
    proxyMode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7890',
  });

  for (const session of s.sessions.values()) {
    assert.ok(
      session.calls.some(([name]) => name === 'close'),
      '代理变化应断连',
    );
    assert.ok(!session.calls.some(([name]) => name === 'setUserAgent'), 'UA 未变化不应重复设置');
  }
});

test('failed proxy apply leaves the previous user agent untouched for rollback', async () => {
  const s = await fixture();
  const target = s.sessions.get('echo-app-network');
  const previousUserAgent = target.userAgent;
  target.setProxy = async () => {
    target.calls.push(['setProxy-failed']);
    throw new Error('proxy apply failed');
  };

  await assert.rejects(
    s.policy.updateNetworkPolicy({ ...s.settings, userAgent: 'FailUA/1.0' }),
    /proxy apply failed/,
  );
  assert.equal(target.userAgent, previousUserAgent);
  assert.ok(!target.calls.some(([name]) => name === 'setUserAgent'));
});
