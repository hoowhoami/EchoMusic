import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

function setup() {
  let callback, args;
  const module = { exports: {} };
  const mocks = {
    electron: {
      app: { isPackaged: true },
      screen: { screenToDipRect: (_win, rect) => rect, getDisplayMatching: () => ({ id: 1 }) },
    },
    'node:child_process': {
      execFile: (_file, a, _opts, cb) => {
        args = a;
        callback = cb;
      },
    },
    'node:fs': { existsSync: () => true },
    'node:path': { join },
    './logger': { __esModule: true, default: { warn() {} } },
  };
  runInNewContext(
    transformSync(readFileSync(new URL('../src/main/taskbarShell.ts', import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
    {
      module,
      process: { platform: 'win32', resourcesPath: 'test' },
      require: (id) => {
        if (id in mocks) return mocks[id];
        throw new Error(id);
      },
    },
  );
  const handle = (value) => {
    const result = Buffer.alloc(8);
    result.writeBigUInt64LE(BigInt(value));
    return result;
  };
  return {
    api: module.exports,
    handle,
    args: () => args,
    finish: (state) =>
      callback(
        null,
        JSON.stringify([
          {
            bounds: { x: 0, y: 1000, width: 1920, height: 48 },
            reliable: true,
            occupied: [],
            ...state,
          },
        ]),
      ),
  };
}

test('native visibility false is preserved only for the actual queried HWND', async () => {
  const env = setup();
  env.api.setTaskbarProbeWindow(env.handle(77));
  const pending = env.api.refreshTaskbarShellLayout();
  assert.equal(env.args()[0], '77');
  env.finish({ playerVisible: false, shellAbovePlayer: true });
  await pending;
  assert.equal(env.api.getTaskbarShellLayout(1).playerVisible, false);
  assert.equal(env.api.getTaskbarShellLayout(1).shellAbovePlayer, true);
});

test('a late probe of a destroyed HWND cannot mark a new window hidden', async () => {
  const env = setup();
  env.api.setTaskbarProbeWindow(env.handle(77));
  const pending = env.api.refreshTaskbarShellLayout();
  env.api.setTaskbarProbeWindow(env.handle(88));
  env.finish({
    playerVisible: false,
    shellAbovePlayer: true,
    playerBounds: { x: 0, y: 0, width: 400, height: 48 },
  });
  await pending;
  const layout = env.api.getTaskbarShellLayout(1);
  assert.equal(layout.reliable, true, 'shell geometry remains useful');
  assert.equal(layout.playerVisible, undefined);
  assert.equal(layout.shellAbovePlayer, undefined);
  assert.equal(layout.playerBounds, undefined);
});

test('a probe before window creation or missing visibility fields remains unknown', async () => {
  for (const withHandle of [false, true]) {
    const env = setup();
    if (withHandle) env.api.setTaskbarProbeWindow(env.handle(77));
    const pending = env.api.refreshTaskbarShellLayout();
    env.finish(withHandle ? {} : { playerVisible: false });
    await pending;
    assert.equal(env.api.getTaskbarShellLayout(1).playerVisible, undefined);
  }
});
