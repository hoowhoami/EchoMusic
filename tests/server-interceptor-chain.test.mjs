import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

const root = resolve('.');
const bundle = await build({
  stdin: {
    contents: `
      export {
        registerServerInterceptor,
        hasServerInterceptors,
        runServerInterceptorChain,
        runWithRequestOrigin,
        getCurrentRequestOrigin,
        isValidServerResponse,
      } from './src/renderer/utils/serverInterceptors';
      export { createServerInterceptApi } from './src/renderer/plugins/runtime/serverIntercept';
      export { isNowPlayingCommand } from './src/shared/nowPlaying';
      export { isLyricsPageKeyOwnedBy } from './src/renderer/plugins/lyricsPage';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'lyrics-page-fixture',
      setup(builder) {
        builder.onResolve({ filter: /builtinSkins/ }, (args) => ({
          path: args.path,
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const builtinLyricSkins = [];',
          loader: 'js',
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const {
  registerServerInterceptor,
  hasServerInterceptors,
  runServerInterceptorChain,
  runWithRequestOrigin,
  getCurrentRequestOrigin,
  isValidServerResponse,
  createServerInterceptApi,
  isNowPlayingCommand,
  isLyricsPageKeyOwnedBy,
} = module.exports;

const disposers = [];
afterEach(() => {
  while (disposers.length) disposers.pop()();
});

const okSender = async (request) => ({
  status: 200,
  body: { url: request.url, params: request.params },
});

const createPluginInterceptor = () => {
  const reported = [];
  const disposables = [];
  const api = createServerInterceptApi(
    { id: 'test-plugin', manifest: { capabilities: { serverIntercept: true } } },
    {
      addDisposable: (dispose) => {
        disposables.push(dispose);
        return dispose;
      },
      reportPluginRuntimeError: (pluginId, error, source) =>
        reported.push({ pluginId, error, source }),
    },
  );
  disposers.push(() => disposables.forEach((dispose) => dispose()));
  return { api, reported };
};

test('chain executes in priority desc / registration order and re-evaluates match per layer', async () => {
  const entered = [];
  const senderUrls = [];
  disposers.push(
    registerServerInterceptor('a', async (req, next) => {
      entered.push('a');
      return next();
    }),
    registerServerInterceptor(
      'b',
      async (req, next) => {
        entered.push('b');
        return next({ url: '/b' });
      },
      { priority: 10 },
    ),
    registerServerInterceptor(
      'c',
      async (req, next) => {
        entered.push('c');
        return next();
      },
      { match: '/b' },
    ),
  );
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/a', params: {}, headers: {}, origin: { type: 'host' } },
    async (req) => {
      senderUrls.push(req.url);
      return okSender(req);
    },
  );
  assert.deepStrictEqual(entered, ['b', 'a', 'c']);
  assert.deepStrictEqual(senderUrls, ['/b']);
  assert.equal(response.body.url, '/b');
});

test('next is idempotent: repeated calls return the first downstream result without resending', async () => {
  let sent = 0;
  const api = createServerInterceptApi(
    { id: 'p', manifest: { capabilities: { serverIntercept: true } } },
    { addDisposable: (d) => d, reportPluginRuntimeError: () => {} },
  );
  disposers.push(
    api.intercept(async (req, next) => {
      const first = await next({ params: { pick: 'first' } });
      const second = await next({ params: { pick: 'second' } });
      return { status: 200, body: [first.body.params.pick, second.body.params.pick] };
    }),
  );
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    async (req) => {
      sent += 1;
      return okSender(req);
    },
  );
  assert.equal(sent, 1);
  assert.deepStrictEqual(response.body, ['first', 'first']);
});

test('short-circuit marks mocked/handledBy; explicit mocked survives', async () => {
  disposers.push(
    registerServerInterceptor('mock', async () => ({ status: 200, body: 'mocked' }), {
      match: '/x',
    }),
    registerServerInterceptor(
      'forward',
      async () => ({ status: 200, body: 'fwd', mocked: false }),
      { match: '/y' },
    ),
  );
  const mocked = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    async () => {
      throw new Error('should not send');
    },
  );
  assert.equal(mocked.mocked, true);
  assert.equal(mocked.handledBy, 'mock');
  const forwarded = await runServerInterceptorChain(
    { method: 'GET', url: '/y', params: {}, headers: {}, origin: { type: 'host' } },
    async () => {
      throw new Error('should not send');
    },
  );
  assert.equal(forwarded.mocked, false);
  assert.equal(forwarded.handledBy, 'forward');
});

test('fail-open: handler throwing before next is reported once and request still goes out', async () => {
  const { api, reported } = createPluginInterceptor();
  disposers.push(
    api.intercept(async () => {
      throw new Error('plugin bug');
    }),
  );
  let sent = 0;
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    async (req) => {
      sent += 1;
      return okSender(req);
    },
  );
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].error.message, 'plugin bug');
  assert.equal(reported[0].source, '服务请求拦截器');
});

test('passthrough network errors are NOT reported as plugin errors', async () => {
  const { api, reported } = createPluginInterceptor();
  const networkError = new Error('network down');
  disposers.push(api.intercept(async (req, next) => next()));
  let sent = 0;
  await assert.rejects(
    runServerInterceptorChain(
      { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
      async () => {
        sent += 1;
        throw networkError;
      },
    ),
    (error) => error === networkError,
  );
  assert.equal(sent, 1);
  assert.deepEqual(reported, []);

  // 插件捕获后原样重抛同一错误对象也不上报
  disposers.push(
    api.intercept(async (req, next) => {
      try {
        return await next();
      } catch (error) {
        throw error;
      }
    }),
  );
  await assert.rejects(
    runServerInterceptorChain(
      { method: 'GET', url: '/y', params: {}, headers: {}, origin: { type: 'host' } },
      async () => {
        throw networkError;
      },
    ),
    (error) => error === networkError,
  );
  assert.deepEqual(reported, []);
});

test('plugin error after consuming next is reported once and returns the downstream result', async () => {
  const { api, reported } = createPluginInterceptor();
  disposers.push(
    api.intercept(async (req, next) => {
      const response = await next();
      if (response.body.url === '/boom') throw new Error('process failed');
      return response;
    }),
  );
  let sent = 0;
  const sender = async (req) => {
    sent += 1;
    return okSender(req);
  };
  // 约定行为：消费 next 之后的插件异常只上报、不传播，链回退到下游结果（fail-open）
  const failed = await runServerInterceptorChain(
    { method: 'GET', url: '/boom', params: {}, headers: {}, origin: { type: 'host' } },
    sender,
  );
  assert.equal(failed.status, 200);
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/ok', params: {}, headers: {}, origin: { type: 'host' } },
    sender,
  );
  assert.equal(sent, 2);
  assert.equal(response.status, 200);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].error.message, 'process failed');
});

test('interceptor without capability or with invalid return falls through safely', async () => {
  assert.throws(
    () =>
      createServerInterceptApi(
        { id: 'no-cap', manifest: { capabilities: {} } },
        { addDisposable: (d) => d, reportPluginRuntimeError: () => {} },
      ).intercept(async (req, next) => next()),
    /serverIntercept/,
  );

  const bare = createServerInterceptApi(
    { id: 'p2', manifest: { capabilities: { serverIntercept: true } } },
    { addDisposable: (d) => d, reportPluginRuntimeError: () => {} },
  );
  disposers.push(
    bare.intercept(async () => undefined), // 非法返回值 → 兜底透传
    bare.intercept(async (req, next) => next(), { match: () => true }),
  );
  let sent = 0;
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    async (req) => {
      sent += 1;
      return okSender(req);
    },
  );
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
  assert.equal(hasServerInterceptors(), true);
});

test('non-HTTP status values fall through instead of short-circuiting', async () => {
  assert.equal(isValidServerResponse({ status: 200, body: null }), true);
  assert.equal(isValidServerResponse({ status: 404 }), true);
  assert.equal(isValidServerResponse({ status: 0 }), false);
  assert.equal(isValidServerResponse({ status: Number.NaN }), false);
  assert.equal(isValidServerResponse({ status: 99 }), false);
  assert.equal(isValidServerResponse({ status: 600 }), false);

  let sent = 0;
  disposers.push(
    registerServerInterceptor('bad-status', async () => ({ status: 0, body: 'not http' })),
  );
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    async (req) => {
      sent += 1;
      return okSender(req);
    },
  );
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
});

test('request origin marker is captured in sync segment and restored immediately', async () => {
  assert.deepEqual(getCurrentRequestOrigin(), { type: 'host' });
  const captured = runWithRequestOrigin({ type: 'plugin', pluginId: 'p' }, () =>
    getCurrentRequestOrigin(),
  );
  assert.deepEqual(captured, { type: 'plugin', pluginId: 'p' });
  assert.deepEqual(getCurrentRequestOrigin(), { type: 'host' });

  // fn 返回未决 Promise 时 ambient 已恢复；同步段（await 之前）标记仍生效——
  // 这正是 kugou.ts 在同步包裹内读取来源所依赖的行为
  let syncObserved;
  let asyncObserved;
  const promise = runWithRequestOrigin({ type: 'plugin', pluginId: 'p' }, async () => {
    syncObserved = getCurrentRequestOrigin();
    await Promise.resolve();
    asyncObserved = getCurrentRequestOrigin();
  });
  assert.deepEqual(getCurrentRequestOrigin(), { type: 'host' });
  await promise;
  assert.deepEqual(syncObserved, { type: 'plugin', pluginId: 'p' });
  assert.deepEqual(asyncObserved, { type: 'host' });
});

test('plugin interceptor re-entry sees plugin origin in the sync segment', async () => {
  const { api } = createPluginInterceptor();
  let syncObserved;
  let asyncObserved;
  disposers.push(
    api.intercept(async (req, next) => {
      syncObserved = getCurrentRequestOrigin();
      await Promise.resolve();
      asyncObserved = getCurrentRequestOrigin();
      return next();
    }),
  );
  const response = await runServerInterceptorChain(
    { method: 'GET', url: '/x', params: {}, headers: {}, origin: { type: 'host' } },
    okSender,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(syncObserved, { type: 'plugin', pluginId: 'test-plugin' });
  assert.deepEqual(asyncObserved, { type: 'host' });
  assert.deepEqual(getCurrentRequestOrigin(), { type: 'host' });
});

test('isNowPlayingCommand validates string and object commands including adjustVolume delta', () => {
  assert.equal(isNowPlayingCommand('togglePlayback'), true);
  assert.equal(isNowPlayingCommand('unknownCommand'), false);
  assert.equal(isNowPlayingCommand(null), false);
  assert.equal(isNowPlayingCommand({ type: 'seek', value: 10 }), true);
  assert.equal(isNowPlayingCommand({ type: 'setVolume', value: 0 }), true);
  assert.equal(isNowPlayingCommand({ type: 'setVolume', value: Number.NaN }), false);
  assert.equal(isNowPlayingCommand({ type: 'seek', delta: 10 }), false);
  assert.equal(isNowPlayingCommand({ type: 'adjustVolume', delta: 5 }), true);
  assert.equal(isNowPlayingCommand({ type: 'adjustVolume', delta: -5 }), true);
  assert.equal(isNowPlayingCommand({ type: 'adjustVolume', value: 5 }), false);
  assert.equal(isNowPlayingCommand({ type: 'adjustVolume' }), false);
  assert.equal(isNowPlayingCommand({ type: 'adjustVolume', delta: '5' }), false);
});

test('isLyricsPageKeyOwnedBy parses keys without throwing on foreign formats', () => {
  const key = JSON.stringify(['my-plugin', 'my-page']);
  assert.equal(isLyricsPageKeyOwnedBy(key, 'my-plugin'), true);
  assert.equal(isLyricsPageKeyOwnedBy(key, 'other-plugin'), false);
  assert.equal(isLyricsPageKeyOwnedBy('host:cover', 'host'), false);
  assert.equal(isLyricsPageKeyOwnedBy('not json {', 'x'), false);
});
