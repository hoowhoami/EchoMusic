import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// Compile the IPC registration with stubbed dependencies. No system command is run.
const source = readFileSync(new URL('../src/main/ipc/window.ts', import.meta.url), 'utf8');
const start = source.indexOf("  ipcRegistry.registerHandler(\n    'sleep-timer:execute-action'");
const end = source.indexOf('  // Subscribe once', start);
assert.ok(start >= 0 && end > start);
const code = transformSync(source.slice(start, end), { loader: 'ts' }).code;

function setup(fail = false) {
  let handler;
  const calls = [];
  const mainFrame = {};
  const webContents = { mainFrame };
  new Function(
    'ipcRegistry',
    'getMainWindow',
    'requestSystemShutdown',
    'quitApplication',
    'setImmediate',
    code,
  )(
    {
      registerHandler: (_channel, callback) => {
        handler = callback;
      },
    },
    () => ({ webContents }),
    async () => {
      calls.push('shutdown');
      if (fail) throw new Error('permission denied');
    },
    () => calls.push('quit'),
    (callback) => callback(),
  );
  return { handler, calls, event: { sender: webContents, senderFrame: mainFrame } };
}

test('trusted main frame dispatches quit and shutdown independently', async () => {
  for (const action of ['quit', 'shutdown']) {
    const t = setup();
    assert.deepEqual(await t.handler(t.event, action), { ok: true });
    assert.deepEqual(t.calls, [action]);
  }
});

test('other windows, subframes and arbitrary actions cannot execute system operations', async () => {
  const t = setup();
  assert.equal((await t.handler({ ...t.event, sender: {} }, 'shutdown')).ok, false);
  assert.equal((await t.handler({ ...t.event, senderFrame: {} }, 'shutdown')).ok, false);
  assert.equal((await t.handler(t.event, 'shutdown; reboot')).ok, false);
  assert.deepEqual(t.calls, []);
});

test('system rejection is returned as a visible failure, without quitting the app', async () => {
  const t = setup(true);
  const result = await t.handler(t.event, 'shutdown');
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);
  assert.deepEqual(t.calls, ['shutdown']);
});

test('shutdown command mappings use normal system requests without force or shell interpolation', async () => {
  const { getShutdownCommand } = await import('../src/main/systemShutdown.ts');
  assert.deepEqual(getShutdownCommand('darwin'), {
    file: '/usr/bin/osascript',
    args: ['-e', 'tell application "System Events" to shut down'],
  });
  assert.deepEqual(getShutdownCommand('win32'), { file: 'shutdown.exe', args: ['/s', '/t', '0'] });
  assert.deepEqual(getShutdownCommand('linux'), { file: '/usr/bin/systemctl', args: ['poweroff'] });
  assert.throws(() => getShutdownCommand('unknown'), /不支持/);
});
