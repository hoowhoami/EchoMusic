import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (id) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
  );
  return module.exports;
}

const stateMachine = load('../src/renderer/stores/player/stateMachine.ts');
const { createDeviceManager } = load('../src/renderer/stores/player/device.ts', {
  '@/utils/logger': { default: logger },
  './stateMachine': stateMachine,
});

function fixture({ pauseOnDisconnect }) {
  const state = {
    currentTrackId: '42',
    currentSourceQueueId: 'queue',
    lastError: null,
    playbackNotice: null,
    awaitingTrackLoad: false,
    supersededNativeTrackSeq: null,
    stallRecovering: false,
    playbackIntent: {
      seq: 1,
      trackId: '42',
      sourceQueueId: 'queue',
      shouldPlay: true,
      phase: 'ready',
      startedAt: 0,
    },
    enginePlayback: { status: 'playing', trackId: '42', updatedAt: 0 },
  };
  const calls = { pause: 0, notices: [], status: [] };
  const engine = {
    async pause() {
      calls.pause += 1;
    },
  };
  const settingStore = {
    pauseOnOutputDeviceDisconnect: pauseOnDisconnect,
    outputDevices: [],
    syncPreventSleep() {},
    setOutputDeviceStatus(status, message) {
      calls.status.push([status, message]);
    },
  };
  const manager = createDeviceManager(state, engine, settingStore, {
    notifyOutputDeviceDisconnectPause: (message) => calls.notices.push(message),
  });
  return { state, calls, manager };
}

// Windows WASAPI reports an unplugged device this way when the switch is on.
const disconnectError = {
  message: 'failed to query WASAPI output padding: 0x88890004',
  errorCode: 'output-runtime',
  reason: 'device-not-available',
};

test('configured disconnect pause does not surface as a playback error', async () => {
  const { state, calls, manager } = fixture({ pauseOnDisconnect: true });
  assert.equal(await manager.handleOutputDeviceError(disconnectError), true);

  assert.equal(calls.pause, 1);
  assert.equal(state.playbackNotice, null);
  assert.equal(state.lastError, null);
  assert.equal(state.enginePlayback.status, 'paused');
  assert.equal(state.playbackIntent.shouldPlay, false);
  assert.deepEqual(calls.notices, ['输出设备已断开，已暂停播放。']);
  assert.deepEqual(calls.status, [['paused', '输出设备已断开，已暂停播放。']]);
});

test('disconnect with the switch off keeps the unavailable-device notice', async () => {
  const { state, calls, manager } = fixture({ pauseOnDisconnect: false });
  assert.equal(await manager.handleOutputDeviceError(disconnectError), true);

  assert.equal(calls.pause, 1);
  assert.equal(state.lastError, 'output-device-unavailable');
  assert.equal(state.playbackNotice?.code, 'output-device-unavailable');
  assert.deepEqual(calls.notices, []);
  assert.equal(calls.status[0][0], 'error');
});

test('recovery failure and exclusive errors still show the notice with the switch on', async () => {
  for (const error of [
    {
      message: 'audio output recovery failed: device gone',
      errorCode: 'output-runtime',
      reason: 'device-not-available',
    },
    {
      message: 'exclusive output unavailable',
      errorCode: 'output-exclusive',
      reason: 'device-not-available',
    },
  ]) {
    const { state, calls, manager } = fixture({ pauseOnDisconnect: true });
    assert.equal(await manager.handleOutputDeviceError(error), true);
    assert.equal(state.playbackNotice?.code, 'output-device-unavailable', error.message);
    assert.deepEqual(calls.notices, []);
  }
});
