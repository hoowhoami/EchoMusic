import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { MediaServer, parseRange } from '../src/main/mediaTransport/mediaServer.ts';

function collect(res: http.IncomingMessage, chunkSize = 0): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
}

function request(port: number, urlPath: string, options: { method?: string; range?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers: options.range ? { Range: options.range } : {} }, (res) => {
      collect(res).then(resolve, reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const data = Buffer.from('0123456789abcdefghij', 'utf8'); // 20 bytes
let tmpDir: string;
let filePath: string;
let server: MediaServer;
let port: number;
let token: string;

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'echo-media-'));
  filePath = path.join(tmpDir, 'track.mp3');
  await writeFile(filePath, data);
  server = new MediaServer({ bindHost: '127.0.0.1', log: () => {} });
  port = await server.start(0);
  const res = server.registerResource({ source: { kind: 'file', path: filePath }, mime: 'audio/mpeg', length: data.length }, 'test-session');
  assert.ok(res);
  token = res.token;
});

after(async () => {
  await server.stop();
});

test('parseRange: suffix, open-ended and unsatisfiable forms', () => {
  assert.deepEqual(parseRange('bytes=0-4', 20), { range: { start: 0, end: 4 }, unsatisfiable: false });
  assert.deepEqual(parseRange('bytes=10-', 20), { range: { start: 10, end: 19 }, unsatisfiable: false });
  assert.deepEqual(parseRange('bytes=-5', 20), { range: { start: 15, end: 19 }, unsatisfiable: false });
  assert.deepEqual(parseRange('bytes=20-', 20), { range: null, unsatisfiable: true });
  assert.equal(parseRange('bytes=0-4', null).unsatisfiable, false);
  assert.equal(parseRange(undefined, 20).range, null);
});

test('GET without Range returns 200 with full body and correct Content-Type/Length', async () => {
  const res = await request(port, `/res/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(Number(res.headers['content-length']), data.length);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.body.toString('utf8'), data.toString('utf8'));
});

test('Range returns 206 with Content-Range and sliced body', async () => {
  const res = await request(port, `/res/${token}`, { range: 'bytes=3-7' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 3-7/${data.length}`);
  assert.equal(Number(res.headers['content-length']), 5);
  assert.equal(res.body.toString('utf8'), '34567');
});

test('suffix Range works and repeatable ranges stay alive', async () => {
  const first = await request(port, `/res/${token}`, { range: 'bytes=-5' });
  assert.equal(first.status, 206);
  assert.equal(first.body.toString('utf8'), 'fghij');
  const again = await request(port, `/res/${token}`, { range: 'bytes=-5' });
  assert.equal(again.body.toString('utf8'), 'fghij');
});

test('out-of-range start yields 416 with Content-Range */len', async () => {
  const res = await request(port, `/res/${token}`, { range: 'bytes=100-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${data.length}`);
  assert.equal(res.body.length, 0);
});

test('HEAD is header-only', async () => {
  const res = await request(port, `/res/${token}`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), data.length);
  assert.equal(res.body.length, 0);
});

test('unknown token is forbidden, unknown path is 404', async () => {
  assert.equal((await request(port, '/res/bead64b0deadbeef')).status, 403);
  assert.equal((await request(port, '/other')).status, 404);
  assert.equal((await request(port, '/../etc/passwd')).status, 404);
});

test('client abort during download cancels the stream and server stays healthy', async () => {
  const req = http.request({ host: '127.0.0.1', port, path: `/res/${token}`, method: 'GET' }, (res) => {
    res.on('data', () => req.destroy());
  });
  req.on('error', () => {});
  await new Promise<void>((resolve) => {
    req.flushHeaders();
    req.on('close', () => resolve());
  });
  req.end();
  // 服务器不应崩溃，且其他请求仍正常。
  const res = await request(port, `/res/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), data.toString('utf8'));
});

test('revokeSession removes all tokens for the session', async () => {
  const other = new MediaServer({ bindHost: '127.0.0.1', log: () => {} });
  const port2 = await other.start(0);
  const r1 = other.registerResource({ source: { kind: 'file', path: filePath }, mime: 'audio/mpeg', length: data.length }, 'sess-a');
  const r2 = other.registerResource({ source: { kind: 'file', path: filePath }, mime: 'audio/mpeg', length: data.length }, 'sess-b');
  assert.ok(r1 && r2);
  other.revokeSession('sess-a');
  assert.equal((await request(port2, `/res/${r1.token}`)).status, 403);
  assert.equal((await request(port2, `/res/${r2.token}`)).status, 200);
  await other.stop();
});

test('http relay honors range even when upstream ignores Range', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': data.length, 'content-type': 'application/octet-stream' });
    res.end(data); // 忽略 Range 全量返回
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upstreamAddr = upstream.address();
  assert.ok(upstreamAddr && typeof upstreamAddr === 'object');

  const relay = new MediaServer({ bindHost: '127.0.0.1', log: () => {} });
  try {
    const relayPort = await relay.start(0);
    const res = relay.registerResource(
      {
        source: { kind: 'http', url: `http://127.0.0.1:${upstreamAddr.port}/song.mp3` },
        mime: 'audio/mpeg',
        length: data.length,
      },
      'relay-session',
    );
    assert.ok(res);
    const out = await request(relayPort, `/res/${res.token}`, { range: 'bytes=8-11' });
    assert.equal(out.status, 206);
    assert.equal(out.headers['content-range'], `bytes 8-11/${data.length}`);
    assert.equal(out.body.toString('utf8'), '89ab');
    // 后缀范围同样正确截断
    const out2 = await request(relayPort, `/res/${res.token}`, { range: 'bytes=-4' });
    assert.equal(out2.status, 206);
    assert.equal(out2.body.toString('utf8'), 'ghij');
  } finally {
    await relay.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('relay passes through a well-formed upstream 206', async () => {
  const upstream = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec((req.headers.range as string) ?? '');
    if (m) {
      const [s, e] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${data.length}`, 'content-length': e - s + 1 });
      res.end(data.subarray(s, e + 1));
      return;
    }
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const addr = upstream.address();
  assert.ok(addr && typeof addr === 'object');

  const relay = new MediaServer({ bindHost: '127.0.0.1', log: () => {} });
  try {
    const relayPort = await relay.start(0);
    const res = relay.registerResource({ source: { kind: 'http', url: `http://127.0.0.1:${addr.port}/song.mp3` }, mime: 'audio/mpeg', length: data.length }, 'relay2');
    assert.ok(res);
    const out = await request(relayPort, `/res/${res.token}`, { range: 'bytes=0-1' });
    assert.equal(out.status, 206);
    assert.equal(out.body.toString('utf8'), '01');
  } finally {
    await relay.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});