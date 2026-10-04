import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const code = transformSync(readFileSync('src/main/powerMonitor.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;

function fixture(
  t,
  { recoverNetwork, controller = true, platform = 'darwin', playing = true } = {},
) {
  const events = [];
  const power = new EventEmitter();
  const mod = { exports: {} };
  const mocks = {
    electron: { powerMonitor: power },
    './window': { setSystemSuspended: (value) => events.push(['suspended', value]) },
    './logger': Object.fromEntries(
      ['info', 'warn', 'debug', 'error'].map((name) => [name, () => {}]),
    ),
  };
  new Function('require', 'module', 'exports', 'process', code)(
    (id) => mocks[id],
    mod,
    mod.exports,
    { platform },
  );
  const player = controller
    ? {
        available: true,
        currentState: { playing, audioDevice: 'auto', exclusiveOutput: false },
        async pause() {
          events.push(['pause']);
          this.currentState.playing = false;
        },
        async setAudioOutput(...args) {
          events.push(['output', ...args]);
        },
        async play() {
          events.push(['play']);
          this.currentState.playing = true;
        },
      }
    : null;
  const dispose = mod.exports.initPowerMonitor({
    getMainWindow: () => ({ webContents: { send: (name) => events.push(['send', name]) } }),
    getController: () => player,
    recoverNetwork: recoverNetwork
      ? () => {
          events.push(['network']);
          return recoverNetwork();
        }
      : undefined,
  });
  t.after(dispose);
  return { power, events, dispose };
}

test('wake completes network reset before audio and playback; duplicate wake signals coalesce', async (t) => {
  const pending = deferred();
  const s = fixture(t, { recoverNetwork: () => pending.promise });
  s.power.emit('suspend');
  s.power.emit('resume');
  s.power.emit('resume');
  await turn();
  assert.equal(s.events.filter(([name]) => name === 'network').length, 1);
  assert.ok(!s.events.some(([name]) => name === 'output'));
  pending.resolve();
  await turn();
  assert.deepEqual(s.events.slice(-3), [
    ['output', 'auto', false],
    ['play'],
    ['send', 'power:resume'],
  ]);
  s.power.emit('resume');
  await turn();
  assert.equal(s.events.filter(([name]) => name === 'network').length, 1);
});

test('network failure does not prevent audio recovery', async (t) => {
  const s = fixture(t, {
    recoverNetwork: async () => {
      throw new Error('reset failed');
    },
  });
  s.power.emit('suspend');
  s.power.emit('resume');
  await turn();
  assert.ok(s.events.some(([name]) => name === 'output'));
  assert.ok(s.events.some(([name]) => name === 'play'));
});

test('without a network callback the existing audio recovery starts immediately', async (t) => {
  const s = fixture(t);
  s.power.emit('suspend');
  s.power.emit('resume');
  assert.ok(s.events.some(([name]) => name === 'output'));
  await turn();
  assert.ok(s.events.some(([name]) => name === 'play'));
});

test('wake resets the network even without an available player', async (t) => {
  const s = fixture(t, { recoverNetwork: async () => {}, controller: false });
  s.power.emit('resume');
  await turn();
  assert.equal(s.events.filter(([name]) => name === 'network').length, 1);
});

test('disposing during network reset prevents later audio and renderer work', async (t) => {
  const pending = deferred();
  const s = fixture(t, { recoverNetwork: () => pending.promise });
  s.power.emit('resume');
  await turn();
  s.dispose();
  pending.resolve();
  await turn();
  assert.ok(!s.events.some(([name]) => ['output', 'play', 'send'].includes(name)));
  assert.equal(s.power.listenerCount('resume'), 0);
});

test('disposing before queued recovery starts prevents a network reset', async (t) => {
  const s = fixture(t, { recoverNetwork: async () => {} });
  s.power.emit('resume');
  s.dispose();
  await turn();
  assert.ok(!s.events.some(([name]) => ['network', 'output', 'send'].includes(name)));
});

test('another paired sleep during recovery performs a fresh network reset for the next wake', async (t) => {
  const pending = deferred();
  let calls = 0;
  const s = fixture(t, {
    recoverNetwork: () => (++calls === 1 ? pending.promise : Promise.resolve()),
  });
  s.power.emit('suspend');
  s.power.emit('resume');
  await turn();
  s.power.emit('suspend');
  s.power.emit('resume');
  pending.resolve();
  await turn();
  assert.equal(calls, 2);
});

test('Windows normal unlock skips recovery; unlock after suspend follows wake recovery', async (t) => {
  const s = fixture(t, { recoverNetwork: async () => {}, platform: 'win32', playing: false });
  s.power.emit('unlock-screen');
  await turn();
  assert.deepEqual(s.events, []);
  s.power.emit('suspend');
  s.power.emit('unlock-screen');
  await turn();
  assert.ok(s.events.some(([name]) => name === 'network'));
  assert.ok(s.events.some(([name]) => name === 'output'));
  assert.ok(!s.events.some(([name]) => name === 'play'));
});
