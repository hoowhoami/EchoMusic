import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transformSync } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'echo-route-lifecycle-'));
const outfile = join(dir, 'host.mjs');
await build({
  entryPoints: [join(root, 'src/main/outputs/outputHost.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outfile,
});
const { OutputHost } = await import(pathToFileURL(outfile).href);
const genaBundle = join(dir, 'gena.mjs');
await build({
  entryPoints: [join(root, 'src/main/mediaTransport/genaReceiver.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: genaBundle,
});
const { GenaReceiver } = await import(pathToFileURL(genaBundle).href);
after(() => rmSync(dir, { recursive: true, force: true }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const device = { id: 'speaker', name: 'Speaker', needsPin: false };
const descriptor = {
  descriptionUrl: 'http://192.0.2.10/description.xml',
  friendlyName: 'DLNA',
  services: [
    {
      serviceId: 'avt',
      serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
      controlUrl: 'http://192.0.2.10/avt',
      eventSubUrl: 'http://192.0.2.10/events',
    },
  ],
};
function harness(extra = {}) {
  const calls = [];
  const events = [];
  const timers = [];
  const local = {
    beginSourceChange: () => 1,
    getState: () => ({ path: '', volume: 50 }),
    loadFile: async () => ({ seq: 1, duration: 120 }),
    pause: async () => calls.push('pause'),
    play: async () => calls.push('play'),
    stop: async () => {},
    seek: async () => {},
    setVolume: async () => {},
    setAirplayTap: async (port, enabled) => calls.push(['tap', port, enabled]),
    setAirplayEpoch: async () => calls.push('epoch'),
    setAudioOutput: async (name) => calls.push(['output', name]),
    ...extra.local,
  };
  const airplay = {
    available: true,
    discover: async () => [],
    connect: async (id) => {
      calls.push(['connect', id]);
      return { ok: true, pcmPort: 1234 };
    },
    disconnect: async () => calls.push('disconnect'),
    pause: async () => {},
    resume: async () => {},
    seek: async () => 1,
    stop: async () => {},
    setVolume: async () => {},
    flushTrack: async () => 1,
    status: () => ({ connected: true, format: '', delaySec: 0, inputBits: 16 }),
    ...extra.airplay,
  };
  const native = {
    loadDevice: async () => descriptor,
    action: async (_url, _service, action) => {
      calls.push(['action', action]);
      return {};
    },
    clearDeviceCache: async () => {},
    ...extra.native,
  };
  const host = new OutputHost({
    ...extra,
    local,
    native,
    airplay,
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
    emitOutput: (event) => events.push(event),
    emitPlayer: (event, ...args) => events.push({ type: event, args }),
    schedule: () => {
      const timer = {
        canceled: false,
        cancel() {
          this.canceled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
  });
  host.noteAirplayDevices([device, { ...device, id: 'speaker-2' }]);
  host.noteDlnaDevices([{ usn: 'dlna', location: descriptor.descriptionUrl }]);
  return { host, calls, events, timers, local, airplay };
}

test('local selection waits for an in-progress AirPlay connection and wins in request order', async () => {
  const gate = deferred();
  const box = harness({ airplay: { connect: () => gate.promise } });
  const connecting = box.host.connect('speaker');
  await tick();
  let done = false;
  const switching = box.host.connect('local:default').then((result) => {
    done = true;
    return result;
  });
  await tick();
  const completedTooSoon = done;
  gate.resolve({ ok: true, pcmPort: 1234 });
  await Promise.all([connecting, switching]);
  assert.equal(completedTooSoon, false);
  assert.equal(box.host.airplayActive, false);
  assert.equal(box.calls.filter((call) => call === 'disconnect').length, 1);
  assert.deepEqual(box.calls.at(-1), ['output', 'default']);
});

test('AirPlay connection requests execute serially', async () => {
  const gate = deferred();
  const started = [];
  const box = harness({
    airplay: {
      connect: async (id) => {
        started.push(id);
        if (id === 'speaker') return gate.promise;
        return { ok: true, pcmPort: 2345 };
      },
    },
  });
  const first = box.host.connect('speaker');
  await tick();
  const second = box.host.connect('speaker-2');
  await tick();
  const beforeRelease = [...started];
  gate.resolve({ ok: true, pcmPort: 1234 });
  await Promise.all([first, second]);
  assert.deepEqual(beforeRelease, ['speaker']);
  assert.equal(box.host.snapshot().targetId, 'speaker-2');
  assert.deepEqual(box.calls.filter((call) => Array.isArray(call) && call[0] === 'tap').at(-1), [
    'tap',
    2345,
    true,
  ]);
  await box.host.shutdown();
});

test('shutdown waits for pending AirPlay, discards its success, and disconnects without enabling PCM', async () => {
  const gate = deferred();
  const box = harness({ airplay: { connect: () => gate.promise } });
  const connecting = box.host.connect('speaker');
  await tick();
  let stopped = false;
  const shutdown = box.host.shutdown().then(() => {
    stopped = true;
  });
  await tick();
  const returnedTooSoon = stopped;
  gate.resolve({ ok: true, pcmPort: 1234 });
  const result = await connecting;
  await shutdown;
  assert.equal(returnedTooSoon, false);
  assert.equal(result.ok, false);
  assert.equal(box.host.airplayActive, false);
  assert.ok(box.calls.includes('disconnect'));
  assert.ok(!box.calls.some((call) => Array.isArray(call) && call[0] === 'tap' && call[2]));
  assert.ok(!box.calls.includes('play'));
});

test('concurrent shutdown callers share one remote cleanup', async () => {
  const gate = deferred();
  const box = harness({
    airplay: {
      disconnect: async () => {
        box.calls.push('disconnect');
        await gate.promise;
      },
    },
  });
  await box.host.connect('speaker');
  const first = box.host.shutdown();
  const second = box.host.shutdown();
  await tick();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(box.calls.filter((call) => call === 'disconnect').length, 1);
});

test('shutdown rejects new and queued connections', async () => {
  const gate = deferred();
  const box = harness({ airplay: { connect: () => gate.promise } });
  const first = box.host.connect('speaker');
  await tick();
  const queued = box.host.connect('local:default');
  const shutdown = box.host.shutdown();
  const later = box.host.connect('speaker-2');
  gate.resolve({ ok: true, pcmPort: 1234 });
  const results = await Promise.all([first, queued, later]);
  await shutdown;
  assert.ok(results.every((result) => !result.ok));
  assert.ok(!box.calls.some((call) => Array.isArray(call) && call[0] === 'output'));
});

test('AirPlay cleanup still pauses and disconnects when disabling the tap fails', async () => {
  const box = harness({
    local: {
      setAirplayTap: async (_port, enabled) => {
        if (!enabled) throw new Error('tap failed');
      },
    },
  });
  await box.host.connect('speaker');
  await box.host.shutdown();
  assert.ok(box.calls.includes('pause'));
  assert.ok(box.calls.includes('disconnect'));
});

test('AirPlay cleanup still disconnects when pausing fails', async () => {
  const box = harness({
    local: {
      pause: async () => {
        throw new Error('pause failed');
      },
    },
  });
  await box.host.connect('speaker');
  await box.host.shutdown();
  assert.ok(box.calls.includes('disconnect'));
});

test('DLNA preflight completing after shutdown cannot pause or commit a route', async () => {
  const gate = deferred();
  const box = harness({ native: { loadDevice: () => gate.promise } });
  const connection = box.host.connect('dlna');
  await tick();
  const shutdown = box.host.shutdown();
  gate.resolve(descriptor);
  const result = await connection;
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(box.host.ownsTransport, false);
  assert.ok(!box.calls.includes('pause'));
});

test('shutdown during DLNA subscription suppresses handoff and stale polling even on subscription failure', async () => {
  const gate = deferred();
  const box = harness({
    local: {
      getState: () => ({ path: 'https://cdn.example/song.mp3', volume: 50, playing: true }),
    },
    gena: {
      start: async () => 8080,
      armToken() {},
      disarmToken() {},
      callbackUrl: () => 'http://192.0.2.20/callback',
      trackSubscription() {},
      untrackSubscription() {},
    },
    subscribe: () => gate.promise,
  });
  const connection = box.host.connect('dlna');
  await tick();
  const shutdown = box.host.shutdown();
  gate.reject(new Error('subscription failed'));
  const result = await connection;
  await shutdown;
  assert.equal(result.ok, false);
  assert.ok(
    !box.calls.some(
      (call) => Array.isArray(call) && ['SetAVTransportURI', 'Play'].includes(call[1]),
    ),
  );
  assert.equal(box.timers.length, 0);
  assert.ok(!box.calls.includes('play'));
});

test('AirPlay tap setup completing after shutdown is disabled without committing', async () => {
  const gate = deferred();
  const box = harness({
    local: {
      setAirplayTap: async (port, enabled) => {
        box.calls.push(['tap', port, enabled]);
        if (enabled) await gate.promise;
      },
    },
  });
  const connection = box.host.connect('speaker');
  await tick();
  const shutdown = box.host.shutdown();
  gate.resolve();
  const result = await connection;
  await shutdown;
  assert.equal(result.ok, false);
  assert.equal(box.host.airplayActive, false);
  assert.deepEqual(box.calls.filter((call) => Array.isArray(call) && call[0] === 'tap').at(-1), [
    'tap',
    0,
    false,
  ]);
  assert.ok(box.calls.includes('disconnect'));
});

test('discovery finishing after shutdown cannot publish devices or restart scanning', async () => {
  const gate = deferred();
  const box = harness({ airplay: { discover: () => gate.promise } });
  box.host.setEnabled(true);
  await box.host.refresh();
  await box.host.shutdown();
  const count = box.events.length;
  gate.resolve([{ id: 'late', name: 'Late', needsPin: false }]);
  await tick();
  assert.equal(box.events.length, count);
  assert.ok(!box.host.targets().some((target) => target.targetId === 'late'));
  assert.equal(box.host.wantsScan, false);
});

test('local device refresh completing after shutdown cannot publish', async () => {
  const gate = deferred();
  const box = harness({ local: { getAudioDevices: () => gate.promise } });
  const refresh = box.host.refresh();
  await tick();
  await box.host.shutdown();
  const count = box.events.length;
  gate.resolve([{ name: 'late', description: 'Late' }]);
  await refresh;
  assert.equal(box.events.length, count);
  assert.ok(!box.host.targets().some((target) => target.targetId === 'local:late'));
});

test('an old DLNA state callback cannot overwrite a newly connected session', async () => {
  const box = harness();
  await box.host.connect('dlna');
  const gate = deferred();
  box.host.backend.getState = () => gate.promise;
  box.host.ingestLastChange('<Event/>');
  await box.host.connect('dlna');
  gate.resolve({ positionSec: 99, durationSec: 120, trackGeneration: 9, state: 'playing' });
  await tick();
  assert.notEqual(box.host.snapshot().positionSec, 99);
  assert.ok(!box.events.some((event) => event.type === 'time-update' && event.args[0].time === 99));
  await box.host.shutdown();
});

test('a late failure from the old AirPlay connection cannot disconnect the new one', async () => {
  const gate = deferred();
  const box = harness({ airplay: { pause: () => gate.promise } });
  await box.host.connect('speaker');
  const pausing = box.host.pauseAirplay();
  await box.host.connect('speaker-2');
  const disconnects = box.calls.filter((call) => call === 'disconnect').length;
  gate.reject(new Error('old sender failed'));
  await pausing;
  assert.equal(box.host.airplayActive, true);
  assert.equal(box.host.snapshot().targetId, 'speaker-2');
  assert.equal(box.calls.filter((call) => call === 'disconnect').length, disconnects);
  await box.host.shutdown();
});

test('AirPlay disconnect cleanup cannot race a new connection', async () => {
  const gate = deferred();
  const box = harness({
    local: {
      setAirplayTap: async (_port, enabled) => {
        if (!enabled) await gate.promise;
      },
    },
  });
  await box.host.connect('speaker');
  const loss = box.host.loseAirplay('offline');
  await tick();
  const next = box.host.connect('speaker-2');
  await tick();
  const premature = box.calls.some(
    (call) => Array.isArray(call) && call[0] === 'connect' && call[1] === 'speaker-2',
  );
  gate.resolve();
  await Promise.all([loss, next]);
  assert.equal(premature, false);
  assert.equal(box.host.airplayActive, true);
  assert.equal(box.host.snapshot().targetId, 'speaker-2');
  await box.host.shutdown();
});

test('an old DLNA load completion stops its own backend instead of the new session', async () => {
  const gate = deferred();
  const box = harness();
  await box.host.connect('dlna');
  box.host.backend.load = () => gate.promise;
  const loading = box.host.load('https://cdn.example/song.mp3', box.host.beginSourceChange());
  await tick();
  await box.host.connect('dlna');
  let newStops = 0;
  box.host.backend.stop = async () => {
    newStops += 1;
  };
  gate.resolve({ seq: 5, duration: 120 });
  assert.equal(await loading, null);
  assert.equal(newStops, 0);
  await box.host.shutdown();
});

test('an old DLNA poll state cannot overwrite the new session', async () => {
  const gate = deferred();
  const box = harness();
  await box.host.connect('dlna');
  box.host.backend.getState = () => gate.promise;
  const polling = box.host.pollOnce();
  await tick();
  await box.host.connect('dlna');
  gate.resolve({ positionSec: 99, durationSec: 120, trackGeneration: 9, state: 'playing' });
  await polling;
  assert.notEqual(box.host.snapshot().positionSec, 99);
  await box.host.shutdown();
});

test('relay startup completing after shutdown does not register revoked-session resources', async () => {
  const gate = deferred();
  let registrations = 0;
  const box = harness({
    media: {
      host: '192.0.2.20',
      port: 0,
      start: () => gate.promise,
      registerResource: () => {
        registrations += 1;
        return { token: 'late', url: 'http://192.0.2.20/res/late' };
      },
      revokeSession() {},
    },
  });
  await box.host.connect('dlna');
  const loading = box.host.load('/tmp/song.mp3', box.host.beginSourceChange());
  await tick();
  await box.host.shutdown();
  gate.resolve(8080);
  assert.equal(await loading, null);
  assert.equal(registrations, 0);
});

test('shutdown during local restoration prevents local playback from resuming', async () => {
  const gate = deferred();
  const box = harness({ local: { loadFile: () => gate.promise } });
  await box.host.connect('dlna');
  await box.host.load('https://cdn.example/song.mp3', box.host.beginSourceChange());
  await box.host.play();
  const switching = box.host.activateLocal();
  await tick();
  const shutdown = box.host.shutdown();
  gate.resolve({ seq: 5, duration: 120 });
  await Promise.all([switching, shutdown]);
  assert.ok(!box.calls.includes('play'));
});

test('shutdown cancels both AirPlay health polling and tap diagnostics timers', async () => {
  const box = harness();
  await box.host.connect('speaker');
  box.host.probeAirplayPlayback('play');
  assert.equal(box.timers.length, 3);
  await box.host.shutdown();
  assert.ok(box.timers.every((timer) => timer.canceled));
});

test('a failed route request does not block the next local selection', async () => {
  const box = harness({
    local: {
      setAudioOutput: async (name) => {
        if (name === 'broken') throw new Error('device unavailable');
        box.calls.push(['output', name]);
      },
    },
  });
  const first = box.host.connect('local:broken');
  const next = box.host.connect('local:default');
  await assert.rejects(first, /device unavailable/);
  assert.deepEqual(await next, { ok: true });
  assert.deepEqual(box.calls.at(-1), ['output', 'default']);
});

test('DLNA handoff and a newer song load share command order so stale cleanup cannot stop the new song', async () => {
  const gate = deferred();
  const uris = [];
  const box = harness({
    local: { getState: () => ({ path: 'https://cdn.example/old.mp3', playing: true, volume: 50 }) },
    native: {
      action: async (_url, _service, name, args) => {
        box.calls.push(['action', name]);
        if (name === 'SetAVTransportURI') {
          uris.push(args.CurrentURI);
          if (args.CurrentURI.endsWith('/old.mp3')) await gate.promise;
        }
        return {};
      },
    },
  });
  const connecting = box.host.connect('dlna');
  await tick();
  const loading = box.host.load('https://cdn.example/new.mp3', box.host.beginSourceChange());
  await tick();
  const beforeRelease = [...uris];
  gate.resolve();
  await Promise.all([connecting, loading]);
  assert.deepEqual(beforeRelease, ['https://cdn.example/old.mp3']);
  assert.equal(uris.at(-1), 'https://cdn.example/new.mp3');
  assert.equal(box.host.originalUrl, 'https://cdn.example/new.mp3');
  const actions = box.calls.filter((call) => Array.isArray(call) && call[0] === 'action');
  assert.equal(actions.at(-1)[1], 'SetPlayMode');
  await box.host.shutdown();
});

function genaHarness(extra = {}) {
  const armed = new Set();
  const tracked = new Set();
  const tokens = [];
  const gena = {
    start: async () => 8080,
    stop: async () => {},
    armToken(token) {
      armed.add(token);
      tokens.push(token);
    },
    disarmToken: (token) => armed.delete(token),
    callbackUrl: (_instance, token) => `http://192.0.2.20/gena/avt/${token}`,
    trackSubscription: (sid) => tracked.add(sid),
    untrackSubscription: (sid) => tracked.delete(sid),
    ...extra.gena,
  };
  const box = harness({
    ...extra,
    gena,
    subscribe: extra.subscribe ?? (async () => ({ sid: 'uuid:subscription', timeoutSec: 300 })),
  });
  return { ...box, armed, tracked, tokens };
}

test('GENA host retires the temporary token on successful subscription and untracks locally without an unsubscribe adapter', async () => {
  const box = genaHarness();
  assert.equal((await box.host.connect('dlna')).ok, true);
  assert.equal(box.armed.size, 0);
  assert.ok(box.tracked.has('uuid:subscription'));
  await box.host.activateLocal();
  assert.equal(box.tracked.size, 0);
});

test('GENA host retires temporary authorization after a failed subscription', async () => {
  const box = genaHarness({
    subscribe: async () => {
      throw new Error('subscribe failed');
    },
  });
  assert.equal((await box.host.connect('dlna')).ok, true);
  assert.equal(box.armed.size, 0);
  assert.equal(box.tracked.size, 0);
  assert.equal(box.timers.length, 1);
  await box.host.shutdown();
});

test('GENA host retires a token even if callback URL construction fails', async () => {
  const box = genaHarness({
    gena: {
      callbackUrl() {
        throw new Error('callback unavailable');
      },
    },
  });
  assert.equal((await box.host.connect('dlna')).ok, true);
  assert.equal(box.armed.size, 0);
  await box.host.shutdown();
});

test('GENA host shutdown synchronously revokes pending subscription authorization', async () => {
  const gate = deferred();
  const unsubscribed = [];
  const box = genaHarness({
    subscribe: () => gate.promise,
    unsubscribe: async (_url, sid) => unsubscribed.push(sid),
  });
  const connecting = box.host.connect('dlna');
  await tick();
  assert.equal(box.armed.size, 1);
  const shutdown = box.host.shutdown();
  const remaining = box.armed.size;
  gate.resolve({ sid: 'uuid:late', timeoutSec: 300 });
  assert.equal((await connecting).ok, false);
  await shutdown;
  assert.equal(remaining, 0);
  assert.deepEqual(unsubscribed, ['uuid:late']);
  assert.equal(box.tracked.size, 0);
});

test('GENA host uses a fresh random callback token for every subscription', async () => {
  const box = genaHarness();
  await box.host.connect('dlna');
  await box.host.connect('dlna');
  assert.equal(box.tokens.length, 2);
  assert.ok(box.tokens.every((token) => /^[a-f0-9]{32}$/.test(token)));
  assert.notEqual(box.tokens[0], box.tokens[1]);
  assert.equal(box.armed.size, 0);
  await box.host.shutdown();
});

test('GENA host receives escaped HTTP events and rejects old subscription callbacks after reconnecting', async (t) => {
  let box;
  const callbacks = [];
  const receiver = new GenaReceiver({
    bindHost: '127.0.0.1',
    onLastChange: (_sid, change) => box.host.ingestLastChange(change.raw),
  });
  box = harness({
    gena: receiver,
    subscribe: async (_url, callback) => {
      callbacks.push(callback);
      return { sid: `uuid:${callbacks.length}`, timeoutSec: 300 };
    },
  });
  t.after(async () => {
    receiver.server?.closeAllConnections();
    await box.host.shutdown();
    await receiver.stop();
  });
  const send = (url, sid, seconds) =>
    new Promise((resolve, reject) => {
      const xml = `<Event><InstanceID val="0"><TransportState val="PLAYING"/><RelativeTimePosition val="00:00:${String(seconds).padStart(2, '0')}"/></InstanceID></Event>`;
      const escaped = xml
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
      const request = http.request(
        url,
        {
          method: 'NOTIFY',
          agent: false,
          headers: { SID: sid, NT: 'upnp:event', NTS: 'upnp:propchange' },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.setTimeout(1000, () => request.destroy(new Error('notify timed out')));
      request.end(
        `<propertyset><property><LastChange>${escaped}</LastChange></property></propertyset>`,
      );
    });
  await box.host.connect('dlna');
  assert.equal(await send(callbacks[0], 'uuid:1', 9), 200);
  assert.equal(box.host.snapshot().positionSec, 9);
  await box.host.connect('dlna');
  const position = box.host.snapshot().positionSec;
  assert.equal(await send(callbacks[0], 'uuid:1', 59), 412);
  assert.equal(box.host.snapshot().positionSec, position);
  assert.equal(await send(callbacks[1], 'uuid:2', 22), 200);
  assert.equal(box.host.snapshot().positionSec, 22);
});

function runtimeHarness(options = {}) {
  const calls = [];
  const app = new EventEmitter();
  app.isPackaged = false;
  const gate = deferred();
  let host = null;
  const discovery = {
    list: () => [],
    start: options.start ?? (async () => {}),
    search: options.search ?? (async (once) => calls.push(once ? 'search once' : 'search')),
    stop: async () => {
      calls.push('discovery stop');
    },
  };
  const mocks = {
    electron: { app },
    'node:fs': { existsSync: () => false },
    'node:path': path,
    'node:module': {
      createRequire: () => () => {
        throw new Error('unexpected addon');
      },
    },
    '../logger': { info() {}, warn() {}, error() {} },
    '../window': { getMainWindow: () => null },
    '../player': { publishPlayerEvent() {} },
    '../native/logging': { registerNativeLogHandler() {} },
    '../mediaTransport/discovery': { createSsdpDiscovery: () => discovery },
    '../mediaTransport/genaReceiver': {
      GenaReceiver: class {
        async stop() {
          calls.push('gena stop');
        }
      },
    },
    '../mediaTransport/mediaServer': {
      pickLanIpv4: () => '192.0.2.20',
      MediaServer: class {
        async stop() {
          calls.push('media stop');
          await options.mediaStop?.();
        }
      },
    },
    '../mediaTransport/upnpClient': {},
    './airplayBonjourDiagnostics': {},
    './outputHost': {
      getOutputHost: () => host,
      initOutputHost: () => {
        host = {
          wantsScan: true,
          shutdown: () => {
            calls.push('host shutdown');
            return gate.promise;
          },
          noteDlnaDevices() {},
          noteDlnaDescriptionFailures() {},
          noteDlnaScanning: (scanning) => calls.push(scanning ? 'scanning on' : 'scanning off'),
        };
      },
    },
  };
  const code = transformSync(
    readFileSync(join(root, 'src/main/outputs/outputRuntime.ts'), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', 'setInterval', 'clearInterval', code)(
    (name) => {
      assert.ok(name in mocks, `unexpected dependency: ${name}`);
      return mocks[name];
    },
    mod,
    mod.exports,
    join(root, 'src/main/outputs'),
    () => 1,
    () => {},
  );
  mod.exports.initOutputRuntime(() => null);
  return {
    api: mod.exports,
    calls,
    gate,
    app,
    setWantsScan(value) {
      host.wantsScan = value;
    },
  };
}

test('runtime quit and explicit shutdown share cleanup and stop receivers after the host finishes', async () => {
  const mediaGate = deferred();
  const box = runtimeHarness({ mediaStop: () => mediaGate.promise });
  box.app.emit('before-quit');
  let done = false;
  const shutdown = box.api.shutdownOutputRuntime().then(() => {
    done = true;
  });
  await tick();
  assert.deepEqual(box.calls, ['host shutdown']);
  box.gate.resolve();
  await tick();
  assert.equal(done, false);
  assert.deepEqual(box.calls, ['host shutdown', 'discovery stop', 'media stop', 'gena stop']);
  mediaGate.resolve();
  await shutdown;
  assert.equal(done, true);
});

test('runtime shutdown releases other receivers when one receiver fails', async () => {
  const box = runtimeHarness({
    mediaStop: async () => {
      throw new Error('media stop failed');
    },
  });
  const shutdown = box.api.shutdownOutputRuntime();
  box.gate.resolve();
  await shutdown;
  assert.ok(box.calls.includes('discovery stop'));
  assert.ok(box.calls.includes('gena stop'));
});

test('SSDP start completing after runtime shutdown cannot launch a search', async () => {
  const start = deferred();
  const box = runtimeHarness({ start: () => start.promise });
  box.api.syncOutputScan();
  const shutdown = box.api.shutdownOutputRuntime();
  start.resolve();
  box.gate.resolve();
  await shutdown;
  await tick();
  assert.ok(!box.calls.includes('search'));
});

test('runtime shutdown waits for SSDP startup before closing its sockets', async () => {
  const start = deferred();
  const box = runtimeHarness({ start: () => start.promise });
  box.api.syncOutputScan();
  await tick();
  const shutdown = box.api.shutdownOutputRuntime();
  box.gate.resolve();
  await tick();
  const earlyStop = box.calls.includes('discovery stop');
  start.resolve();
  await shutdown;
  assert.equal(earlyStop, false);
  assert.ok(box.calls.includes('discovery stop'));
});

test('runtime shutdown waits for an active SSDP search before closing receivers', async () => {
  const search = deferred();
  const box = runtimeHarness({ search: () => search.promise });
  box.api.syncOutputScan();
  await tick();
  const shutdown = box.api.shutdownOutputRuntime();
  box.gate.resolve();
  await tick();
  const earlyStop = box.calls.includes('discovery stop');
  search.resolve();
  await shutdown;
  assert.equal(earlyStop, false);
  assert.ok(box.calls.includes('discovery stop'));
});

test('overlapping scan requests coalesce before SSDP startup completes', async () => {
  const start = deferred();
  let starts = 0;
  const box = runtimeHarness({
    start: () => {
      starts += 1;
      return start.promise;
    },
  });
  box.api.syncOutputScan();
  box.api.syncOutputScan();
  await tick();
  start.resolve();
  await tick();
  assert.equal(starts, 1);
  assert.equal(box.calls.filter((call) => call === 'search').length, 1);
  box.gate.resolve();
  await box.api.shutdownOutputRuntime();
});

test('re-enabling scanning during a pending stop retains sockets and launches the next scan', async () => {
  const search = deferred();
  let searches = 0;
  const box = runtimeHarness({
    search: async () => {
      searches += 1;
      if (searches === 1) await search.promise;
    },
  });
  box.api.syncOutputScan();
  await tick();
  box.setWantsScan(false);
  box.api.syncOutputScan();
  box.setWantsScan(true);
  box.api.syncOutputScan();
  search.resolve();
  await tick();
  assert.equal(searches, 2);
  assert.ok(!box.calls.includes('discovery stop'));
  box.gate.resolve();
  await box.api.shutdownOutputRuntime();
});

test('a DLNA device whose description cannot be read is reported instead of looking absent', async () => {
  // 设备描述不合规的设备不会进入投放列表。UI 若只显示「没有找到设备」，
  // 描述解析失败就会被伪装成发现失败，排查时无从下手。
  const box = harness();
  const usn = 'uuid:broken-device';
  const location = 'http://192.168.6.184:9999/broken.xml';
  // 描述失败的设备不会进入投放列表，这里复现「AirPlay 无设备、DLNA 描述读不出」
  // 的组合：既没有可投的目标，也没有任何 AirPlay 结果。
  box.host.removeDlnaDevice('dlna');
  box.host.setEnabled(true);
  box.host.noteDlnaDescriptionFailures([
    {
      usn,
      location,
      error: 'device description failed: Invalid response: path does not start with slash',
    },
  ]);
  await box.host.refresh();
  await tick();
  const view = box.host.sessionView();
  assert.match(view.diagnostics, /已发现 1 台 DLNA 设备，但读取设备描述失败/);
  assert.match(view.diagnostics, /path does not start with slash/);
  assert.deepEqual(
    view.targets.filter((t) => t.protocol === 'dlna').map((t) => t.targetId),
    [],
  );
});

test('description failures clear once the device description loads', async () => {
  const box = harness();
  const usn = 'uuid:broken-device';
  box.host.noteDlnaDescriptionFailures([
    { usn, location: 'http://192.168.6.184:9999/broken.xml', error: 'boom' },
  ]);
  box.host.noteDlnaDescriptionFailures([]);
  assert.doesNotMatch(box.host.sessionView().diagnostics, /读取设备描述失败/);
});

test('DLNA searching follows the SSDP flight instead of the diagnostics wording', async () => {
  // `searching` 曾由 `diagnostics.startsWith('正在搜索投放设备')` 推断。
  // 文案会因为描述失败、AirPlay 未构建等原因停在别的字符串上，用它判断会让
  // 刷新按钮在扫描早已结束后继续转圈。
  const box = harness();
  box.host.setEnabled(true);
  assert.equal(box.host.searching, false, 'idle host is not searching');
  const view = box.host.sessionView();
  assert.equal(view.searching, false);

  box.host.noteDlnaScanning(true);
  assert.equal(box.host.searching, true, 'a live SSDP flight counts as searching');
  assert.equal(box.host.sessionView().searching, true);

  box.host.noteDlnaScanning(true);
  box.host.noteDlnaScanning(false);
  assert.equal(box.host.searching, false, 'the flight ended');
});

test('a description failure is not a searching state', async () => {
  // 描述读取失败时 diagnostics 会是「已发现 N 台…」，若继续用文案前缀判断
  // 就会误报仍在搜索。这里确认两者互不干扰。
  const box = harness();
  box.host.setEnabled(true);
  box.host.noteDlnaDescriptionFailures([
    { usn: 'uuid:x', location: 'http://192.168.6.184:9999/x.xml', error: 'boom' },
  ]);
  assert.doesNotMatch(box.host.sessionView().diagnostics, /^正在搜索投放设备/);
  assert.equal(box.host.searching, false);
});

test('the refresh button starts a fresh SSDP round even while one is idle-running', async () => {
  // `syncOutputScan` 只在空闲时启动扫描，所以刷新必须走 rescan 才真的有
  // 网络动作；否则一轮跑完后连点刷新什么也不会发生。
  const search = deferred();
  let searches = 0;
  const modes = [];
  const box = runtimeHarness({
    search: async (once) => {
      searches += 1;
      modes.push(once ? 'once' : 'full');
      if (searches === 1) await search.promise;
    },
  });
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  assert.equal(searches, 1, 'the initial scan is the full three-round cycle');
  assert.deepEqual(modes, ['full']);

  // 扫描仍在进行：刷新要排队到当前轮结束后再补一轮，而不是被静默忽略。
  const rescan = box.api.rescanDlnaDevices();
  await tick();
  assert.equal(searches, 1, 'the rescan waits for the in-flight cycle');
  search.resolve();
  await rescan;
  assert.equal(searches, 2, 'the rescan ran its own round');
  assert.deepEqual(modes, ['full', 'once'], 'a manual refresh only needs one round');
});

test('rescan while idle starts a single round without waiting', async () => {
  let searches = 0;
  const modes = [];
  const box = runtimeHarness({
    search: async (once) => {
      searches += 1;
      modes.push(once ? 'once' : 'full');
    },
  });
  box.setWantsScan(true);
  await box.api.rescanDlnaDevices();
  assert.equal(searches, 1);
  assert.deepEqual(modes, ['once']);
});

test('the refresh IPC handler runs one round and never starts the full cycle', async () => {
  // `syncOutputScan` 在空闲时会启动完整的三轮周期（约 7 秒）。刷新的 IPC
  // 处理器若先调它再补一轮，一次点击就要等约 8 秒。
  const calls = [];
  const host = {
    wantsScan: true,
    targets: () => [],
    refresh: async () => 'refreshed',
    sessionView: () => ({}),
    setEnabled() {},
    setBrowsing() {},
    activateLocal: async () => {},
  };
  const handlers = new Map();
  const mocks = {
    './registry': {
      ipcRegistry: {
        registerHandler: (channel, handler) => handlers.set(channel, handler),
      },
    },
    '../outputs/outputHost': { getOutputHost: () => host },
    '../outputs/outputRuntime': {
      rescanDlnaDevices: async () => calls.push('rescan'),
      syncOutputScan: () => calls.push('sync'),
    },
  };
  const code = transformSync(readFileSync(join(root, 'src/main/ipc/output.ts'), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in mocks, `unexpected dependency: ${name}`);
      return mocks[name];
    },
    mod,
    mod.exports,
  );
  mod.exports.registerOutputIpc();
  assert.equal(await handlers.get('output:refresh')(), 'refreshed');
  assert.deepEqual(calls, ['rescan'], 'a refresh rescans once and never starts the full cycle');
});

test('a chained rescan never reports searching as finished in between', async () => {
  // 扫描进行中点刷新会排队补一轮。若前一轮结束时把 searching 清成 false，
  // 按钮会在一次点击中途假停一下。
  const search = deferred();
  let searches = 0;
  const box = runtimeHarness({
    search: async () => {
      searches += 1;
      if (searches === 1) await search.promise;
    },
  });
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  assert.ok(box.calls.includes('scanning on'));

  const rescan = box.api.rescanDlnaDevices();
  await tick();
  search.resolve();
  await rescan;
  assert.deepEqual(
    box.calls.filter((call) => call.startsWith('scanning')),
    ['scanning on', 'scanning off'],
    'scanning only reports once at the end of both rounds',
  );
});

test('scanning settles back to idle after the panel opens and scans finish', async () => {
  // 投放面板打开时的真实序列：setBrowsing(true) 启动扫描 -> refresh 补一轮。
  // 两次扫描都必须真的收敛到「不在搜索」，否则刷新按钮会一直转圈。
  const box = runtimeHarness();
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await box.api.rescanDlnaDevices();
  await tick();
  assert.deepEqual(
    box.calls.filter((call) => call.startsWith('scanning')),
    ['scanning on', 'scanning off'],
  );
  assert.equal(box.calls.includes('scanning off'), true);
  // 空闲后不会再自发启动扫描：M-SEARCH 不是周期任务。
  const before = box.calls.filter((call) => call.startsWith('search')).length;
  await tick();
  await tick();
  assert.equal(
    box.calls.filter((call) => call.startsWith('search')).length,
    before,
    'no scan runs on its own once idle',
  );
});

test('closing the panel while network playback is on does not leave scanning stuck', async () => {
  const search = deferred();
  const box = runtimeHarness({
    search: () => search.promise,
  });
  // 网络播放开启时 wantsScan 恒为 true，面板关闭后 syncOutputScan 仍会看到它。
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  assert.ok(box.calls.includes('scanning on'));
  search.resolve();
  await tick();
  await tick();
  assert.ok(box.calls.includes('scanning off'), 'the scan settles');
});

test('closing the panel does not trigger a fresh SSDP burst while network playback stays on', async () => {
  // `wantsScan` 含 `enabled`（网络播放开关），所以面板关闭后它仍为真。
  // 若 syncOutputScan 每次都补一轮，关闭面板这种与搜索无关的操作就会触发
  // 一次 7 秒 M-SEARCH 突发，并把 searching 重新点亮 7 秒。
  const box = runtimeHarness();
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  const afterOpen = box.calls.filter((call) => call.startsWith('search')).length;
  assert.equal(afterOpen, 1);

  // 面板关闭：wantsScan 仍为 true（网络播放开着），sync 被再次调用。
  box.api.syncOutputScan();
  await tick();
  await tick();
  assert.equal(
    box.calls.filter((call) => call.startsWith('search')).length,
    afterOpen,
    'an idle resync does not rescan',
  );
});

test('re-entering the scanning state scans again after leaving it', async () => {
  const box = runtimeHarness();
  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  assert.equal(box.calls.filter((call) => call.startsWith('search')).length, 1);

  box.setWantsScan(false);
  box.api.syncOutputScan();
  await tick();
  await tick();

  box.setWantsScan(true);
  box.api.syncOutputScan();
  await tick();
  assert.equal(
    box.calls.filter((call) => call.startsWith('search')).length,
    2,
    'the edge trigger re-arms after leaving the scanning state',
  );
});

test('the last published searching value is false once an AirPlay scan ends', async () => {
  // renderer 只消费 publish 出来的 payload，不看 host.searching getter。
  // `scanAirplayDevices` 的收尾 publish 发生在 airplayScanFlight 清空之前，
  // 那一次 payload 里 searching 仍是 true —— 断言 getter 会漏掉它。
  const gate = deferred();
  const box = harness({ airplay: { discover: () => gate.promise } });
  const published = () =>
    box.events.filter((e) => e.payload && 'searching' in e.payload).map((e) => e.payload.searching);
  box.host.setEnabled(true);
  await box.host.refresh();
  await tick();
  assert.equal(published().at(-1), true, 'the in-flight scan publishes searching=true');

  gate.resolve([]);
  for (let i = 0; i < 20 && box.host.searching; i += 1) await tick();
  await tick();
  assert.equal(box.host.searching, false, 'the getter settled');
  assert.equal(
    published().at(-1),
    false,
    'and the renderer was told so — otherwise the refresh button spins forever',
  );
});

test('opening the cast panel cannot scan while network playback is disabled', async () => {
  let discoveries = 0;
  const box = harness({
    airplay: {
      discover: async () => {
        discoveries += 1;
        return [];
      },
    },
  });
  box.host.setBrowsing(true);
  await box.host.refresh();
  assert.equal(box.host.wantsScan, false);
  assert.equal(box.host.searching, false);
  assert.equal(discoveries, 0);
});

test('disabling casting with the panel open revokes scans and ignores late AirPlay results', async () => {
  const gate = deferred();
  let progress;
  const box = harness({
    airplay: {
      discoverEach: (_timeout, callback) => {
        progress = callback;
        return gate.promise;
      },
    },
  });
  box.host.setBrowsing(true);
  box.host.setEnabled(true);
  box.host.noteDlnaScanning(true);
  await box.host.refresh();
  assert.equal(box.host.searching, true);
  box.host.setEnabled(false);
  assert.equal(box.host.wantsScan, false);
  assert.equal(box.host.sessionView().searching, false);
  const late = { id: 'late-disabled', name: 'Late', needsPin: false };
  progress(late);
  gate.resolve([late]);
  await tick();
  await tick();
  assert.ok(!box.host.targets().some((target) => target.targetId === late.id));
  assert.equal(box.host.diagnosticMessage, '网络播放未开启');
  assert.equal(box.host.sessionView().searching, false);
});

test('re-enabling casting during an old AirPlay scan starts one new scan after it drains', async () => {
  const gate = deferred();
  let discoveries = 0;
  const fresh = { id: 'fresh-enabled', name: 'Fresh', needsPin: false };
  const box = harness({
    airplay: {
      discover: () => {
        discoveries += 1;
        return discoveries === 1 ? gate.promise : Promise.resolve([fresh]);
      },
    },
  });
  box.host.setBrowsing(true);
  box.host.setEnabled(true);
  await box.host.refresh();
  box.host.setEnabled(false);
  box.host.setEnabled(true);
  await box.host.refresh();
  assert.equal(discoveries, 1);
  gate.resolve([{ id: 'stale', name: 'Stale', needsPin: false }]);
  await tick();
  await tick();
  assert.equal(discoveries, 2);
  assert.ok(box.host.targets().some((target) => target.targetId === fresh.id));
  assert.ok(!box.host.targets().some((target) => target.targetId === 'stale'));
  assert.equal(box.host.searching, false);
});
