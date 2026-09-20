import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const script = new URL('../scripts/build-taskbar-layout.mjs', import.meta.url);
const code = transformSync(readFileSync(script, 'utf8'), {
  format: 'cjs',
  define: { 'import.meta.url': JSON.stringify(script.href) },
}).code;

function build({
  platform = 'win32',
  compiler = true,
  directory = 'missing',
  status = 0,
  spawnError,
} = {}) {
  let state = directory;
  let spawned = 0;
  const removed = [];
  const process = { platform, env: {}, exitCode: undefined };
  const mocks = {
    'node:path': path,
    'node:url': { fileURLToPath },
    'node:fs': {
      existsSync: () => compiler,
      mkdirSync: () => {
        if (state === 'missing') state = 'empty';
      },
      rmdirSync: (target) => {
        removed.push(target);
        if (state === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        if (state === 'populated')
          throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
        state = 'missing';
      },
    },
    'node:child_process': {
      spawnSync: (_compiler, args, options) => {
        spawned++;
        assert.equal(options.windowsHide, true);
        assert.ok(args.some((arg) => arg.endsWith('EchoMusic.TaskbarLayout.exe')));
        if (!spawnError && status === 0) state = 'populated';
        return { status, error: spawnError };
      },
    },
  };
  let error;
  try {
    runInNewContext(code, {
      process,
      URL,
      require: (id) => {
        if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
        return mocks[id];
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(removed, [fileURLToPath(new URL('../build/taskbar-layout', import.meta.url))]);
  return { state, spawned, exitCode: process.exitCode, error };
}

test('successful Windows compilation retains the helper for packaging', () => {
  const result = build();
  assert.equal(result.error, undefined);
  assert.equal(result.spawned, 1);
  assert.equal(result.state, 'populated');
  assert.equal(result.exitCode, undefined);
});

test('failed compilation cleans only the empty directory and preserves the exit status', () => {
  for (const directory of ['missing', 'populated']) {
    const result = build({ status: 2, directory });
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state, directory);
  }
});

test('spawn errors clean the empty directory and remain observable', () => {
  const spawnError = new Error('compiler failed to start');
  const result = build({ spawnError });
  assert.equal(result.error, spawnError);
  assert.equal(result.state, 'missing');
});

test('missing Framework compiler has an actionable error without invoking compilation', () => {
  const result = build({ compiler: false });
  assert.match(result.error.message, /csc\.exe not found: .*v4\.0\.30319/);
  assert.equal(result.spawned, 0);
  assert.equal(result.state, 'missing');
});

test('non-Windows skips compilation and removes only empty output directories', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const directory of ['missing', 'empty', 'populated']) {
      const result = build({ platform, directory });
      assert.equal(result.error, undefined);
      assert.equal(result.spawned, 0);
      assert.equal(result.state, directory === 'empty' ? 'missing' : directory);
    }
  }
});
