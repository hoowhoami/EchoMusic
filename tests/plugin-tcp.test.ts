import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createPluginTcpManager } from '../src/main/plugins/tcp.ts';

const fixture = async (t: TestContext, accept: (socket: Socket) => void = () => {}) => {
  const clients: Socket[] = [];
  const peers: Socket[] = [];
  const keepAliveCalls: unknown[][] = [];
  const manager = createPluginTcpManager(() => {
    const socket = new Socket();
    const setKeepAlive = socket.setKeepAlive.bind(socket);
    socket.setKeepAlive = (enable, delay) => {
      keepAliveCalls.push([enable, delay]);
      return setKeepAlive(enable, delay);
    };
    clients.push(socket);
    return socket;
  });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.push(socket);
    socket.on('error', () => {});
    accept(socket);
  });
  t.after(async () => {
    manager.closeAll();
    peers.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const options = { host: '127.0.0.1', port: address.port };
  return { manager, options, clients, peers, keepAliveCalls };
};

test(
  'TCP preserves binary slices, write order and fragmented byte streams',
  { timeout: 5000 },
  async (t) => {
    const { manager, options } = await fixture(t, (socket) => socket.pipe(socket));
    await manager.connect(1, 'rgb', 'a', options);
    const bytes = new Uint8Array([99, 0, 255, 128, 1, 99]);
    await Promise.all([
      manager.write(1, 'rgb', 'a', bytes.subarray(1, 5)),
      manager.write(1, 'rgb', 'a', new Uint8Array([2, 3]).buffer),
    ]);
    let received = Buffer.alloc(0);
    while (received.length < 6) {
      const part = await manager.read(1, 'rgb', 'a');
      assert(part);
      received = Buffer.concat([received, Buffer.from(part)]);
    }
    assert.deepEqual([...received], [0, 255, 128, 1, 2, 3]);
  },
);

test(
  'TCP drains final data in bounded chunks before reporting EOF',
  { timeout: 5000 },
  async (t) => {
    const expected = Buffer.alloc(200_000, 0xab);
    const { manager, options } = await fixture(t, (socket) => socket.end(expected));
    await manager.connect(1, 'rgb', 'a', options);
    const parts: Buffer[] = [];
    for (;;) {
      const part = await manager.read(1, 'rgb', 'a');
      if (part === null) break;
      assert(part.byteLength > 0 && part.byteLength <= 65536);
      parts.push(Buffer.from(part));
    }
    assert.deepEqual(Buffer.concat(parts), expected);
    manager.close(1, 'rgb', 'a');
    manager.close(1, 'rgb', 'a');
  },
);

test(
  'TCP isolates handles by owner and plugin, and rejects concurrent reads',
  { timeout: 5000 },
  async (t) => {
    const { manager, options } = await fixture(t);
    await manager.connect(1, 'rgb', 'a', options);
    await assert.rejects(manager.read(2, 'rgb', 'a'), /不存在/);
    await assert.rejects(manager.write(1, 'other', 'a', new Uint8Array([1])), /不存在/);
    manager.close(2, 'rgb', 'a');
    const read = manager.read(1, 'rgb', 'a');
    const canceled = assert.rejects(read, /关闭/);
    await assert.rejects(manager.read(1, 'rgb', 'a'), /一个待完成/);
    manager.close(1, 'rgb', 'a');
    await canceled;
  },
);

test(
  'owner/plugin/global cleanup cancels reads and leaves unrelated handles usable',
  { timeout: 5000 },
  async (t) => {
    const { manager, options } = await fixture(t, (socket) => socket.pipe(socket));
    for (const [owner, plugin] of [
      [1, 'rgb'],
      [2, 'rgb'],
      [2, 'other'],
    ] as const) {
      await manager.connect(owner, plugin, 'a', options);
    }
    const first = assert.rejects(manager.read(1, 'rgb', 'a'), /关闭/);
    manager.closeAll({ ownerId: 1 });
    await first;
    const second = assert.rejects(manager.read(2, 'rgb', 'a'), /关闭/);
    manager.closeAll({ pluginId: 'rgb' });
    await second;
    await manager.write(2, 'other', 'a', new Uint8Array([7]));
    assert.deepEqual(new Uint8Array((await manager.read(2, 'other', 'a'))!), new Uint8Array([7]));
    const third = assert.rejects(manager.read(2, 'other', 'a'), /关闭/);
    manager.closeAll();
    await third;
  },
);

test(
  'TCP validates options and recovers quota after closing connections',
  { timeout: 5000 },
  async (t) => {
    const { manager, options } = await fixture(t);
    for (const invalid of [
      { port: 0 },
      { port: 1.2 },
      { host: 'http://localhost' },
      { connectTimeoutMs: 0 },
      { writeTimeoutMs: Infinity },
      { noDelay: 'yes' },
      { keepAlive: 'yes' },
      { keepAliveInitialDelayMs: -1 },
      { keepAliveInitialDelayMs: 1.5 },
      { keepAliveInitialDelayMs: 2147483648 },
      { keepAliveInitialDelayMs: null },
    ]) {
      await assert.rejects(
        manager.connect(1, 'rgb', 'invalid', { ...options, ...invalid } as typeof options),
      );
    }
    for (let i = 0; i < 16; i++) await manager.connect(1, 'rgb', String(i), options);
    await assert.rejects(manager.connect(2, 'rgb', 'overflow', options), /上限/);
    await assert.rejects(manager.connect(1, 'rgb', '0', options), /重复/);
    manager.close(1, 'rgb', '0');
    await manager.connect(2, 'rgb', 'replacement', options);
  },
);

test(
  'connect timeout and cancellation settle pending connects without leaking handles',
  { timeout: 5000 },
  async (t) => {
    const manager = createPluginTcpManager(() => {
      const socket = new Socket();
      // Simulate a connect that never resolves without relying on Internet routing.
      socket.connect = (() => socket) as Socket['connect'];
      return socket;
    });

    t.after(() => manager.closeAll());
    const options = { host: '127.0.0.1', port: 6742, connectTimeoutMs: 20 };
    await assert.rejects(manager.connect(1, 'rgb', 'a', options), /连接超时/);
    const pending = assert.rejects(manager.connect(1, 'rgb', 'a', options), /关闭/);
    manager.closeAll();
    await pending;
  },
);

test(
  'TCP bounds writes and destroys stalled connections on write timeout',
  { timeout: 5000 },
  async (t) => {
    const { manager, options, clients } = await fixture(t);
    await manager.connect(1, 'rgb', 'a', { ...options, writeTimeoutMs: 30 });
    await assert.rejects(manager.write(1, 'rgb', 'a', new Uint8Array(1024 * 1024 + 1)), /1 MiB/);
    await assert.rejects(manager.write(1, 'rgb', 'a', 'text' as unknown as Uint8Array), /仅支持/);
    // Simulate an OS write queue that never drains. Only this fixture's socket is changed.
    clients[0].write = (() => false) as Socket['write'];
    const pending = Array.from({ length: 4 }, () =>
      assert.rejects(manager.write(1, 'rgb', 'a', new Uint8Array(1024 * 1024)), /超时|关闭|中断/),
    );
    await assert.rejects(manager.write(1, 'rgb', 'a', new Uint8Array([1])), /队列已满/);
    await Promise.all(pending);
    assert(clients[0].destroyed);
  },
);

test(
  'a slow reader leaves data in the bounded Socket buffer instead of pushing IPC events',
  { timeout: 5000 },
  async (t) => {
    const { manager, options, clients } = await fixture(t, (socket) =>
      socket.write(Buffer.alloc(2 * 1024 * 1024)),
    );
    await manager.connect(1, 'rgb', 'a', options);
    // Start then stop consuming; non-flowing mode must retain transport backpressure.
    assert(await manager.read(1, 'rgb', 'a'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.notEqual(clients[0].readableFlowing, true);
    assert(clients[0].readableLength <= clients[0].readableHighWaterMark + 65536);
  },
);

test(
  'canceling an old connect cannot remove a replacement handle with the same ID',
  { timeout: 5000 },
  async (t) => {
    const { options } = await fixture(t, (socket) => socket.pipe(socket));
    let first = true;
    const manager = createPluginTcpManager(() => {
      const socket = new Socket();
      if (first) {
        first = false;
        socket.connect = (() => socket) as Socket['connect'];
      }
      return socket;
    });
    t.after(() => manager.closeAll());
    const old = assert.rejects(manager.connect(1, 'rgb', 'a', options), /关闭/);
    manager.close(1, 'rgb', 'a');
    await manager.connect(1, 'rgb', 'a', options);
    await old;
    await manager.write(1, 'rgb', 'a', new Uint8Array([42]));
    assert.deepEqual(new Uint8Array((await manager.read(1, 'rgb', 'a'))!), new Uint8Array([42]));
  },
);

test(
  'TCP surfaces connection refusal and a remote reset without unhandled socket errors',
  { timeout: 5000 },
  async (t) => {
    const { manager, options, peers } = await fixture(t);
    await manager.connect(1, 'rgb', 'a', options);
    const pending = assert.rejects(manager.read(1, 'rgb', 'a'), /reset|ECONNRESET/i);
    peers[0].resetAndDestroy();
    await pending;
    manager.close(1, 'rgb', 'a');

    const unavailable = createServer();
    unavailable.listen(0, '127.0.0.1');
    await once(unavailable, 'listening');
    const address = unavailable.address();
    assert(address && typeof address !== 'string');
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    await assert.rejects(
      manager.connect(1, 'rgb', 'a', { ...options, port: address.port }),
      /ECONNREFUSED/i,
    );
  },
);

test(
  'TCP keepalive is opt-in and applies validated initial delays',
  { timeout: 5000 },
  async (t) => {
    const { manager, options, keepAliveCalls } = await fixture(t);
    await manager.connect(1, 'rgb', 'default', options);
    await manager.connect(1, 'rgb', 'custom', {
      ...options,
      keepAlive: true,
      keepAliveInitialDelayMs: 60000,
    });
    await manager.connect(1, 'rgb', 'system', {
      ...options,
      keepAlive: true,
      keepAliveInitialDelayMs: 0,
    });
    assert.deepEqual(keepAliveCalls, [
      [false, 30000],
      [true, 60000],
      [true, 0],
    ]);
  },
);

test(
  'end drains queued writes before FIN and reads the delayed peer response',
  { timeout: 5000 },
  async (t) => {
    const request = Buffer.alloc(200000, 0xab);
    const received: Buffer[] = [];
    const { manager, options } = await fixture(t, (socket) => {
      socket.on('data', (data) => received.push(data));
      socket.on('end', () => setImmediate(() => socket.end(Buffer.from('complete'))));
    });
    await manager.connect(1, 'rgb', 'a', options);
    await assert.rejects(manager.end(2, 'rgb', 'a'), /不存在/);
    const writes = [
      manager.write(1, 'rgb', 'a', request),
      manager.write(1, 'rgb', 'a', new Uint8Array([42])),
    ];
    const ending = manager.end(1, 'rgb', 'a');
    const again = manager.end(1, 'rgb', 'a');
    await assert.rejects(manager.write(1, 'rgb', 'a', new Uint8Array([99])), /不可写/);
    await Promise.all([...writes, ending, again]);
    await manager.end(1, 'rgb', 'a');
    const parts: Buffer[] = [];
    for (;;) {
      const data = await manager.read(1, 'rgb', 'a');
      if (data === null) break;
      parts.push(Buffer.from(data));
    }
    assert.deepEqual(Buffer.concat(received), Buffer.concat([request, Buffer.from([42])]));
    assert.equal(Buffer.concat(parts).toString(), 'complete');
  },
);

test('end timeout destroys the socket and cancels a pending read', { timeout: 5000 }, async (t) => {
  const { manager, options, clients } = await fixture(t);
  await manager.connect(1, 'rgb', 'a', { ...options, writeTimeoutMs: 25 });
  clients[0].end = (() => clients[0]) as Socket['end'];
  const read = assert.rejects(manager.read(1, 'rgb', 'a'), /结束写入超时/);
  await assert.rejects(manager.end(1, 'rgb', 'a'), /结束写入超时/);
  await read;
  assert(clients[0].destroyed);
  assert.equal(clients[0].listenerCount('close'), 0);
});

test(
  'close cancels a pending end and releases its listeners and connection quota',
  { timeout: 5000 },
  async (t) => {
    const { manager, options, clients } = await fixture(t);
    await manager.connect(1, 'rgb', 'a', options);
    clients[0].end = (() => clients[0]) as Socket['end'];
    const ended = assert.rejects(manager.end(1, 'rgb', 'a'), /关闭/);
    manager.close(1, 'rgb', 'a');
    await ended;
    assert.equal(clients[0].listenerCount('close'), 0);
    assert.equal(clients[0].listenerCount('error'), 1);
    await manager.connect(1, 'rgb', 'a', options);
  },
);
