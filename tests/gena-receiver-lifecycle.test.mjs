import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const code = transformSync(
  readFileSync(new URL('../src/main/mediaTransport/genaReceiver.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
const { GenaReceiver, parseLastChange } = mod.exports;
const xml = '<Event><InstanceID val="0"><TransportState val="PLAYING"/></InstanceID></Event>';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not finish')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t) {
  const events = [];
  const receiver = new GenaReceiver({
    bindHost: '127.0.0.1',
    onLastChange: (sid, change) => events.push({ sid, change }),
  });
  await receiver.start();
  const server = receiver.server;
  t.after(async () => {
    server.closeAllConnections();
    receiver.server?.closeAllConnections();
    await bounded(receiver.stop());
  });
  return { receiver, server, events };
}
function notify(
  receiver,
  { sid = 'uuid:test', token = 'callback', method = 'NOTIFY', headers = {} } = {},
) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      receiver.callbackUrl('avt', token),
      {
        method,
        agent: false,
        headers: { SID: sid, NT: 'upnp:event', NTS: 'upnp:propchange', ...headers },
      },
      (res) => {
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
        res.on('error', reject);
      },
    );
    request.on('error', reject);
  });
  // A stop may reject before its caller starts awaiting the response.
  void response.catch(() => {});
  return { request, response };
}
async function send(receiver, options = {}, body = xml) {
  const { request, response } = notify(receiver, options);
  request.end(body);
  return bounded(response);
}

test('concurrent GENA starts share a nonzero bound port', async (t) => {
  const receiver = new GenaReceiver({ bindHost: '127.0.0.1' });
  const first = receiver.start();
  const second = receiver.start();
  const ports = await Promise.all([first, second]);
  t.after(() => receiver.stop());
  assert.ok(ports.every((port) => port > 0));
  assert.equal(ports[0], ports[1]);
});

test('a failed GENA listen can retry on a free port', async (t) => {
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const receiver = new GenaReceiver({ bindHost: '127.0.0.1' });
  t.after(async () => {
    receiver.server?.closeAllConnections();
    await receiver.stop();
    await new Promise((resolve) => occupied.close(resolve));
  });
  await assert.rejects(receiver.start(occupied.address().port), { code: 'EADDRINUSE' });
  assert.equal(receiver.port, 0);
  assert.ok((await receiver.start()) > 0);
});

test('stopping during GENA startup completes and allows a fresh start', async (t) => {
  const receiver = new GenaReceiver({ bindHost: '127.0.0.1' });
  const starting = receiver.start();
  const server = receiver.server;
  const stopping = receiver.stop();
  t.after(async () => {
    server.closeAllConnections();
    receiver.server?.closeAllConnections();
    await receiver.stop();
  });
  await bounded(Promise.all([starting, stopping]));
  assert.equal(receiver.port, 0);
  assert.ok((await receiver.start()) > 0);
});

test('GENA stop closes a partially uploaded event and clears the bound port', async (t) => {
  const { receiver, server, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const handled = once(server, 'request');
  const { request, response } = notify(receiver);
  request.write('<Event>');
  await handled;
  try {
    await bounded(receiver.stop());
    assert.equal(receiver.port, 0);
    await assert.rejects(response);
    assert.equal(events.length, 0);
  } finally {
    request.destroy();
    server.closeAllConnections();
  }
});

test('known GENA subscriptions retain NOTIFY and POST delivery', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  assert.equal((await send(receiver)).status, 200);
  assert.equal((await send(receiver, { method: 'POST' })).status, 200);
  assert.equal(events.length, 2);
  assert.equal(events[0].change.fields.TransportState, 'PLAYING');
});

test('a temporary GENA token accepts the first SID but cannot admit another SID', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  assert.equal((await send(receiver)).status, 200);
  assert.equal((await send(receiver, { sid: 'uuid:other' })).status, 412);
  assert.equal(events.length, 1);
});

test('revoking a temporary token removes its provisional SID authorization', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  await send(receiver);
  receiver.disarmToken('callback');
  assert.equal((await send(receiver)).status, 412);
  assert.equal((await send(receiver, { sid: 'uuid:other' })).status, 412);
  assert.equal(events.length, 1);
});

test('promoting an initial SID preserves it after the temporary token is revoked', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  await send(receiver);
  receiver.trackSubscription('uuid:test');
  receiver.disarmToken('callback');
  assert.equal((await send(receiver)).status, 200);
  receiver.untrackSubscription('uuid:test');
  assert.equal((await send(receiver)).status, 412);
  assert.equal(events.length, 2);
});

test('an armed GENA callback still requires a nonempty SID', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  assert.equal((await send(receiver, { sid: '' })).status, 412);
  assert.equal(events.length, 0);
});

test('tracking a confirmed SID cannot leave its temporary token open to other SIDs', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  await send(receiver);
  receiver.trackSubscription('uuid:test');
  assert.equal((await send(receiver, { sid: 'uuid:other' })).status, 412);
  assert.equal(events.length, 1);
});

test('untracking a provisional SID also revokes its temporary token', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.armToken('callback');
  await send(receiver);
  receiver.untrackSubscription('uuid:test');
  assert.equal((await send(receiver)).status, 412);
  assert.equal(events.length, 1);
});

test('an event whose SID was revoked while its body was uploading is not delivered', async (t) => {
  const { receiver, server, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const handled = once(server, 'request');
  const { request, response } = notify(receiver);
  request.write('<Event>');
  await handled;
  receiver.untrackSubscription('uuid:test');
  request.end('<TransportState val="PLAYING"/></Event>');
  assert.equal((await bounded(response)).status, 412);
  assert.equal(events.length, 0);
});

test('reusing a SID for a new subscription cannot authorize an old in-flight body', async (t) => {
  const { receiver, server, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const handled = once(server, 'request');
  const { request, response } = notify(receiver);
  request.write('<Event>');
  await handled;
  receiver.untrackSubscription('uuid:test');
  receiver.trackSubscription('uuid:test');
  request.end('<TransportState val="PLAYING"/></Event>');
  assert.equal((await bounded(response)).status, 412);
  assert.equal(events.length, 0);
  assert.equal((await send(receiver)).status, 200);
});

test('an initial event uploading during subscription promotion remains authorized', async (t) => {
  const { receiver, server, events } = await fixture(t);
  receiver.armToken('callback');
  const handled = once(server, 'request');
  const { request, response } = notify(receiver);
  request.write('<Event>');
  await handled;
  receiver.trackSubscription('uuid:test');
  receiver.disarmToken('callback');
  request.end('<TransportState val="PLAYING"/></Event>');
  assert.equal((await bounded(response)).status, 200);
  assert.equal(events.length, 1);
});

test('GENA rejects an oversized declared body before waiting for it', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const { request, response } = notify(receiver, {
    headers: { 'Content-Length': 1024 * 1024 + 1 },
  });
  request.flushHeaders();
  try {
    assert.equal((await bounded(response)).status, 413);
    assert.equal(events.length, 0);
  } finally {
    request.destroy();
  }
});

test('GENA rejects oversized chunked bodies without parsing or delivering them', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const { request, response } = notify(receiver);
  try {
    await new Promise((resolve, reject) =>
      request.write(' '.repeat(1024 * 1024), (error) => (error ? reject(error) : resolve())),
    );
    request.write(xml);
    assert.equal((await bounded(response)).status, 413);
    assert.equal(events.length, 0);
  } finally {
    request.destroy();
  }
});

test('valid near-limit GENA events remain supported', async (t) => {
  const { receiver, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  assert.equal(
    (await send(receiver, {}, xml + ' '.repeat(1024 * 1024 - Buffer.byteLength(xml)))).status,
    200,
  );
  assert.equal(events.length, 1);
});

test('unknown SIDs and unsupported methods cannot publish events', async (t) => {
  const { receiver, events } = await fixture(t);
  assert.equal((await send(receiver)).status, 412);
  assert.equal((await send(receiver, { method: 'GET' }, '')).status, 405);
  assert.equal(events.length, 0);
});

test('an escaped LastChange property is decoded before extracting transport fields', () => {
  const escaped = xml
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  assert.equal(
    parseLastChange(`<e:property><LastChange>${escaped}</LastChange></e:property>`)?.values
      .TransportState,
    'PLAYING',
  );
});

test('XML attribute entities are decoded once without interpreting escaped literal entities', () => {
  assert.equal(
    parseLastChange(
      '<Event><AVTransportURI val="https://cdn.example/a?title=&amp;lt;demo&amp;gt;&amp;x=1"/></Event>',
    ).values.AVTransportURI,
    'https://cdn.example/a?title=&lt;demo&gt;&x=1',
  );
});

test('GENA fields do not match another tag with the same prefix', () => {
  for (const tag of ['TransportStateExtra', 'TransportState-extra', 'TransportState:Extra']) {
    assert.equal(parseLastChange(`<Event><${tag} val="STOPPED"/></Event>`), null);
  }
});

test('aborted event uploads cannot publish partial state', async (t) => {
  const { receiver, server, events } = await fixture(t);
  receiver.trackSubscription('uuid:test');
  const handled = once(server, 'request');
  const { request } = notify(receiver);
  request.write('<TransportState val="PLAYING"/>');
  await handled;
  request.destroy();
  await tick();
  assert.equal(events.length, 0);
});
