import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const code = transformSync(
  readFileSync(new URL('../src/renderer/stores/player/listeningTime.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function fixture() {
  let now = 10000;
  let handlers;
  let identity;
  const timers = [];
  const events = [];
  const grades = [];
  const user = vue.reactive({
    isLoggedIn: true,
    info: { userid: 1, token: 'A' },
    accountRevision: 0,
  });
  const report = { dSec: 0, pendingDiff: 0, lastReportAt: 0 };
  const state = {
    currentTrackSnapshot: { mixSongId: 1 },
    currentTrackId: 'track',
    currentResolvedSourceKind: 'catalog',
    currentTime: 0,
    seekTargetTime: null,
  };
  const mod = { exports: {} };
  const deps = {
    vue,
    '@/api/user': {
      reportListeningEvent: async (event) => {
        events.push(event);
        return { status: 1 };
      },
      getUserGradeInfo: async () => ({ status: 1, data: { d_sec: 0 } }),
      reportGradeProgress: (event) => {
        let reject, resolve;
        const promise = new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
        grades.push({ ...event, reject, resolve });
        return promise;
      },
    },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/listenReport': { useListenReportStore: () => report },
    '@/utils/logger': { info() {}, warn() {} },
    '../../../shared/listeningSession': {
      createListeningSession(options) {
        handlers = options;
        return {
          tick(id) {
            identity = id;
          },
          flush: async () => {},
          resetPosition() {},
        };
      },
    },
    './stateMachine': { getPlaybackIsPlaying: () => true, getPlaybackIsLoading: () => false },
  };
  new Function('require', 'module', 'exports', 'Date', 'setTimeout', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    mod,
    mod.exports,
    class extends Date {
      static now() {
        return now;
      }
    },
    (fn) => {
      timers.push(fn);
    },
  );
  const scope = vue.effectScope();
  const manager = scope.run(() => mod.exports.createListeningTimeManager(state));
  manager.tick();
  return {
    user,
    get identity() {
      return identity;
    },
    report,
    events,
    grades,
    handlers,
    manager,
    timers,
    advance(ms) {
      now += ms;
    },
    dispose() {
      scope.stop();
    },
  };
}
for (const type of ['start', 'end']) {
  test(`a delayed CSCC ${type} rechecks login before sending`, async () => {
    const s = fixture();
    const id = s.identity;
    await s.handlers.start(id);
    s.advance(100);
    const pending = s.handlers[type](id, 1000, '中断播放');
    await flush();
    assert.equal(s.timers.length, 1);
    s.user.isLoggedIn = false;
    s.timers.shift()();
    await pending;
    assert.equal(s.events.length, 1);
    s.dispose();
  });
}
test('an uncertain grade response from the old account cannot consume new listening time', async () => {
  const s = fixture();
  s.handlers.onAccumulate(60000);
  s.advance(60000);
  s.manager.tick();
  await flush();
  assert.equal(s.grades.length, 1);
  s.user.info = { userid: 2, token: 'B' };
  s.user.accountRevision++;
  s.handlers.onAccumulate(60000);
  s.grades[0].reject(new Error('old account network error'));
  await flush();
  s.advance(60000);
  s.manager.tick();
  await flush();
  assert.equal(s.grades.length, 2, 'new account retains its full minute');
  s.grades[1].resolve({ status: 1 });
  await flush();
  assert.equal(s.report.dSec, 60);
  s.dispose();
});
test('logout and login with identical credentials still invalidates old listening work', async () => {
  const s = fixture();
  const id = s.identity;
  s.user.accountRevision += 2;
  assert.equal(await s.handlers.start(id), false);
  assert.equal(s.events.length, 0);
  s.dispose();
});
