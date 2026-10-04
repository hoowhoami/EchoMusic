import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import axios from 'axios';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const code = transformSync(
  readFileSync(new URL('../src/main/electronAxiosAdapter.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('transport did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function fixture(onEnd = () => {}) {
  const requests = [];
  const hooks = {};
  const session = {
    webRequest: Object.fromEntries(
      ['onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred'].map((key) => [
        key,
        (_filter, callback) => (hooks[key] = callback),
      ]),
    ),
  };
  const mocks = {
    electron: {
      net: {
        request(options) {
          const request = new EventEmitter();
          request.options = options;
          request.writes = [];
          request.aborted = false;
          request.write = (chunk) => request.writes.push(chunk);
          request.end = () => queueMicrotask(() => onEnd(request));
          request.abort = () => {
            if (request.aborted) return;
            request.aborted = true;
            request.emit('abort');
            request.response?.emit('aborted');
            request.emit('close');
          };
          request.respond = (headers = {}) => {
            const response = new PassThrough();
            Object.assign(response, { statusCode: 200, statusMessage: 'OK', headers });
            request.response = response;
            request.emit('response', response);
            return response;
          };
          requests.push(request);
          return request;
        },
      },
    },
    './networkPolicy': {
      APP_NETWORK_SESSION_PARTITION: 'test',
      attachProxyLoginHandler() {},
      getManagedNetworkSession: async () => session,
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => mocks[name] ?? require(name),
    mod,
    mod.exports,
  );
  const adapter = mod.exports.createElectronAxiosAdapter(axios);
  const client = axios.create({ adapter });
  const raw = (options, customRuntime) =>
    mod.exports.createElectronAxiosAdapter({
      ...axios,
      getAdapter: () => async (config) => {
        const response = await config.env.fetch(
          new Request(config.url, {
            method: config.data ? 'POST' : 'GET',
            headers: config.headers.toJSON(),
            body: config.data,
            signal: config.signal,
            duplex: 'half',
          }),
        );
        return { data: response, headers: {}, status: response.status };
      },
      ...customRuntime,
    })({ url: 'http://example.test', headers: axios.AxiosHeaders.from({}), ...options });
  return { requests, client, raw };
}

test('bounded responses propagate source errors instead of hanging the Axios reader', async () => {
  const f = fixture((request) => {
    const source = request.respond();
    source.write('partial');
    setImmediate(() =>
      source.destroy(Object.assign(new Error('socket failed'), { code: 'ECONNRESET' })),
    );
  });
  await assert.rejects(bounded(f.client.get('http://example.test', { maxContentLength: 100 })), {
    code: 'ECONNRESET',
  });
  assert.equal(f.requests[0].aborted, true);
});

for (const consumed of [false, true]) {
  test(`cancelling a bounded response destroys the source and aborts Chromium (consumed=${consumed})`, async () => {
    const f = fixture((request) => {
      const source = request.respond();
      if (consumed) source.write('partial');
    });
    const { data: response } = await bounded(f.raw({ maxContentLength: 100 }));
    const reader = response.body.getReader();
    if (consumed) assert.equal((await bounded(reader.read())).done, false);
    await bounded(reader.cancel());
    await turn();
    assert.equal(f.requests[0].response.destroyed, true);
    assert.equal(f.requests[0].aborted, true);
  });
}

for (const maxContentLength of [-1, 100]) {
  test(`an aborted response rejects its reader with maxContentLength=${maxContentLength}`, async () => {
    const f = fixture((request) => {
      request.respond().write('partial');
      setImmediate(() => request.response.emit('aborted'));
    });
    await assert.rejects(bounded(f.client.get('http://example.test', { maxContentLength })), {
      code: 'ECONNRESET',
    });
  });
  test(`a request error after headers rejects its body with maxContentLength=${maxContentLength}`, async () => {
    const f = fixture((request) => {
      request.respond().write('partial');
      setImmediate(() =>
        request.emit('error', Object.assign(new Error('connection lost'), { code: 'EIO' })),
      );
    });
    await assert.rejects(bounded(f.client.get('http://example.test', { maxContentLength })), {
      code: 'EIO',
    });
  });
}

for (const headers of [{}, { 'content-length': '20' }]) {
  test(`response size overflow preserves ERR_BAD_RESPONSE (${JSON.stringify(headers)})`, async () => {
    const f = fixture((request) => request.respond(headers).end('long response'));
    await assert.rejects(bounded(f.client.get('http://example.test', { maxContentLength: 3 })), {
      code: 'ERR_BAD_RESPONSE',
    });
    assert.equal(f.requests[0].aborted, true);
  });
}

test('upload size overflow cancels the producer and preserves ERR_BAD_REQUEST', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = fixture();
  await assert.rejects(bounded(f.raw({ data: body, maxBodyLength: 3 })), {
    code: 'ERR_BAD_REQUEST',
  });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(f.requests[0].writes.length, 0);
});

test('abort cancels a stalled upload reader and releases its lock', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => (cancelled = true) });
  const controller = new AbortController();
  const f = fixture();
  const pending = bounded(f.raw({ data: body, signal: controller.signal }));
  await turn();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await turn();
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(f.requests[0].writes.length, 0);
});

test('adapter construction failures release their request context', async () => {
  const f = fixture();
  let captured;
  await assert.rejects(
    f.raw(
      {},
      {
        getAdapter(_name, config) {
          captured = config;
          throw new Error('adapter unavailable');
        },
      },
    ),
    /adapter unavailable/,
  );
  await assert.rejects(
    bounded(
      captured.env.fetch(
        new Request(captured.url, {
          headers: captured.headers.toJSON(),
        }),
      ),
    ),
    /Unknown Chromium transport request context/,
  );
  assert.equal(f.requests.length, 0);
});

test('successful bounded responses and uploads retain their data and finish normally', async () => {
  const f = fixture((request) => request.respond({ 'content-length': '2' }).end('ok'));
  const response = await bounded(
    f.client.post('http://example.test', 'hello', {
      maxBodyLength: 5,
      maxContentLength: 2,
    }),
  );
  assert.equal(response.data, 'ok');
  assert.equal(Buffer.concat(f.requests[0].writes).toString(), 'hello');
  assert.equal(f.requests[0].aborted, false);
});
