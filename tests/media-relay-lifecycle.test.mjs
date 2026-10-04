import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const code = transformSync(
  readFileSync(new URL('../src/main/mediaTransport/mediaServer.ts', import.meta.url), 'utf8') +
    '\nexport { sliceBytes };',
  { loader: 'ts', format: 'cjs' },
).code;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
const { MediaServer, parseRange, sliceBytes } = mod.exports;
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function bounded(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not finish')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function download(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, ...options }, (response) => {
      const parts = [];
      response.on('data', (chunk) => parts.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(parts),
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const relay = new MediaServer({ bindHost: '127.0.0.1' });
  await relay.start();
  const nativeServer = relay.server;
  t.after(async () => {
    nativeServer.closeAllConnections();
    upstream.closeAllConnections();
    await bounded(relay.stop());
    await new Promise((resolve) => upstream.close(resolve));
  });
  const register = (session = 'test', length = 10000) =>
    relay.registerResource(
      {
        source: { kind: 'http', url: `http://127.0.0.1:${upstream.address().port}/song` },
        mime: 'audio/mpeg',
        length,
      },
      session,
    );
  return { relay, upstream, register };
}

test('a reversed byte range is rejected before producing a negative content length', () => {
  assert.deepEqual(parseRange('bytes=7-3', 20), { range: null, unsatisfiable: true });
  assert.equal(parseRange('bytes=0-0', 0).unsatisfiable, true);
});
test('range slicing ends once the requested bytes arrive, without waiting for upstream EOF', async () => {
  const source = new PassThrough();
  const sliced = sliceBytes(source, 3, 4);
  const result = (async () => {
    const parts = [];
    for await (const chunk of sliced) parts.push(chunk);
    return Buffer.concat(parts);
  })();
  source.write('0123456789');
  try {
    assert.equal((await bounded(result)).toString(), '3456');
    assert.equal(source.destroyed, true);
  } finally {
    source.destroy();
    sliced.destroy();
    await result.catch(() => {});
  }
});
test('cancelling an unfinished range also destroys the source', async () => {
  const source = new PassThrough();
  const sliced = sliceBytes(source, 10, 100);
  sliced.on('error', () => {});
  sliced.resume();
  source.write('abc');
  await turn();
  sliced.destroy();
  await turn();
  try {
    assert.equal(source.destroyed, true);
  } finally {
    source.destroy();
  }
});
test('a slow range reader keeps the upstream paused instead of buffering the whole resource', async (t) => {
  const source = new PassThrough({ highWaterMark: 1024 });
  const sliced = sliceBytes(source, 0, 16 * 1024 * 1024);
  sliced.on('error', () => {});
  sliced.read(1);
  const chunk = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 100; i++) {
    if (!source.write(chunk)) await turn();
  }
  await turn();
  try {
    const buffered = sliced.readableLength + (sliced.writableLength ?? 0);
    t.diagnostic(`slice buffer with a stalled reader: ${buffered} bytes`);
    assert.ok(buffered <= 2 * chunk.length, `buffered ${buffered} bytes`);
  } finally {
    sliced.destroy();
    source.destroy();
  }
});
test('concurrent starts both resolve to the bound port', async () => {
  const relay = new MediaServer({ bindHost: '127.0.0.1' });
  try {
    const ports = await Promise.all([relay.start(), relay.start()]);
    assert.ok(ports[0] > 0);
    assert.deepEqual(ports, [ports[0], ports[0]]);
  } finally {
    await relay.stop();
  }
});
test('a failed listen can be retried on the same media server', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('ok'));
  const relay = new MediaServer({ bindHost: '127.0.0.1' });
  try {
    await assert.rejects(relay.start(f.upstream.address().port), { code: 'EADDRINUSE' });
    assert.ok((await relay.start()) > 0);
  } finally {
    await relay.stop();
  }
});

test('a synchronous listen failure also permits a later valid start', async () => {
  const relay = new MediaServer({ bindHost: '127.0.0.1' });
  try {
    await assert.rejects(relay.start(-1));
    assert.ok((await relay.start()) > 0);
  } finally {
    await relay.stop();
  }
});

test('an unsupported method returns an empty complete 405 response', async (t) => {
  const f = await fixture(t, () => assert.fail('unsupported method reached upstream'));
  const result = await bounded(download(f.register().url, { method: 'POST' }));
  assert.equal(result.status, 405);
  assert.equal(result.body.length, 0);
});
test('stop during startup completes without a stale port and the service can restart', async () => {
  const relay = new MediaServer({ bindHost: '127.0.0.1' });
  const starting = relay.start();
  const nativeServer = relay.server;
  const stopping = relay.stop();
  try {
    await bounded(Promise.all([starting, stopping]));
    assert.equal(relay.port, 0);
    assert.equal(relay.urlBase, '');
    assert.ok((await relay.start()) > 0);
    await relay.stop();
  } finally {
    nativeServer.closeAllConnections();
    nativeServer.close(() => {});
  }
});
test('an ignored HTTP range stops reading upstream immediately after the requested slice', async (t) => {
  let closed;
  const done = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, (_req, res) => {
    res.once('close', closed);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 10000 });
    res.write('0123456789');
  });
  const resource = f.register();
  const result = await bounded(download(resource.url, { headers: { Range: 'bytes=3-6' } }));
  assert.equal(result.status, 206);
  assert.equal(result.body.toString(), '3456');
  await bounded(done);
});
test('a client disconnect before upstream headers cancels the pending upstream request', async (t) => {
  let requested, closed;
  const seen = new Promise((resolve) => {
    requested = resolve;
  });
  const done = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, (_req, res) => {
    res.once('close', closed);
    requested();
  });
  const resource = f.register();
  const client = http.get(resource.url, { agent: false });
  client.on('error', () => {});
  await bounded(seen);
  client.destroy();
  await bounded(done);
});
test('rejected upstream status closes its body and returns a complete empty error response', async (t) => {
  let closed;
  const done = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, (_req, res) => {
    res.once('close', closed);
    res.writeHead(503, { 'content-type': 'text/plain', 'content-length': 10000 });
    res.write('unavailable');
  });
  const resource = f.register();
  const result = await bounded(download(resource.url));
  assert.equal(result.status, 503);
  assert.equal(result.body.length, 0);
  await bounded(done);
});
for (const action of ['token', 'session', 'stop']) {
  test(`${action} cleanup terminates an active relay and its upstream connection`, async (t) => {
    let closed;
    const done = new Promise((resolve) => {
      closed = resolve;
    });
    const f = await fixture(t, (_req, res) => {
      res.once('close', closed);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 10000 });
      res.write('partial');
    });
    const resource = f.register();
    const client = http.get(resource.url, { agent: false });
    client.on('error', () => {});
    const [response] = await bounded(once(client, 'response'));
    response.on('error', () => {});
    response.resume();
    try {
      if (action === 'token') f.relay.revokeToken(resource.token);
      if (action === 'session') f.relay.revokeSession('test');
      if (action === 'stop') await bounded(f.relay.stop());
      await bounded(done);
      assert.equal(f.relay.activeResourceCount, 0);
    } finally {
      client.destroy();
    }
  });
}

test('revoking one session leaves another active transfer intact', async (t) => {
  const upstreamResponses = [];
  const f = await fixture(t, (_req, res) => {
    upstreamResponses.push(res);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 10000 });
    res.write('partial');
  });
  const clients = [];
  try {
    for (const session of ['a', 'b']) {
      const client = http.get(f.register(session).url, { agent: false });
      client.on('error', () => {});
      clients.push(client);
      const [response] = await bounded(once(client, 'response'));
      response.on('error', () => {});
      response.resume();
    }
    const closed = once(upstreamResponses[0], 'close');
    f.relay.revokeSession('a');
    await bounded(closed);
    assert.equal(upstreamResponses[1].destroyed, false);
    assert.equal(f.relay.activeResourceCount, 1);
  } finally {
    for (const client of clients) client.destroy();
  }
});
