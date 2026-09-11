import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { afterEach, test } from 'node:test';
import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';
import type { PluginTcpNativeApi } from '../src/shared/plugin-tcp.ts';
import { createPluginTcpApi } from '../src/renderer/plugins/runtime/tcp.ts';

const originalWindow = globalThis.window;
afterEach(() =>
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  }),
);

const fixture = (overrides: Partial<PluginTcpNativeApi> = {}, tcp = true) => {
  const calls: unknown[][] = [];
  const native: PluginTcpNativeApi = {
    connect: async (...args) => {
      calls.push(['connect', ...args]);
    },
    read: async (...args) => {
      calls.push(['read', ...args]);
      return null;
    },
    write: async (...args) => {
      calls.push(['write', ...args]);
    },
    end: async (...args) => {
      calls.push(['end', ...args]);
    },
    close: async (...args) => {
      calls.push(['close', ...args]);
    },
    ...overrides,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { electron: { plugins: { net: { tcp: native } } } },
  });
  const disposers: Array<() => void> = [];
  const descriptor = { id: 'rgb', manifest: { capabilities: { tcp } } } as EchoPluginDescriptor;
  const api = createPluginTcpApi(descriptor, (dispose) => {
    disposers.push(dispose);
    return dispose;
  });
  return { api, calls, dispose: () => disposers.forEach((dispose) => dispose()) };
};
const options = { host: '127.0.0.1', port: 6742 };

test('TCP can create distinct handles when randomUUID is unavailable', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  });
  const { api, calls, dispose } = fixture();
  await api.connect(options);
  await api.connect(options);
  assert.notEqual(calls[0][2], calls[1][2]);
  dispose();
});

test('pre-aborted signals never start IPC or close an existing connection', async () => {
  const { api, calls } = fixture();
  const controller = new AbortController();
  const reason = new Error('already canceled');
  controller.abort(reason);
  await assert.rejects(
    api.connect({ ...options, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls.length, 0);
  const connection = await api.connect(options);
  for (const operation of [
    () => connection.read({ signal: controller.signal }),
    () => connection.write(new Uint8Array([1]), { signal: controller.signal }),
    () => connection.end({ signal: controller.signal }),
  ])
    await assert.rejects(operation(), (error) => error === reason);
  assert.equal(calls.length, 1);
  await connection.write(new Uint8Array([1]));
  await connection.close();
});

test('abort during connect rejects promptly, strips signal from IPC and handles late rejection', async () => {
  let rejectConnect!: (error: Error) => void;
  let passedOptions: unknown;
  const { api, calls } = fixture({
    connect: (_plugin, _id, options) => {
      passedOptions = options;
      return new Promise((_resolve, reject) => {
        rejectConnect = reject;
      });
    },
    close: async (...args) => {
      calls.push(['close', ...args]);
      await new Promise(() => {}); // Cancellation cannot wait on an IPC acknowledgement.
    },
  });
  const controller = new AbortController();
  const pending = api.connect({ ...options, keepAlive: true, signal: controller.signal });
  assert.deepEqual(passedOptions, { ...options, keepAlive: true });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  rejectConnect(new Error('late IPC rejection'));
});

test('connect signal remains active after handshake and cancels every pending operation', async () => {
  const { api, calls } = fixture({
    read: () => new Promise(() => {}),
    write: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const connection = await api.connect({ ...options, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const pending = [connection.read(), connection.write(new Uint8Array([1]))];
  const reason = new Error('shutdown');
  const rejected = pending.map((promise) => assert.rejects(promise, (error) => error === reason));
  controller.abort(reason);
  await Promise.all(rejected);
  await connection.close();
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const name of ['read', 'write', 'end'] as const) {
  test(`aborting a pending ${name} closes the stream and releases signal listeners`, async () => {
    const { api, calls } = fixture({ [name]: () => new Promise(() => {}) });
    const connection = await api.connect(options);
    const controller = new AbortController();
    const pending =
      name === 'write'
        ? connection.write(new Uint8Array([1]), { signal: controller.signal })
        : connection[name]({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(connection.read(), { name: 'AbortError' });
    assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('completed operations detach their signal while close detaches the lifetime signal', async () => {
  const { api, calls } = fixture({ read: async () => new Uint8Array([1]).buffer });
  const lifetime = new AbortController();
  const operation = new AbortController();
  const connection = await api.connect({ ...options, signal: lifetime.signal });
  await connection.write(new Uint8Array([1]), { signal: operation.signal });
  await connection.read({ signal: operation.signal });
  await connection.end({ signal: operation.signal });
  assert.equal(getEventListeners(operation.signal, 'abort').length, 0);
  operation.abort();
  assert.equal(calls.filter((call) => call[0] === 'close').length, 0);
  await connection.close();
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
});

test('end shares one FIN, rejects later writes, and preserves responses until EOF', async () => {
  let finish!: () => void;
  let ends = 0;
  let reads = 0;
  const { api, calls } = fixture({
    end: () => {
      ends++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    read: async () => (reads++ ? null : new Uint8Array([42]).buffer),
  });
  const connection = await api.connect(options);
  const first = connection.end();
  const second = connection.end();
  assert.equal(ends, 1);
  await assert.rejects(connection.write(new Uint8Array([1])), /结束写入/);
  assert.deepEqual(new Uint8Array((await connection.read())!), new Uint8Array([42]));
  assert.equal(await connection.read(), null);
  assert.equal(calls.filter((call) => call[0] === 'close').length, 0);
  finish();
  await Promise.all([first, second]);
  await connection.close();
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
});

test('TCP capability is separate from HTTP access and is required before connecting', async () => {
  const { api, calls } = fixture({}, false);
  await assert.rejects(api.connect(options), /未声明 TCP/);
  assert.equal(calls.length, 0);
});

test('TCP renderer scopes handles, preserves binary slices and closes on EOF', async () => {
  const { api, calls } = fixture();
  const connection = await api.connect(options);
  const bytes = new Uint8Array([8, 1, 2, 9]).subarray(1, 3);
  await connection.write(bytes);
  assert.equal(calls[0][1], 'rgb');
  assert.equal(calls[1][2], calls[0][2]);
  assert.equal(calls[1][3], bytes);
  assert.equal(await connection.read(), null);
  await connection.close();
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
  await assert.rejects(connection.write(bytes), /关闭/);
});

test('disposing during connect closes the pending handle and rejects late completion', async () => {
  let finish!: () => void;
  const { api, calls, dispose } = fixture({
    connect: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const pending = api.connect(options);
  const rejected = assert.rejects(pending, /关闭|释放/);
  dispose();
  finish();
  await rejected;
  assert.equal(calls.filter((call) => call[0] === 'close').length, 1);
  await assert.rejects(api.connect(options), /释放/);
});

test('renderer rejects duplicate reads and limits queued writes before IPC', async () => {
  let finishRead!: (value: ArrayBuffer | null) => void;
  const writes: Array<() => void> = [];
  const { api, dispose } = fixture({
    read: () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    write: () =>
      new Promise<void>((resolve) => {
        writes.push(resolve);
      }),
  });
  const connection = await api.connect(options);
  const read = connection.read();
  await assert.rejects(connection.read(), /一个待完成/);
  const pending = Array.from({ length: 4 }, () => connection.write(new Uint8Array(1024 * 1024)));
  await assert.rejects(connection.write(new Uint8Array([1])), /队列已满/);
  assert.equal(writes.length, 4);
  writes.forEach((finish) => finish());
  await Promise.all(pending);
  finishRead(new Uint8Array([1]).buffer);
  assert.deepEqual(new Uint8Array((await read)!), new Uint8Array([1]));
  dispose();
  await assert.rejects(connection.read(), /关闭/);
});
