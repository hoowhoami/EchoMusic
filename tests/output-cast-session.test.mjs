import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const bundleDir = mkdtempSync(join(tmpdir(), 'echo-output-bundle-'));
const outfile = join(bundleDir, 'bundle.mjs');
await build({
  stdin: {
    contents: `
      export { OutputHost } from ${JSON.stringify(join(root, 'src/main/outputs/outputHost.ts'))};
      export { decideMediaDelivery } from ${JSON.stringify(join(root, 'src/main/mediaTransport/delivery.ts'))};
      export { CommandGate } from ${JSON.stringify(join(root, 'src/main/outputs/commandGate.ts'))};
      export { endpointAllowed } from ${JSON.stringify(join(root, 'src/main/mediaTransport/upnpClient.ts'))};
      export { MediaServer } from ${JSON.stringify(join(root, 'src/main/mediaTransport/mediaServer.ts'))};
    `,
    resolveDir: root,
    sourcefile: 'output-cast-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  external: ['electron'],
});
const { OutputHost, decideMediaDelivery, CommandGate, endpointAllowed, MediaServer } = await import(
  pathToFileURL(outfile).href
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

const LOCATION = 'http://192.0.2.10/description.xml';
const SERVICES = [
  {
    serviceId: 'urn:upnp-org:serviceId:AVTransport',
    serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
    controlUrl: 'http://192.0.2.10/av',
    eventSubUrl: '',
  },
  {
    serviceId: 'urn:upnp-org:serviceId:RenderingControl',
    serviceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
    controlUrl: 'http://192.0.2.10/rc',
    eventSubUrl: '',
  },
  {
    serviceId: 'urn:upnp-org:serviceId:ConnectionManager',
    serviceType: 'urn:schemas-upnp-org:service:ConnectionManager:1',
    controlUrl: 'http://192.0.2.10/cm',
    eventSubUrl: '',
  },
];

function harness(options = {}) {
  const calls = [];
  const player = [];
  const output = [];
  const logs = [];
  const local = {
    plays: 0,
    loads: 0,
    beginSourceChange() {
      return 1;
    },
    async loadFile(url) {
      local.loads += 1;
      local.loaded = url;
      return { seq: 7, duration: 120 };
    },
    async pause() {},
    async play() {
      local.plays += 1;
    },
    async stop() {},
    async seek(time) {
      local.seeked = time;
    },
    async setVolume() {},
    getState() {
      return { playing: false, volume: options.localVolume ?? 80, timePos: 0, duration: 0 };
    },
  };
  const transport = {
    state: 'PLAYING',
    rel: '00:00:01',
    dur: '00:02:00',
    uri: 'https://cdn.example/song.mp3',
  };
  let gate = null;
  const native = {
    async loadDevice(url) {
      return {
        descriptionUrl: url,
        deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
        friendlyName: 'Speaker',
        services: SERVICES,
      };
    },
    async action(_url, serviceId, name, args) {
      calls.push({ serviceId, name, args });
      if (gate && name === 'SetAVTransportURI') return gate;
      if (name === 'GetProtocolInfo') return { Sink: 'http-get:*:audio/mpeg:*' };
      if (name === 'GetVolume') return { CurrentVolume: '20' };
      if (name === 'GetTransportInfo') return { CurrentTransportState: transport.state };
      if (name === 'GetPositionInfo') {
        return { RelTime: transport.rel, TrackDuration: transport.dur, TrackURI: transport.uri };
      }
      return {};
    },
    async clearDeviceCache() {},
  };
  const media = new MediaServer({ bindHost: '127.0.0.1', log: () => {} });
  const host = new OutputHost({
    now: () => 1_000,
    local,
    native,
    airplay: options.airplay,
    media,
    allowLoopbackRelay: true,
    localNetworkIdentity: options.localNetworkIdentity,
    schedule: () => ({ cancel() {} }),
    emitPlayer: (event, ...args) => player.push([event, ...args]),
    emitOutput: (event) => output.push(event),
    log: (level, message) => logs.push([level, message]),
    runAirplayDiagnostics: options.runAirplayDiagnostics,
  });
  host.noteDlnaDevices([{ usn: 'uuid:renderer-1', location: LOCATION, server: 'Speaker' }]);
  return {
    host,
    calls,
    player,
    output,
    logs,
    local,
    transport,
    media,
    holdUri() {
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      gate = pending.then(() => ({}));
      return () => release({});
    },
  };
}

test('delivery keeps direct URLs direct and relays private, signed, or local sources', () => {
  assert.equal(decideMediaDelivery({ url: 'https://cdn.example/song.mp3' }).mode, 'direct');
  assert.equal(
    decideMediaDelivery({ url: 'https://cdn.example/song.mp3?token=abc' }).mode,
    'relay',
  );
  assert.equal(decideMediaDelivery({ url: 'http://127.0.0.1:9/song.mp3' }).mode, 'relay');
  assert.equal(
    decideMediaDelivery({
      url: 'https://cdn.example/song.mp3',
      headers: { Authorization: 'Bearer secret' },
    }).mode,
    'relay',
  );
  assert.equal(decideMediaDelivery({ url: '/tmp/song.flac' }).mode, 'relay');
  const rejected = decideMediaDelivery({
    url: 'https://cdn.example/song.flac',
    sinkProtocolInfo: 'http-get:*:audio/mpeg:*',
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /不会转码/);
  assert.equal(
    decideMediaDelivery({ url: 'https://cdn.example/song.bin', sinkProtocolInfo: 'audio/mpeg' }).ok,
    true,
  );
});

test('command gate drops a load superseded before it finishes', async () => {
  const gate = new CommandGate();
  const first = gate.bump();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const running = gate.run(async (generation) => {
    await pending;
    if (generation !== gate.current) return null;
    return generation;
  });
  assert.equal(first, 1);
  gate.bump();
  release();
  assert.equal(await running, null);
});

test('device endpoints cannot leave the description host', () => {
  assert.equal(endpointAllowed('http://192.0.2.10/av', '192.0.2.10'), true);
  assert.equal(endpointAllowed('http://user:pass@192.0.2.10/av', '192.0.2.10'), false);
  assert.equal(endpointAllowed('http://evil.test/av', '192.0.2.10'), false);
  assert.equal(endpointAllowed('file:///tmp/song.mp3', '192.0.2.10'), false);
});

test('DLNA relays a local file and passes the token URL, not the filesystem path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-cast-'));
  const file = join(dir, 'song.mp3');
  writeFileSync(file, Buffer.alloc(32));
  const { host, calls, media } = harness();
  try {
    assert.deepEqual(await host.connect('uuid:renderer-1'), { ok: true });
    const requestId = host.beginSourceChange();
    const loaded = await host.load(`file://${file}`, requestId);
    assert.ok(loaded?.seq > 0);
    const uri = calls.filter((call) => call.name === 'SetAVTransportURI').at(-1).args.CurrentURI;
    assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/res\/[a-f0-9]+$/);
    assert.doesNotMatch(uri, /song\.mp3/);
  } finally {
    await media.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DLNA direct delivery keeps the original URL and rejects an unsupported type', async () => {
  const { host, calls, media } = harness();
  try {
    await host.connect('uuid:renderer-1');
    const requestId = host.beginSourceChange();
    await host.load('https://cdn.example/song.mp3', requestId);
    const direct = calls.filter((call) => call.name === 'SetAVTransportURI').at(-1);
    assert.equal(direct.args.CurrentURI, 'https://cdn.example/song.mp3');
    assert.equal(direct.serviceId, 'urn:upnp-org:serviceId:AVTransport');
    const next = host.beginSourceChange();
    await assert.rejects(host.load('https://cdn.example/song.flac', next), /不会转码/);
    assert.equal(calls.filter((call) => call.name === 'SetAVTransportURI').length, 1);
  } finally {
    await media.stop();
  }
});

test('DLNA list title does not expose raw SSDP server header', async () => {
  const { host, media } = harness();
  try {
    host.noteDlnaDevices([
      {
        usn: 'uuid:smartshare-1',
        location: LOCATION,
        server: 'Linux/4.19.116+, UPnP/1.0, SmartShare device/1.0',
      },
    ]);
    assert.equal(
      host.targets().find((target) => target.targetId === 'uuid:smartshare-1')?.displayName,
      'SmartShare',
    );
    await host.connect('uuid:smartshare-1');
    assert.equal(
      host.targets().find((target) => target.targetId === 'uuid:smartshare-1')?.displayName,
      'Speaker',
    );
  } finally {
    await media.stop();
  }
});

test('DLNA discovery logs stable device identity fields', async () => {
  const { host, logs, media } = harness();
  try {
    host.noteDlnaDevices([
      {
        usn: 'uuid:smartshare-1',
        location: 'http://192.0.2.31:8200/root.xml',
        server: 'Linux/4.19.116+, UPnP/1.0, SmartShare device/1.0',
        st: 'urn:schemas-upnp-org:device:MediaRenderer:1',
        interface: '192.0.2.31',
        maxAgeSec: 1800,
      },
    ]);
    const line = logs.find(
      ([level, message]) =>
        level === 'info' &&
        message.includes('DLNA 发现设备') &&
        message.includes('uuid:smartshare-1'),
    )?.[1];
    assert.ok(line);
    assert.match(line, /SmartShare/);
    assert.match(line, /location=http:\/\/192\.0\.2\.31:8200\/root\.xml/);
    assert.match(line, /server=Linux\/4\.19\.116\+, UPnP\/1\.0, SmartShare device\/1\.0/);
    assert.match(line, /st=urn:schemas-upnp-org:device:MediaRenderer:1/);
    assert.match(line, /from=192\.0\.2\.31/);
  } finally {
    await media.stop();
  }
});

test('DLNA targets expose a stable note for same-name devices', async () => {
  const { host, media } = harness();
  try {
    host.noteDlnaDevices([
      {
        usn: 'uuid:gateway-a',
        location: 'http://192.168.1.1:52869/description.xml',
        server: 'Linux, UPnP/1.0',
        name: '天翼网关',
        manufacturer: 'CT',
        modelName: 'Gateway',
        modelNumber: 'A',
        serialNumber: 'SN-001',
      },
      {
        usn: 'uuid:gateway-b',
        location: 'http://192.168.1.100:52869/description.xml',
        server: 'Linux, UPnP/1.0',
        name: '天翼网关',
      },
    ]);
    const first = host.targets().find((target) => target.targetId === 'uuid:gateway-a');
    const second = host.targets().find((target) => target.targetId === 'uuid:gateway-b');
    assert.equal(first?.displayName, '天翼网关');
    assert.match(first?.note ?? '', /CT · Gateway · A · SN-001 · 192\.168\.1\.1:52869/);
    assert.equal(second?.displayName, '天翼网关');
    assert.match(second?.note ?? '', /192\.168\.1\.100:52869/);
  } finally {
    await media.stop();
  }
});

test('natural STOPPED emits one EOF and a user stop or external URI does not', async () => {
  const { host, player, transport, media } = harness();
  try {
    await host.connect('uuid:renderer-1');
    const requestId = host.beginSourceChange();
    await host.load('https://cdn.example/song.mp3', requestId);
    transport.state = 'STOPPED';
    transport.rel = '00:02:00';
    transport.uri = 'https://cdn.example/song.mp3';
    await host.pollOnce();
    await host.pollOnce();
    assert.equal(player.filter((event) => event[0] === 'playback-end').length, 1);
    assert.equal(player.find((event) => event[0] === 'playback-end')[1], 'eof');

    const stopped = harness();
    await stopped.host.connect('uuid:renderer-1');
    const stopRequest = stopped.host.beginSourceChange();
    await stopped.host.load('https://cdn.example/song.mp3', stopRequest);
    await stopped.host.stop();
    stopped.transport.state = 'STOPPED';
    stopped.transport.rel = '00:02:00';
    stopped.transport.uri = 'https://cdn.example/song.mp3';
    await stopped.host.pollOnce();
    assert.equal(stopped.player.filter((event) => event[0] === 'playback-end').length, 0);
    await stopped.media.stop();

    const taken = harness();
    await taken.host.connect('uuid:renderer-1');
    const takenRequest = taken.host.beginSourceChange();
    await taken.host.load('https://cdn.example/song.mp3', takenRequest);
    taken.transport.state = 'STOPPED';
    taken.transport.rel = '00:02:00';
    taken.transport.uri = 'http://other.example/song.mp3';
    await taken.host.pollOnce();
    assert.equal(taken.player.filter((event) => event[0] === 'playback-end').length, 0);
    assert.match(taken.host.diagnosticMessage, /接管/);
    await taken.media.stop();
  } finally {
    await media.stop();
  }
});

test('a superseded load does not publish the old track', async () => {
  const box = harness();
  const release = box.holdUri();
  try {
    await box.host.connect('uuid:renderer-1');
    const requestId = box.host.beginSourceChange();
    const loading = box.host.load('https://cdn.example/song.mp3', requestId);
    box.host.beginSourceChange();
    release();
    assert.equal(await loading, null);
    assert.equal(box.player.filter((event) => event[0] === 'playback-end').length, 0);
  } finally {
    await box.media.stop();
  }
});

test('device loss pauses without EOF and without starting local playback', async () => {
  const box = harness();
  const original = box.calls;
  try {
    await box.host.connect('uuid:renderer-1');
    const requestId = box.host.beginSourceChange();
    await box.host.load('https://cdn.example/song.mp3', requestId);
    box.host['deps'].native.action = async () => {
      throw new Error('timed out');
    };
    await box.host.pollOnce();
    await box.host.pollOnce();
    await box.host.pollOnce();
    assert.equal(box.local.plays, 0);
    assert.equal(box.player.filter((event) => event[0] === 'playback-end').length, 0);
    assert.equal(
      box.player.some((event) => event[0] === 'state-change' && event[1].paused),
      true,
    );
    await assert.rejects(box.host.play(), /已暂停/);
    assert.equal(original.length > 0, true);
  } finally {
    await box.media.stop();
  }
});

test('entering a device does not stamp the local volume onto it', async () => {
  const box = harness({ localVolume: 80 });
  try {
    await box.host.connect('uuid:renderer-1');
    await box.host.setVolume(80);
    assert.equal(
      box.calls.some((call) => call.name === 'SetVolume'),
      false,
    );
    await box.host.setVolume(15);
    assert.equal(
      box.calls.filter((call) => call.name === 'SetVolume').at(-1).args.DesiredVolume,
      '15',
    );
  } finally {
    await box.media.stop();
  }
});

test('explicit return to local resumes from the last position and an unavailable AirPlay target is not success', async () => {
  const box = harness();
  try {
    await box.host.connect('uuid:renderer-1');
    const requestId = box.host.beginSourceChange();
    await box.host.load('https://cdn.example/song.mp3', requestId);
    await box.host.play();
    await box.host.activateLocal('user');
    assert.equal(box.local.loads, 1);
    assert.equal(box.local.loaded, 'https://cdn.example/song.mp3');
    assert.equal(box.local.plays, 1);
    box.host.noteAirplayDevices([{ id: 'aa:bb:cc:dd:ee:ff', name: 'Room', needsPin: false }]);
    const missing = await box.host.connect('aa:bb:cc:dd:ee:ff');
    assert.equal(missing.ok, false);
    assert.match(missing.error, /尚未构建/);
  } finally {
    await box.media.stop();
  }
});

test('local AirPlay receiver is hidden from discovered targets', async () => {
  const box = harness({
    localNetworkIdentity: () => ({
      addresses: ['192.0.2.44', 'fe80::abcd'],
      macs: ['aa:bb:cc:dd:ee:ff'],
    }),
  });
  try {
    box.host.noteAirplayDevices([
      {
        id: 'aa:bb:cc:dd:ee:ff',
        name: 'This Mac',
        model: 'MacBookPro',
        addresses: ['192.0.2.44'],
        needsPin: false,
      },
      {
        id: '11:22:33:44:55:66',
        name: 'Living Room',
        model: 'AppleTV',
        addresses: ['192.0.2.55'],
        needsPin: false,
      },
    ]);
    const airplayTargets = box.host.targets().filter((target) => target.protocol === 'airplay');
    assert.deepEqual(
      airplayTargets.map((target) => target.displayName),
      ['Living Room'],
    );
    assert.equal(
      box.logs.some(([level, message]) => level === 'info' && message.includes('忽略本机 AirPlay')),
      true,
    );
  } finally {
    await box.media.stop();
  }
});

test('AirPlay target note distinguishes same-name devices', async () => {
  const box = harness({
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
  });
  try {
    box.host.noteAirplayDevices([
      {
        id: '11:22:33:44:55:66',
        name: 'MacBook Pro',
        model: 'MacBookPro18,1',
        addresses: ['fe80::1', '192.0.2.55'],
        needsPin: false,
      },
      {
        id: '22:33:44:55:66:77',
        name: 'MacBook Pro',
        model: 'MacBookPro17,1',
        addresses: ['192.0.2.56'],
        needsPin: true,
      },
    ]);
    const airplayTargets = box.host.targets().filter((target) => target.protocol === 'airplay');
    assert.deepEqual(
      airplayTargets.map((target) => target.displayName),
      ['MacBook Pro', 'MacBook Pro'],
    );
    assert.deepEqual(
      airplayTargets.map((target) => target.note),
      ['MacBookPro18,1 · 192.0.2.55', '需要 PIN · MacBookPro17,1 · 192.0.2.56'],
    );
  } finally {
    await box.media.stop();
  }
});

test('explicit DLNA removal clears the last visible remote target', async () => {
  const box = harness();
  try {
    assert.equal(
      box.host.targets().some((target) => target.protocol === 'dlna'),
      true,
    );
    box.host.removeDlnaDevice('uuid:renderer-1');
    assert.equal(
      box.host.targets().some((target) => target.protocol === 'dlna'),
      false,
    );
  } finally {
    await box.media.stop();
  }
});

test('AirPlay connection failure is logged for diagnostics', async () => {
  const box = harness({
    airplay: {
      available: true,
      async discover() {
        return [];
      },
      async connect() {
        return { ok: false, error: 'pair verify failed' };
      },
      async disconnect() {},
      async pause() {},
      async resume() {},
      async seek() {
        return 0;
      },
      async stop() {},
      async setVolume() {},
      async flushTrack() {
        return 0;
      },
      status() {
        return { connected: false, delaySec: 0, format: '', inputBits: 16 };
      },
    },
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
  });
  try {
    box.host.noteAirplayDevices([
      { id: '11:22:33:44:55:66', name: 'Living Room', needsPin: false },
    ]);
    const result = await box.host.connect('11:22:33:44:55:66');
    assert.equal(result.ok, false);
    assert.match(result.error, /pair verify failed/);
    assert.equal(
      box.logs.some(
        ([level, message]) =>
          level === 'warn' &&
          message.includes('AirPlay 连接失败') &&
          message.includes('pair verify failed'),
      ),
      true,
    );
  } finally {
    await box.media.stop();
  }
});

test('empty AirPlay discovery updates diagnostics for troubleshooting', async () => {
  let diagnosticsCalls = 0;
  const box = harness({
    airplay: {
      available: true,
      async discover() {
        return [];
      },
      async connect() {
        return { ok: false };
      },
      async disconnect() {},
      async pause() {},
      async resume() {},
      async seek() {
        return 0;
      },
      async stop() {},
      async setVolume() {},
      async flushTrack() {
        return 0;
      },
      status() {
        return { connected: false, delaySec: 0, format: '', inputBits: 16 };
      },
    },
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
    runAirplayDiagnostics: () => {
      diagnosticsCalls += 1;
    },
  });
  try {
    box.host.setEnabled(true);
    await box.host.refresh();
    await tick();
    assert.match(box.host.diagnosticMessage, /未发现 AirPlay/);
    assert.equal(diagnosticsCalls, 1);
    assert.equal(
      box.logs.some(([level, message]) => level === 'info' && message.includes('AirPlay 发现完成')),
      true,
    );
  } finally {
    await box.media.stop();
  }
});

test('hidden local AirPlay receiver does not expand Bonjour diagnostics', async () => {
  let diagnosticsCalls = 0;
  const box = harness({
    airplay: {
      available: true,
      async discover() {
        return [
          {
            id: '62:98:33:E3:BB:50',
            name: 'whoami的MacBook Pro',
            addresses: ['127.0.0.1'],
            needsPin: false,
          },
        ];
      },
      async connect() {
        return { ok: false };
      },
      async disconnect() {},
      async pause() {},
      async resume() {},
      async seek() {
        return 0;
      },
      async stop() {},
      async setVolume() {},
      async flushTrack() {
        return 0;
      },
      status() {
        return { connected: false, delaySec: 0, format: '', inputBits: 16 };
      },
    },
    localNetworkIdentity: () => ({
      addresses: ['127.0.0.1'],
      macs: ['62:98:33:E3:BB:50'],
    }),
    runAirplayDiagnostics: () => {
      diagnosticsCalls += 1;
    },
  });
  try {
    box.host.setEnabled(true);
    await box.host.refresh();
    await tick();
    assert.equal(diagnosticsCalls, 0);
    assert.equal(box.host.diagnosticMessage, '仅发现本机 AirPlay，已隐藏');
  } finally {
    await box.media.stop();
  }
});

test('concurrent output refresh reuses the active AirPlay discovery', async () => {
  let discoverCalls = 0;
  let releaseDiscover;
  const box = harness({
    airplay: {
      available: true,
      discover() {
        discoverCalls += 1;
        return new Promise((resolve) => {
          releaseDiscover = () =>
            resolve([{ id: '11:22:33:44:55:66', name: 'Office Mac', needsPin: false }]);
        });
      },
      async connect() {
        return { ok: false };
      },
      async disconnect() {},
      async pause() {},
      async resume() {},
      async seek() {
        return 0;
      },
      async stop() {},
      async setVolume() {},
      async flushTrack() {
        return 0;
      },
      status() {
        return { connected: false, delaySec: 0, format: '', inputBits: 16 };
      },
    },
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
  });
  try {
    box.host.setEnabled(true);
    const first = box.host.refresh();
    const second = box.host.refresh();
    assert.equal(discoverCalls, 1);
    await Promise.all([first, second]);
    releaseDiscover();
    await tick();
    assert.equal(discoverCalls, 1);
    assert.equal(box.host.targets().filter((target) => target.protocol === 'airplay').length, 1);
  } finally {
    await box.media.stop();
  }
});

test('AirPlay discovery publishes devices while the scan is still running', async () => {
  let releaseDiscover;
  const firstDevice = { id: '11:22:33:44:55:66', name: 'Office Mac', needsPin: false };
  const secondDevice = { id: '22:33:44:55:66:77', name: 'Studio Mac', needsPin: false };
  const box = harness({
    airplay: {
      available: true,
      async discover() {
        return [];
      },
      discoverEach(_timeoutMs, onDevice) {
        onDevice(firstDevice);
        return new Promise((resolve) => {
          releaseDiscover = () => resolve([firstDevice, secondDevice]);
        });
      },
      async connect() {
        return { ok: false };
      },
      async disconnect() {},
      async pause() {},
      async resume() {},
      async seek() {
        return 0;
      },
      async stop() {},
      async setVolume() {},
      async flushTrack() {
        return 0;
      },
      status() {
        return { connected: false, delaySec: 0, format: '', inputBits: 16 };
      },
    },
    localNetworkIdentity: () => ({ addresses: [], macs: [] }),
  });
  try {
    box.host.setEnabled(true);
    await box.host.refresh();
    await tick();
    assert.deepEqual(
      box.host
        .targets()
        .filter((target) => target.protocol === 'airplay')
        .map((target) => target.displayName),
      ['Office Mac'],
    );
    assert.match(box.host.diagnosticMessage, /仍在搜索/);
    releaseDiscover();
    await tick();
    assert.deepEqual(
      box.host
        .targets()
        .filter((target) => target.protocol === 'airplay')
        .map((target) => target.displayName)
        .sort(),
      ['Office Mac', 'Studio Mac'],
    );
  } finally {
    await box.media.stop();
  }
});
