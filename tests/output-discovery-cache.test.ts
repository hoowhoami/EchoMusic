import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSsdpDiscovery } from '../src/main/mediaTransport/discovery.ts';

/** 响应报文首行需是 HTTP/1.1（SSDP 响应）。 */
function msearchResponse(opts: { usn: string; st: string; location: string; maxAge?: string }): string {
  return (
    `HTTP/1.1 200 OK\r\n` +
    `CACHE-CONTROL: max-age=${opts.maxAge ?? '600'}\r\n` +
    `ST: ${opts.st}\r\n` +
    `USN: ${opts.usn}\r\n` +
    `EXT:\r\n` +
    `SERVER: Linux/6.1 UPnP/1.1 EchoMock/1.0\r\n` +
    `LOCATION: ${opts.location}\r\n\r\n`
  );
}

function notify(nts: string, opts: { usn: string; stOrNt: string; location?: string }): string {
  return (
    `NOTIFY * HTTP/1.1\r\n` +
    `HOST: 239.255.255.250:1900\r\n` +
    `NT: ${opts.stOrNt}\r\n` +
    `NTS: ${nts}\r\n` +
    (opts.location ? `LOCATION: ${opts.location}\r\n` : '') +
    `USN: ${opts.usn}\r\n` +
    `CACHE-CONTROL: max-age=600\r\n\r\n`
  );
}

test('M-SEARCH 响应按 USN 缓存、去重、过期', () => {
  let fakeNow = 1_000_000;
  const events: string[] = [];
  const discovery = createSsdpDiscovery({
    now: () => fakeNow,
    log: () => {},
    onDevice: (d) => events.push(`device:${d.usn}`),
  });
  discovery.start().then(async () => {
    const rinfo = { address: '192.168.1.222' };
    discovery.feedForTest(
      msearchResponse({ usn: 'uuid:abc-123::upnp:rootdevice', st: 'upnp:rootdevice', location: 'http://192.168.1.10:57000' }),
      rinfo,
    );
    assert.equal(discovery.cachedUsnCount, 1);
    const entry = discovery.get('uuid:abc-123::upnp:rootdevice');
    assert.ok(entry);
    assert.equal(entry!.location, 'http://192.168.1.10:57000');
    assert.equal(entry!.st, 'upnp:rootdevice');

    // 同一 USN 重复响应 → 不新增
    discovery.feedForTest(
      msearchResponse({ usn: 'uuid:abc-123::upnp:rootdevice', st: 'upnp:rootdevice', location: 'http://192.168.1.10:57000' }),
      rinfo,
    );
    assert.equal(discovery.cachedUsnCount, 1);
    assert.equal(events.filter((e) => e.startsWith('device:')).length, 1);

    // location 变化 → 视为端点变更，仍去重（同 USN）
    discovery.feedForTest(
      msearchResponse({ usn: 'uuid:abc-123::upnp:rootdevice', st: 'upnp:rootdevice', location: 'http://192.168.1.11:57000' }),
      rinfo,
    );
    assert.equal(discovery.cachedUsnCount, 1);
    assert.equal(discovery.get('uuid:abc-123::upnp:rootdevice')!.location, 'http://192.168.1.11:57000');

    // 过期清理
    fakeNow += 601_000;
    assert.equal(discovery.list().length, 0);
    await discovery.stop();
  });
});

test('NOTIFY ssdp:alive 收录、ssdp:byebye 移除', async () => {
  let fakeNow = 1_000_000;
  const discovery = createSsdpDiscovery({ now: () => fakeNow, log: () => {} });
  await discovery.start();

  const usn = 'uuid:renderer-42::urn:schemas-upnp-org:device:MediaRenderer:1';
  const rendererSt = 'urn:schemas-upnp-org:device:MediaRenderer:1';
  discovery.feedForTest(notify('ssdp:alive', { usn, stOrNt: rendererSt, location: 'http://192.168.1.50:1900/desc.xml' }), {
    address: '192.168.1.51',
  });
  assert.equal(discovery.cachedUsnCount, 1);
  assert.ok(discovery.get(usn));

  discovery.feedForTest(notify('ssdp:byebye', { usn, stOrNt: rendererSt }), { address: '192.168.1.51' });
  assert.equal(discovery.cachedUsnCount, 0);

  await discovery.stop();
});

test('多网卡同一 USN 去重合并；不可信 Location 忽略', async () => {
  let fakeNow = 1_000_000;
  const discovery = createSsdpDiscovery({ now: () => fakeNow, log: () => {} });
  await discovery.start();

  const usn = 'uuid:multi-1::upnp:rootdevice';
  const payload = msearchResponse({ usn, st: 'upnp:rootdevice', location: 'http://192.168.1.10:57000' });
  discovery.feedForTest(payload, { address: '192.168.1.10' });
  discovery.feedForTest(payload, { address: '10.0.0.5' });
  assert.equal(discovery.cachedUsnCount, 1);

  // file:、javascript: 等非法 Location 不收录
  discovery.feedForTest(msearchResponse({ usn: 'uuid:evil::upnp:rootdevice', st: 'upnp:rootdevice', location: 'javascript:alert(1)' }), {
    address: '192.168.1.66',
  });
  assert.equal(discovery.cachedUsnCount, 1);

  await discovery.stop();
});

test('超过上限后拒绝新增（防海量响应刷爆内存）', async () => {
  let fakeNow = 1_000_000;
  const discovery = createSsdpDiscovery({ now: () => fakeNow, log: () => {}, maxDevices: 3 });
  await discovery.start();
  for (let i = 0; i < 5; i++) {
    discovery.feedForTest(
      msearchResponse({ usn: `uuid:d-${i}::upnp:rootdevice`, st: 'upnp:rootdevice', location: `http://192.168.1.1:${5000 + i}` }),
      { address: '192.168.1.2' },
    );
  }
  assert.ok(discovery.cachedUsnCount <= 3);
  await discovery.stop();
});

test('无 USN 仅有 ST 时报文被忽略', async () => {
  let fakeNow = 1_000_000;
  const discovery = createSsdpDiscovery({ now: () => fakeNow, log: () => {} });
  await discovery.start();
  // SSDP 响应必须带 USN；报文中缺失则不应入库。
  const raw = `HTTP/1.1 200 OK\r\nST: ssdp:all\r\nLOCATION: http://192.168.1.9:1/x\r\n\r\n`;
  discovery.feedForTest(raw, { address: '192.168.1.9' });
  assert.equal(discovery.cachedUsnCount, 0);
  await discovery.stop();
});