import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/renderer/stores/player/device.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const requests = [];
  const statuses = [];
  const state = { appliedOutputDeviceId: 'default', _lastAppliedExclusive: false };
  const setting = {
    outputDevice: 'default',
    exclusiveAudioDevice: false,
    outputDevices: [],
    setOutputDeviceStatus: (...args) => statuses.push(args),
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (name) => {
      if (name === '@/utils/logger') return { warn() {} };
      if (name === './stateMachine') return {};
      assert.fail(`unexpected dependency ${name}`);
    },
    mod,
    mod.exports,
    {
      electron: {
        player: {
          setAudioOutput(device, exclusive) {
            let resolve, reject;
            const pending = new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            });
            requests.push({ device, exclusive, resolve, reject });
            return pending;
          },
        },
      },
    },
  );
  return {
    manager: mod.exports.createDeviceManager(state, {}, setting),
    state,
    setting,
    requests,
    statuses,
  };
}

test('a new device selection during reconfiguration is applied after the current request', async () => {
  const f = fixture();
  const first = f.manager.applyOutputDevice('speakers');
  await flush();
  const second = f.manager.applyOutputDevice('headphones');
  await flush();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve();
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].device, 'headphones');
  f.requests[1].resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.state.appliedOutputDeviceId, 'headphones');
});
test('queued selections preserve each exclusive-mode snapshot and serialize native changes', async () => {
  const f = fixture();
  const first = f.manager.applyOutputDevice('a');
  await flush();
  f.setting.exclusiveAudioDevice = true;
  const second = f.manager.applyOutputDevice('b');
  f.setting.exclusiveAudioDevice = false;
  const third = f.manager.applyOutputDevice('c');
  f.requests[0].resolve();
  await flush();
  assert.deepEqual(
    f.requests.map((r) => [r.device, r.exclusive]),
    [
      ['a', false],
      ['b', true],
    ],
  );
  f.requests[1].resolve();
  await flush();
  assert.deepEqual(
    f.requests.map((r) => [r.device, r.exclusive]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
  );
  f.requests[2].resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(f.state.appliedOutputDeviceId, 'c');
  assert.equal(f.state._lastAppliedExclusive, false);
});
test('a failed old exclusive-mode request cannot roll back a newer queued selection', async () => {
  const f = fixture();
  f.setting.exclusiveAudioDevice = true;
  const first = f.manager.applyOutputDevice('a');
  await flush();
  const second = f.manager.applyOutputDevice('b');
  f.requests[0].reject(new Error('a unavailable'));
  await flush();
  assert.equal(f.setting.exclusiveAudioDevice, true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].exclusive, true);
  f.requests[1].resolve();
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(f.state.appliedOutputDeviceId, 'b');
});
test('consecutive identical selections share one native reconfiguration', async () => {
  const f = fixture();
  const first = f.manager.applyOutputDevice('a');
  await flush();
  const second = f.manager.applyOutputDevice('a');
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.requests.length, 1);
});
test('returning to an earlier device after another queued selection preserves the latest intent', async () => {
  const f = fixture();
  const first = f.manager.applyOutputDevice('a');
  await flush();
  const second = f.manager.applyOutputDevice('b');
  const third = f.manager.applyOutputDevice('a');
  f.requests[0].resolve();
  await flush();
  assert.equal(f.requests[1]?.device, 'b');
  f.requests[1].resolve();
  await flush();
  assert.equal(f.requests[2]?.device, 'a');
  f.requests[2].resolve();
  await Promise.all([first, second, third]);
  assert.equal(f.state.appliedOutputDeviceId, 'a');
});
test('the latest failed exclusive-mode request still restores the previously applied mode', async () => {
  const f = fixture();
  f.setting.exclusiveAudioDevice = true;
  const pending = f.manager.applyOutputDevice('a');
  await flush();
  f.requests[0].reject(new Error('exclusive unavailable'));
  assert.equal(await pending, false);
  assert.equal(f.setting.exclusiveAudioDevice, false);
  assert.equal(f.state._lastAppliedExclusive, false);
});

test('a queued switch suppresses transient output errors before the native call starts', async () => {
  const f = fixture();
  const pending = f.manager.applyOutputDevice('a');
  assert.equal(
    await f.manager.handleOutputDeviceError({
      errorCode: 'output-runtime',
      reason: 'device-not-available',
      message: 'output device reconfiguration',
    }),
    true,
  );
  await flush();
  f.requests[0].resolve();
  assert.equal(await pending, true);
  assert.equal(
    f.statuses.some(([status]) => status === 'error'),
    false,
  );
});
