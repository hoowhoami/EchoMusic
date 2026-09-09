import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const source = buildSync({
  entryPoints: [new URL('../src/renderer/utils/kugouVerification.ts', import.meta.url).pathname],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['vue', '@/utils/logger'],
}).outputFiles[0].text;
function setup() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => name === 'vue' ? { reactive: value => value } : { error() {} }, module, module.exports);
  return module.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('failed verification remains pending, fresh verification can succeed and release retry once', async () => {
  const api = setup();
  let verified = false;
  let retries = 0;
  const pending = api.requestKugouVerification('event', async path => path === '/get/verify/info'
    ? { status: 1, data: { v_type: 23 } } : verified ? { status: 1, error_code: 0 } : { status: 0, err_code: 30791 });
  void pending.then(() => retries++);
  await tick();
  assert.equal(await api.submitKugouVerification('first'), false);
  assert.equal(retries, 0);
  assert.equal(api.kugouVerificationState.open, true);
  assert.match(api.kugouVerificationState.error, /验证未通过/);
  verified = true;
  assert.equal(await api.submitKugouVerification('second'), true);
  await pending;
  assert.equal(retries, 1);
  assert.equal(api.kugouVerificationState.open, false);
});
test('expired event can be cancelled and a new request gets a fresh challenge', async () => {
  const api = setup();
  const first = api.requestKugouVerification('expired', async () => { throw { response: { body: { error_code: 36001 } } }; });
  const rejected = assert.rejects(first, /取消/);
  await tick();
  assert.equal(api.kugouVerificationState.status, 'error');
  api.cancelKugouVerification();
  await rejected;
  const second = api.requestKugouVerification('new', async () => ({ status: 1, data: { v_type: 23 } }));
  await tick();
  assert.equal(api.kugouVerificationState.eventId, 'new');
  assert.equal(await api.submitKugouVerification('code'), true);
  await second;
});
test('late failure of a cancelled challenge cannot corrupt the next challenge', async () => {
  const api = setup();
  let rejectOld;
  const first = api.requestKugouVerification('old', () => new Promise((_, reject) => { rejectOld = reject; }));
  const rejected = assert.rejects(first, /取消/);
  const second = api.requestKugouVerification('new', async () => ({ status: 1, data: { v_type: 23 } }));
  api.cancelKugouVerification();
  await rejected;
  await tick();
  rejectOld(new Error('late network error'));
  await tick();
  assert.equal(api.kugouVerificationState.status, 'ready');
  assert.equal(api.kugouVerificationState.eventId, 'new');
  await api.submitKugouVerification('code');
  await second;
});

test('verify info 36001 exposes a recovery message and refresh fetches a fresh configuration', async () => {
  const api = setup();
  let count = 0;
  const pending = api.requestKugouVerification('event', async path => {
    if (path === '/sidedt') return { status: 1 };
    if (++count === 1) throw { response: { body: { status: 0, error_code: 36001 } } };
    return { status: 1, data: { v_type: 23, txappid: 'test' } };
  });
  await tick();
  assert.equal(api.kugouVerificationState.verifyInfo, null);
  assert.equal(api.kugouVerificationState.status, 'error');
  assert.match(api.kugouVerificationState.error, /36001/);
  await api.refreshKugouVerificationInfo();
  assert.equal(count, 2);
  assert.equal(api.kugouVerificationState.status, 'ready');
  assert.equal(api.getKugouCaptchaProvider(api.kugouVerificationState.verifyInfo), 'TX');
  await api.submitKugouVerification('test');
  await pending;
});
