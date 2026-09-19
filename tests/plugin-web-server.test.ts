import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';
import {
  closePluginWebServer,
  closePluginWebSocket,
  listenPluginWebServer,
  pingPluginWebSocket,
  respondPluginWebServerRequest,
  respondPluginWebSocketUpgrade,
  sendPluginWebSocket,
} from '../src/main/plugins/webServer.ts';

type MockWebContents = EventEmitter & {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
};

const plugin = {
  id: 'rgb',
  manifest: { capabilities: { webServer: true } },
} as EchoPluginDescriptor;

const fixture = async (t: TestContext) => {
  const webContents = new EventEmitter() as MockWebContents;
  webContents.id = 1;
  webContents.isDestroyed = () => false;
  webContents.send = (channel: string, payload: unknown) => {
    webContents.emit(channel, payload);
  };
  const requests: unknown[] = [];
  const upgrades: unknown[] = [];
  const sockets: unknown[] = [];
  webContents.on('plugins:web-server:request', (payload) => requests.push(payload));
  webContents.on('plugins:web-server:upgrade', (payload) => upgrades.push(payload));
  webContents.on('plugins:web-server:ws-open', (payload) => sockets.push(['open', payload]));
  webContents.on('plugins:web-server:ws-message', (payload) => sockets.push(['message', payload]));
  webContents.on('plugins:web-server:ws-close', (payload) => sockets.push(['close', payload]));
  webContents.on('plugins:web-server:ws-error', (payload) => sockets.push(['error', payload]));
  const result = await listenPluginWebServer(plugin, { port: 0 }, webContents as never, () => true);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  t.after(() => closePluginWebServer(plugin.id, webContents as never));
  return { webContents, origin: result.origin, requests, upgrades, sockets };
};

test('HTTP handlers still respond after WebSocket support is enabled', async (t) => {
  const { origin, requests, webContents } = await fixture(t);
  const pending = fetch(`${origin}/health`);
  await once(webContents, 'plugins:web-server:request');
  const request = requests[0] as { requestId: string; path: string };
  assert.equal(request.path, '/health');
  const responded = respondPluginWebServerRequest(
    plugin.id,
    { requestId: request.requestId, status: 200, body: { ok: true } },
    webContents as never,
  );
  assert.equal(responded.ok, true);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('accepted upgrades expose a generic send/receive socket', async (t) => {
  const { origin, upgrades, sockets, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`, 'echo');
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string; path: string; protocols: string[] };
  assert.equal(upgrade.path, '/live');
  assert.deepEqual(upgrade.protocols, ['echo']);
  const opened = Promise.all([
    once(client, 'open'),
    once(webContents, 'plugins:web-server:ws-open'),
  ]);
  assert.equal(
    respondPluginWebSocketUpgrade(
      plugin.id,
      { connectionId: upgrade.connectionId, accept: true, protocol: 'echo' },
      webContents as never,
    ).ok,
    true,
  );
  await opened;
  const inbound = once(webContents, 'plugins:web-server:ws-message');
  const outbound = once(client, 'message');
  const sent = await sendPluginWebSocket(
    plugin.id,
    { connectionId: upgrade.connectionId, data: 'hello' },
    webContents as never,
  );
  assert.equal(sent.ok, true);
  const [message] = await outbound;
  assert.equal(String(message), 'hello');
  client.send('pong');
  await inbound;
  const received = sockets.find((entry) => Array.isArray(entry) && entry[0] === 'message') as [
    string,
    { data: string; binary: boolean },
  ];
  assert.equal(received[1].data, 'pong');
  assert.equal(received[1].binary, false);
});

test('plugins can reject an upgrade without starting a socket', async (t) => {
  const { origin, upgrades, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/denied`);
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  const error = once(client, 'unexpected-response');
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  assert.equal(
    respondPluginWebSocketUpgrade(
      plugin.id,
      { connectionId: upgrade.connectionId, accept: false },
      webContents as never,
    ).ok,
    true,
  );
  const [, response] = await error;
  assert.equal(response.statusCode, 403);
});

test('binary frames and close codes round-trip through the host socket', async (t) => {
  const { origin, upgrades, sockets, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/bin`);
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  const opened = once(client, 'open');
  respondPluginWebSocketUpgrade(
    plugin.id,
    { connectionId: upgrade.connectionId, accept: true },
    webContents as never,
  );
  await opened;
  const outbound = once(client, 'message');
  const bytes = new Uint8Array([0, 255, 1, 2]);
  const sent = await sendPluginWebSocket(
    plugin.id,
    { connectionId: upgrade.connectionId, data: bytes },
    webContents as never,
  );
  assert.equal(sent.ok, true);
  const [frame, isBinary] = (await outbound) as [Buffer, boolean];
  assert.equal(isBinary, true);
  assert.deepEqual([...frame], [0, 255, 1, 2]);
  const pinged = once(client, 'ping');
  assert.equal(
    pingPluginWebSocket(plugin.id, { connectionId: upgrade.connectionId }, webContents as never).ok,
    true,
  );
  await pinged;
  const closed = once(client, 'close');
  assert.equal(
    closePluginWebSocket(
      plugin.id,
      { connectionId: upgrade.connectionId, code: 4000, reason: 'done' },
      webContents as never,
    ).ok,
    true,
  );
  const [code, reason] = await closed;
  assert.equal(code, 4000);
  assert.equal(String(reason), 'done');
  assert.ok(sockets.some((entry) => Array.isArray(entry) && entry[0] === 'close'));
});

test('cross-origin browser upgrades are rejected unless the plugin opts in', async (t) => {
  const { origin, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`, {
    origin: 'http://evil.example',
  });
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  const error = once(client, 'unexpected-response');
  const [, response] = await error;
  assert.equal(response.statusCode, 403);
  const didUpgrade = await Promise.race([
    once(webContents, 'plugins:web-server:upgrade').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(didUpgrade, false);
});

test('allowCrossOrigin lets a plugin accept other browser origins', async (t) => {
  const { origin, upgrades, webContents } = await (async () => {
    const webContents = new EventEmitter() as MockWebContents;
    webContents.id = 1;
    webContents.isDestroyed = () => false;
    webContents.send = (channel: string, payload: unknown) => {
      webContents.emit(channel, payload);
    };
    const upgrades: unknown[] = [];
    webContents.on('plugins:web-server:upgrade', (payload) => upgrades.push(payload));
    const result = await listenPluginWebServer(
      plugin,
      { port: 0, allowCrossOrigin: true },
      webContents as never,
      () => true,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.error);
    t.after(() => closePluginWebServer(plugin.id, webContents as never));
    return { webContents, origin: result.origin, upgrades };
  })();
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`, {
    origin: 'http://evil.example',
  });
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  const opened = once(client, 'open');
  assert.equal(
    respondPluginWebSocketUpgrade(
      plugin.id,
      { connectionId: upgrade.connectionId, accept: true },
      webContents as never,
    ).ok,
    true,
  );
  await opened;
});

test('clients that omit Origin are still accepted by default', async (t) => {
  const { origin, upgrades, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`);
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  const opened = once(client, 'open');
  assert.equal(
    respondPluginWebSocketUpgrade(
      plugin.id,
      { connectionId: upgrade.connectionId, accept: true },
      webContents as never,
    ).ok,
    true,
  );
  await opened;
});

test('oversized ping payloads return a Chinese error instead of RangeError', async (t) => {
  const { origin, upgrades, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`);
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  const opened = once(client, 'open');
  respondPluginWebSocketUpgrade(
    plugin.id,
    { connectionId: upgrade.connectionId, accept: true },
    webContents as never,
  );
  await opened;
  const result = pingPluginWebSocket(
    plugin.id,
    { connectionId: upgrade.connectionId, data: 'x'.repeat(126) },
    webContents as never,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'WebSocket ping 载荷不能超过 125 字节');
});

test('closePluginWebSocket treats a missing code as 1000', async (t) => {
  const { origin, upgrades, webContents } = await fixture(t);
  const client = new WebSocket(`${origin.replace('http', 'ws')}/live`);
  client.on('error', () => undefined);
  t.after(() => client.terminate());
  await once(webContents, 'plugins:web-server:upgrade');
  const upgrade = upgrades[0] as { connectionId: string };
  const opened = once(client, 'open');
  respondPluginWebSocketUpgrade(
    plugin.id,
    { connectionId: upgrade.connectionId, accept: true },
    webContents as never,
  );
  await opened;
  const closed = once(client, 'close');
  assert.equal(
    closePluginWebSocket(plugin.id, { connectionId: upgrade.connectionId }, webContents as never)
      .ok,
    true,
  );
  const [code] = await closed;
  assert.equal(code, 1000);
});
