import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { transformSync } from 'esbuild';
const code = transformSync(
  readFileSync(new URL('../src/main/native/platform.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
function setup({ platform = 'win32', packaged = false, valid = true } = {}) {
  const module = { exports: {} },
    paths = [],
    warnings = [];
  const api = Object.fromEntries(
    [
      'setWindowComposition',
      'taskbarEnableIconic',
      'taskbarDisableIconic',
      'taskbarInvalidate',
      'taskbarSetThumbnail',
      'taskbarSetLivePreview',
    ].map((name) => [name, () => {}]),
  );
  runInNewContext(code, {
    module,
    __dirname: '/app/dist-electron/main',
    process: { platform, cwd: () => '/app', resourcesPath: '/app/resources' },
    require(name) {
      if (name === 'electron') return { app: { isPackaged: packaged } };
      if (name === 'node:path') return path;
      if (name === 'node:module')
        return {
          createRequire: () => (file) => {
            paths.push(file);
            return valid ? api : {};
          },
        };
      if (name === '../logger') return { warn: (...args) => warnings.push(args) };
      throw Error(name);
    },
  });
  return { get: module.exports.getNativePlatform, paths, warnings, api };
}
test('platform addon is shared by composition and taskbar with one validated load', () => {
  const e = setup();
  assert.equal(e.get(), e.api);
  assert.equal(e.get(), e.api);
  assert.deepEqual(e.paths, ['/app/native/echo-platform-adaptor/echo-platform-adaptor.node']);
});
test('packaged loading uses the Windows extraResources destination', () => {
  const e = setup({ packaged: true });
  e.get();
  assert.deepEqual(e.paths, ['/app/resources/native/echo-platform-adaptor.node']);
});
test('missing ABI surface degrades once and non-Windows never loads the DLL', () => {
  const e = setup({ valid: false });
  assert.equal(e.get(), null);
  assert.equal(e.get(), null);
  assert.equal(e.warnings.length, 1);
  const mac = setup({ platform: 'darwin' });
  assert.equal(mac.get(), null);
  assert.equal(mac.paths.length, 0);
});
