import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';
import { createPluginWebServerApi } from '../src/renderer/plugins/runtime/runtimeServices.ts';

const originalWindow = globalThis.window;
afterEach(() =>
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  }),
);

const fixture = () => {
  const calls: unknown[][] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const emit = (name: string, payload: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(payload as never);
  };
  const on = (name: string, listener: (payload: never) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      electron: {
        plugins: {
          webServer: {
            listen: async (...args: unknown[]) => {
              calls.push(['listen', ...args]);
              return {
                ok: true,
                pluginId: 'rgb',
                host: '127.0.0.1',
                port: 1,
                origin: 'http://127.0.0.1:1',
                url: 'http://127.0.0.1:1/',
                startedAt: 1,
              };
            },
            status: async (...args: unknown[]) => {
              calls.push(['status', ...args]);
              return {
                ok: true,
                pluginId: 'rgb',
                running: true,
                host: '127.0.0.1',
                port: 1,
                origin: '',
                url: '',
                startedAt: 1,
                pendingRequests: 0,
                connections: 0,
              };
            },
            respond: async (...args: unknown[]) => {
              calls.push(['respond', ...args]);
              return { ok: true };
            },
            close: async (...args: unknown[]) => {
              calls.push(['close', ...args]);
              return { ok: true, pluginId: 'rgb', closed: true };
            },
            onRequest: (listener: (payload: never) => void) => on('request', listener),
            upgrade: async (...args: unknown[]) => {
              calls.push(['upgrade', ...args]);
              return { ok: true };
            },
            send: async (...args: unknown[]) => {
              calls.push(['send', ...args]);
              return { ok: true };
            },
            ping: async (...args: unknown[]) => {
              calls.push(['ping', ...args]);
              return { ok: true };
            },
            closeSocket: async (...args: unknown[]) => {
              calls.push(['closeSocket', ...args]);
              return { ok: true };
            },
            onUpgrade: (listener: (payload: never) => void) => on('upgrade', listener),
            onOpen: (listener: (payload: never) => void) => on('open', listener),
            onMessage: (listener: (payload: never) => void) => on('message', listener),
            onClose: (listener: (payload: never) => void) => on('close', listener),
            onError: (listener: (payload: never) => void) => on('error', listener),
          },
        },
      },
    },
  });
  const disposers: Array<() => void> = [];
  const api = createPluginWebServerApi(
    { id: 'rgb', manifest: { capabilities: { webServer: true } } } as EchoPluginDescriptor,
    (dispose) => {
      disposers.push(dispose);
      return dispose;
    },
    (_id, _source, callback) => callback(),
    () => undefined,
  );
  return { api, calls, emit, dispose: () => disposers.forEach((dispose) => dispose()) };
};

test('onConnection exposes a socket handle instead of a callback bag', async () => {
  const { api, calls, emit, dispose } = fixture();
  const sockets: Array<{ connectionId: string; messages: unknown[] }> = [];
  const stop = api.onConnection((socket) => {
    const current = { connectionId: socket.connectionId, messages: [] as unknown[] };
    sockets.push(current);
    socket.onMessage((event) => current.messages.push(event.data));
    void socket.send('hi');
  });
  emit('upgrade', {
    connectionId: 'c1',
    pluginId: 'rgb',
    url: '/live',
    path: '/live',
    query: {},
    headers: {},
    protocols: ['echo'],
    remoteAddress: '127.0.0.1',
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), [
    'upgrade',
    'rgb',
    { connectionId: 'c1', accept: true, protocol: undefined },
  ]);
  emit('open', {
    connectionId: 'c1',
    pluginId: 'rgb',
    protocol: 'echo',
    url: '/live',
    path: '/live',
    query: {},
    headers: {},
    remoteAddress: '127.0.0.1',
  });
  assert.equal(sockets[0]?.connectionId, 'c1');
  emit('message', { connectionId: 'c1', pluginId: 'rgb', data: 'ping', binary: false });
  assert.deepEqual(sockets[0]?.messages, ['ping']);
  stop();
  dispose();
});

test('listen can start HTTP and WebSocket together', async () => {
  const { api, calls, emit, dispose } = fixture();
  const sockets: string[] = [];
  const result = await api.listen({
    port: 38123,
    onRequest: () => 'ok',
    onConnection: (socket) => {
      sockets.push(socket.connectionId);
    },
    path: '/live',
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.[0], 'listen');
  emit('upgrade', {
    connectionId: 'c1',
    pluginId: 'rgb',
    url: '/live',
    path: '/live',
    query: {},
    headers: {},
    protocols: [],
    remoteAddress: '127.0.0.1',
  });
  await Promise.resolve();
  await Promise.resolve();
  emit('open', {
    connectionId: 'c1',
    pluginId: 'rgb',
    protocol: '',
    url: '/live',
    path: '/live',
    query: {},
    headers: {},
    remoteAddress: '127.0.0.1',
  });
  assert.deepEqual(sockets, ['c1']);
  dispose();
});

test('path-scoped handlers ignore other upgrades', async () => {
  const { api, calls, emit, dispose } = fixture();
  api.onConnection(() => undefined, { path: '/live' });
  emit('upgrade', {
    connectionId: 'other',
    pluginId: 'rgb',
    url: '/other',
    path: '/other',
    query: {},
    headers: {},
    protocols: [],
    remoteAddress: '127.0.0.1',
  });
  await Promise.resolve();
  assert.equal(
    calls.some((call) => call[0] === 'upgrade'),
    false,
  );
  dispose();
});
