import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const shared = compile('../src/shared/playbackOutput.ts');
const logic = compile('../src/main/outputs/sessionLogic.ts');
const didl = compile('../src/main/mediaTransport/didlLite.ts');
const gena = compile('../src/main/mediaTransport/genaReceiver.ts', {
  'node:http': http,
  'node:crypto': { randomBytes },
});
const { DlnaBackend } = compile('../src/main/mediaTransport/dlnaAdapter.ts', {
  events: { EventEmitter },
  '../../shared/playbackOutput': shared,
  '../outputs/sessionLogic': logic,
  './didlLite': didl,
  './genaReceiver': gena,
});
const { OutputSessionManager } = compile('../src/main/outputs/sessionManager.ts', {
  events: { EventEmitter },
  '../../shared/playbackOutput': shared,
  './sessionLogic': logic,
});
const event = (fields) =>
  `<Event><InstanceID val="0">${Object.entries(fields)
    .map(([key, value]) => `<${key} val="${value}"/>`)
    .join('')}</InstanceID></Event>`;
const setup = (action = async () => ({})) => {
  const bus = new EventEmitter();
  const backend = new DlnaBackend({
    descriptionUrl: 'http://192.168.1.10/description.xml',
    targetId: 'renderer-1',
    displayName: 'Speaker',
    routeEpoch: 1,
    trackGeneration: 1,
    native: { action },
    bus,
    now: () => 1234,
  });
  return { backend, bus };
};

test('DLNA snapshots use shared state values and source switching returns position, duration, sequence', async () => {
  const calls = [];
  const { backend } = setup(async (...args) => {
    calls.push(args);
    return {};
  });
  await backend.setTrackMeta({ title: 'Song', durationMs: 120000 });
  await backend.load('http://example.test/song');
  await backend.seek(30);
  await backend.play();
  await backend.setVolume(35);
  const result = await backend.switchSource('http://example.test/high-quality');
  assert.equal(result[0], 30);
  assert.equal(result[1], 120);
  const snapshot = await backend.getState();
  assert.equal(snapshot.trackGeneration, result[2]);
  assert.equal(snapshot.state, 'playing');
  assert.equal(snapshot.targetId, 'renderer-1');
  assert.equal(snapshot.volume, 35);
  assert.equal(snapshot.positionSec, 30);
  assert.deepEqual(
    calls.slice(-3).map((call) => call[2]),
    ['SetAVTransportURI', 'Seek', 'Play'],
  );
});

test('DLNA EOF classification keeps the observed position and rejects duplicate/stale events', async () => {
  const { backend, bus } = setup();
  let ended = 0;
  bus.on('playback-ended', () => ended++);
  await backend.load('http://example.test/song');
  const stopped = event({
    CurrentTrackURI: 'http://example.test/song',
    CurrentTrackDuration: '00:02:00',
    RelativeTimePosition: '00:02:00',
    TransportState: 'STOPPED',
  });
  backend.handleLastChange(stopped, { routeEpoch: -1, trackGeneration: -1 });
  assert.equal(ended, 0);
  backend.handleLastChange(stopped);
  backend.handleLastChange(stopped);
  assert.equal(ended, 1);
  assert.equal((await backend.getState()).positionSec, 120);
});

test('user stop and an external URI near the end are not EOF', async () => {
  const { backend, bus } = setup();
  let ended = 0;
  bus.on('playback-ended', () => ended++);
  await backend.load('http://example.test/song');
  backend.handleLastChange(
    event({
      CurrentTrackURI: 'http://example.test/other',
      CurrentTrackDuration: '00:02:00',
      RelativeTimePosition: '00:02:00',
      TransportState: 'STOPPED',
    }),
  );
  await backend.stop();
  backend.handleLastChange(
    event({
      CurrentTrackURI: 'http://example.test/song',
      CurrentTrackDuration: '00:02:00',
      RelativeTimePosition: '00:02:00',
      TransportState: 'STOPPED',
    }),
  );
  assert.equal(ended, 0);
});

test('failed SOAP commands reject without changing the session gate', async () => {
  const error = new Error('Action rejected');
  const { backend } = setup(async () => {
    throw error;
  });
  const before = await backend.getState();
  await assert.rejects(backend.seek(10), (caught) => caught === error);
  const after = await backend.getState();
  assert.equal(after.routeEpoch, before.routeEpoch);
  assert.equal(after.trackGeneration, before.trackGeneration);
  assert.equal(after.capabilities.seek, 'none');
});

const adapter = (disconnect = async () => {}) => ({
  connect: async () => ({ ok: true }),
  disconnect,
  getCapabilities: () => ({ ...shared.DEFAULT_OUTPUT_CAPABILITIES }),
  getTargets: () => [],
  outputEvents: new EventEmitter(),
});

test('switching output awaits old adapter cleanup and contains rejected disconnects', async () => {
  const manager = new OutputSessionManager({ bus: new EventEmitter() });
  let rejectDisconnect;
  const pending = new Promise((_, reject) => {
    rejectDisconnect = reject;
  });
  await manager.connectAdapter(
    adapter(() => pending),
    { protocol: 'dlna' },
  );
  let finished = false;
  const switching = manager.connectAdapter(adapter(), { protocol: 'dlna' }).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  rejectDisconnect(new Error('Device offline'));
  assert.deepEqual(await switching, { ok: true });
  assert.equal(manager.buildSnapshot().state, 'unknown');
});

test('reconnecting the same adapter does not disconnect the new connection', async () => {
  const manager = new OutputSessionManager({ bus: new EventEmitter() });
  let disconnects = 0;
  const current = adapter(async () => {
    disconnects++;
  });
  await manager.connectAdapter(current, { protocol: 'dlna' });
  await manager.connectAdapter(current, { protocol: 'dlna' });
  assert.equal(disconnects, 0);
});
