import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as updateErrors from '../src/shared/updateError.ts';

const source = readFileSync(
  process.env.ECHOMUSIC_UPDATE_TEST_SOURCE ||
    new URL('../src/renderer/stores/update.ts', import.meta.url),
  'utf8',
);
const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
const available = (version = '2.4.0', extra = {}) => ({
  status: 'available',
  currentVersion: '2.3.2',
  latestVersion: version,
  body: 'snapshot notes',
  notesStatus: 'loading',
  ...extra,
});
const progress = (percent) => ({
  status: 'downloading',
  progress: { percent, bytesPerSecond: 10, transferred: percent, total: 100 },
});

function setup(t, { platform = 'win32', install } = {}) {
  const original = globalThis.window;
  const pending = [];
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.push(resolve);
    return { promise, resolve, reject };
  };
  const states = [];
  const installs = [];
  const listeners = new Map();
  const downloadListeners = new Set();
  const calls = [];
  const settings = {
    appVersion: '2.3.2',
    silentUpdate: true,
    checkForUpdates: (silent) => calls.push(['check', silent]),
  };
  globalThis.window = {
    electron: {
      platform,
      ipcRenderer: {
        on(name, listener) {
          const current = listeners.get(name) || new Set();
          current.add(listener);
          listeners.set(name, current);
        },
        off(name, listener) {
          listeners.get(name)?.delete(listener);
        },
        send: (...args) => calls.push(args),
      },
      updater: {
        getState() {
          const state = deferred();
          states.push(state);
          return state.promise;
        },
        onDownloadStatus(listener) {
          downloadListeners.add(listener);
          return () => downloadListeners.delete(listener);
        },
        download: () => calls.push(['download']),
        cancelDownload: () => calls.push(['cancel']),
        install(silent) {
          calls.push(['install', silent]);
          if (install) return install(silent);
          const request = deferred();
          installs.push(request);
          return request.promise;
        },
      },
    },
  };
  const module = { exports: {} };
  const imports = {
    pinia,
    './setting': { useSettingStore: () => settings },
    '../../shared/updateError': updateErrors,
  };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      assert.ok(id in imports, `unexpected import: ${id}`);
      return imports[id];
    },
    module,
    module.exports,
  );
  const store = module.exports.useUpdateStore(pinia.createPinia());
  t.after(() => {
    store.dispose();
    pending.forEach((resolve) => resolve());
    globalThis.window = original;
  });
  const emit = (name, value) =>
    [...(listeners.get(name) || [])].forEach((listener) => listener(value));
  const emitDownload = (value) => [...downloadListeners].forEach((listener) => listener(value));
  const init = async (state = { checkResult: available(), download: { status: 'idle' } }) => {
    const promise = store.init();
    states.at(-1).resolve(state);
    await promise;
  };
  return {
    store,
    states,
    installs,
    listeners,
    downloadListeners,
    calls,
    deferred,
    emit,
    emitDownload,
    init,
    settings,
  };
}

test('state recovery restores both fields without reopening the dialog', async (t) => {
  const h = setup(t);
  await h.init({ checkResult: available(), download: progress(31.6) });
  assert.equal(h.store.checkResult.latestVersion, '2.4.0');
  assert.equal(h.store.downloadStatus, 'downloading');
  assert.equal(h.store.downloadPercent, 32);
  assert.equal(h.store.dialogOpen, false);
});

for (const event of [
  available('2.5.0'),
  { status: 'latest', currentVersion: '2.3.2', silent: true },
  { status: 'error', currentVersion: '2.3.2', message: 'offline' },
]) {
  test(`live ${event.status} check supersedes only the check snapshot`, async (t) => {
    const h = setup(t);
    const pending = h.store.init();
    h.emit('update-check-result', event);
    h.states[0].resolve({ checkResult: available(), download: progress(28) });
    await pending;
    assert.deepEqual({ ...h.store.checkResult }, event);
    assert.equal(h.store.downloadPercent, 28);
  });
}

for (const event of [
  progress(73),
  { status: 'downloaded' },
  { status: 'error', error: 'new error' },
  { status: 'idle' },
]) {
  test(`live ${event.status} download supersedes only the download snapshot`, async (t) => {
    const h = setup(t);
    const pending = h.store.init();
    h.emitDownload(event);
    h.states[0].resolve({ checkResult: available(), download: progress(10) });
    await pending;
    assert.equal(h.store.downloadStatus, event.status);
    assert.equal(h.store.downloadError, event.error || '');
    assert.equal(h.store.checkResult.latestVersion, '2.4.0');
    if (event.progress) assert.equal(h.store.downloadPercent, 73);
  });
}

test('release notes received during state recovery are retained without reopening', async (t) => {
  const h = setup(t);
  h.store.handleCheckResult(available());
  h.store.closeDialog();
  const pending = h.store.init();
  h.emit('update-release-notes', available('2.4.0', { body: 'live notes', notesStatus: 'ready' }));
  h.states[0].resolve({ checkResult: available(), download: { status: 'idle' } });
  await pending;
  assert.equal(h.store.checkResult.body, 'live notes');
  assert.equal(h.store.checkResult.notesStatus, 'ready');
  assert.equal(h.store.dialogOpen, false);
});

test('unrelated release notes do not prevent recovering a newer check', async (t) => {
  const h = setup(t);
  h.store.handleCheckResult(available());
  const pending = h.store.init();
  h.emit('update-release-notes', available('2.2.0', { body: 'irrelevant' }));
  h.states[0].resolve({ checkResult: available('2.5.0'), download: { status: 'idle' } });
  await pending;
  assert.equal(h.store.checkResult.latestVersion, '2.5.0');
});

test('disposing invalidates the pending state read', async (t) => {
  const h = setup(t);
  const pending = h.store.init();
  h.store.dispose();
  h.states[0].resolve({ checkResult: available(), download: progress(20) });
  await pending;
  assert.equal(h.store.checkResult, null);
  assert.equal(h.store.downloadStatus, 'idle');
});

test('old state read cannot overwrite a reinitialized instance', async (t) => {
  const h = setup(t);
  const old = h.store.init();
  h.store.dispose();
  const next = h.store.init();
  h.states[1].resolve({ checkResult: available('2.5.0'), download: progress(70) });
  await next;
  h.states[0].resolve({ checkResult: available(), download: progress(10) });
  await old;
  assert.equal(h.store.checkResult.latestVersion, '2.5.0');
  assert.equal(h.store.downloadPercent, 70);
});

for (const reinit of [false, true]) {
  for (const channel of ['update-check-result', 'update-release-notes', 'download']) {
    test(`queued ${channel} callback cannot affect ${reinit ? 'a new initialization' : 'a disposed store'}`, async (t) => {
      const h = setup(t);
      await h.init();
      const old =
        channel === 'download' ? [...h.downloadListeners][0] : [...h.listeners.get(channel)][0];
      h.store.dispose();
      if (reinit) await h.init({ checkResult: available('2.5.0'), download: progress(50) });
      const before = JSON.stringify({
        check: h.store.checkResult,
        status: h.store.downloadStatus,
        percent: h.store.downloadPercent,
        open: h.store.dialogOpen,
      });
      old(
        channel === 'download'
          ? progress(99)
          : available(reinit ? '2.5.0' : '2.4.0', { body: 'stale' }),
      );
      assert.equal(
        JSON.stringify({
          check: h.store.checkResult,
          status: h.store.downloadStatus,
          percent: h.store.downloadPercent,
          open: h.store.dialogOpen,
        }),
        before,
      );
    });
  }
}

test('initialization is idempotent and removes exactly its listeners', async (t) => {
  const h = setup(t);
  const other = () => {};
  window.electron.ipcRenderer.on('update-check-result', other);
  const pending = h.store.init();
  await h.store.init();
  assert.equal(h.states.length, 1);
  assert.equal(h.listeners.get('update-check-result').size, 2);
  assert.equal(h.downloadListeners.size, 1);
  h.states[0].resolve();
  await pending;
  h.store.dispose();
  assert.deepEqual([...h.listeners.get('update-check-result')], [other]);
  assert.equal(h.downloadListeners.size, 0);
  await h.init();
  assert.equal(h.listeners.get('update-check-result').size, 2);
});

test('unavailable initial state does not prevent subsequent live events', async (t) => {
  const h = setup(t);
  const pending = h.store.init();
  h.states[0].reject(new Error('IPC unavailable'));
  await pending;
  h.emit('update-check-result', available('2.5.0'));
  h.emitDownload(progress(80));
  assert.equal(h.store.checkResult.latestVersion, '2.5.0');
  assert.equal(h.store.downloadPercent, 80);
});

for (const action of ['download', 'cancel', 'install']) {
  test(`local ${action} state is not reverted by initialization snapshot`, async (t) => {
    const h = setup(t);
    const pending = h.store.init();
    let installation;
    if (action === 'download') h.store.download();
    if (action === 'cancel') {
      h.store.applyDownloadStatus(progress(10));
      h.store.cancelDownload();
    }
    if (action === 'install') {
      h.store.applyDownloadStatus({ status: 'downloaded' });
      installation = h.store.install();
    }
    h.states[0].resolve({
      checkResult: available(),
      download: action === 'cancel' ? progress(20) : { status: 'idle' },
    });
    await pending;
    assert.equal(
      h.store.downloadStatus,
      { download: 'downloading', cancel: 'idle', install: 'installing' }[action],
    );
    if (installation) {
      h.installs[0].resolve({ ok: true });
      await installation;
    }
  });
}

test('download completion always displays the complete progress bar', async (t) => {
  const h = setup(t);
  h.store.applyDownloadStatus(progress(93));
  h.store.applyDownloadStatus({ status: 'downloaded' });
  assert.equal(h.store.downloadPercent, 100);
});

test('restored downloaded state displays complete progress', async (t) => {
  const h = setup(t);
  await h.init({ checkResult: available(), download: { status: 'downloaded' } });
  assert.equal(h.store.downloadPercent, 100);
});

for (const fail of ['reject', 'throw', 'missing', 'empty', 'false']) {
  test(`installation ${fail} becomes a recoverable error without a rejected UI promise`, async (t) => {
    const h = setup(
      t,
      fail === 'throw'
        ? {
            install: () => {
              throw new Error('sync IPC failure');
            },
          }
        : {},
    );
    if (fail === 'missing') delete window.electron.updater;
    h.store.applyDownloadStatus({ status: 'downloaded' });
    const pending = h.store.install();
    if (fail === 'reject') h.installs[0].reject(new Error('IPC failed'));
    if (fail === 'empty') h.installs[0].resolve();
    if (fail === 'false') h.installs[0].resolve({ ok: false, error: 'installer unavailable' });
    await assert.doesNotReject(pending);
    assert.equal(h.store.downloadStatus, 'error');
    assert.ok(h.store.downloadError);
  });
}

test('installing acknowledgement does not hide a failed invoke response', async (t) => {
  const h = setup(t);
  await h.init({ checkResult: available(), download: { status: 'downloaded' } });
  const pending = h.store.install();
  h.emitDownload({ status: 'installing' });
  h.installs[0].resolve({ ok: false, error: 'failed to launch' });
  await pending;
  assert.equal(h.store.downloadStatus, 'error');
  assert.equal(h.store.downloadError, 'failed to launch');
});

for (const event of [
  { status: 'error', error: 'authoritative main failure' },
  { status: 'idle' },
  progress(25),
  { status: 'downloaded' },
]) {
  for (const reject of [false, true]) {
    test(`late installation ${reject ? 'rejection' : 'failure'} cannot overwrite ${event.status} event`, async (t) => {
      const h = setup(t);
      h.store.applyDownloadStatus({ status: 'downloaded' });
      const pending = h.store.install();
      h.store.applyDownloadStatus(event);
      if (reject) h.installs[0].reject(new Error('old invoke failure'));
      else h.installs[0].resolve({ ok: false, error: 'old invoke failure' });
      await assert.doesNotReject(pending);
      assert.equal(h.store.downloadStatus, event.status);
      assert.equal(h.store.downloadError, event.error || '');
    });
  }
}

for (const reinit of [false, true]) {
  test(`disposing ${reinit ? 'and reinitializing ' : ''}invalidates installation failure`, async (t) => {
    const h = setup(t);
    await h.init({ checkResult: available(), download: { status: 'downloaded' } });
    const old = h.store.install();
    h.store.dispose();
    if (reinit)
      await h.init({ checkResult: available('2.5.0'), download: { status: 'downloaded' } });
    h.installs[0].resolve({ ok: false, error: 'old install' });
    await old;
    assert.equal(h.store.downloadStatus, reinit ? 'downloaded' : 'installing');
    assert.equal(h.store.downloadError, '');
  });
}

test('old installation cannot fail a subsequent installation', async (t) => {
  const h = setup(t);
  h.store.applyDownloadStatus({ status: 'downloaded' });
  const old = h.store.install();
  h.store.applyDownloadStatus({ status: 'downloaded' });
  const next = h.store.install();
  h.installs[0].resolve({ ok: false, error: 'old failure' });
  await old;
  assert.equal(h.store.downloadStatus, 'installing');
  h.installs[1].resolve({ ok: true });
  await next;
  assert.equal(h.store.downloadError, '');
});

test('install uses the silent setting and prevents duplicate invocations', async (t) => {
  const h = setup(t);
  h.store.applyDownloadStatus({ status: 'downloaded' });
  const pending = h.store.install();
  await h.store.install();
  assert.deepEqual(h.calls, [['install', true]]);
  h.installs[0].resolve({ ok: true });
  await pending;
  assert.equal(h.store.downloadStatus, 'installing');
});

test('normal check, silent checks and dialog hiding retain their behavior', async (t) => {
  const h = setup(t);
  h.store.check();
  assert.equal(h.store.isChecking, true);
  h.store.handleCheckResult(available('2.4.0', { silent: true }));
  assert.equal(h.store.isChecking, false);
  assert.equal(h.store.dialogOpen, true);
  h.store.closeDialog();
  h.store.handleCheckResult({ status: 'latest', currentVersion: '2.3.2', silent: true });
  assert.equal(h.store.dialogOpen, false);
  h.store.check(true);
  assert.equal(h.store.isChecking, false);
  h.store.handleCheckResult({ status: 'latest', currentVersion: '2.3.2', silent: false });
  assert.equal(h.store.dialogOpen, true);
  h.store.applyDownloadStatus(progress(50));
  h.store.closeDialog();
  assert.equal(h.store.downloadStatus, 'downloading');
  assert.deepEqual(h.calls, [
    ['check', false],
    ['check', true],
  ]);
});

test('disposing releases a manual check busy flag', async (t) => {
  const h = setup(t);
  await h.init();
  h.store.check();
  h.store.dispose();
  assert.equal(h.store.isChecking, false);
});

for (const failure of ['check', 'download', 'install']) {
  test(`macOS ${failure} signature failure still offers manual download`, async (t) => {
    const h = setup(t, { platform: 'darwin' });
    const error = 'Code signature at URL file:///test.app did not pass validation';
    if (failure === 'check') {
      await h.init({ checkResult: available('2.4.0', { message: error }), download: progress(80) });
    } else if (failure === 'download') {
      await h.init({ checkResult: available(), download: { status: 'error', error } });
    } else {
      await h.init({ checkResult: available(), download: { status: 'downloaded' } });
      const pending = h.store.install();
      h.installs[0].reject(new Error(error));
      await assert.doesNotReject(pending);
    }
    assert.equal(h.store.checkResult.manualDownload, true);
    assert.equal(h.store.downloadStatus, 'idle');
    assert.equal(h.store.downloadPercent, 0);
    h.store.download();
    await h.store.install();
    assert.ok(h.calls.filter(([channel]) => channel === 'open-external').length === 2);
    assert.equal(
      h.calls.some(([channel]) => channel === 'download'),
      false,
    );
  });
}

test('Windows signature text remains an ordinary installation error', async (t) => {
  const h = setup(t);
  h.store.applyDownloadStatus({ status: 'downloaded' });
  const pending = h.store.install();
  h.installs[0].reject(new Error('Code signature at URL file:///test.app did not pass validation'));
  await assert.doesNotReject(pending);
  assert.equal(h.store.downloadStatus, 'error');
  assert.equal(h.store.checkResult?.manualDownload, undefined);
});
