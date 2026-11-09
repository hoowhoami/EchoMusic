import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

// settingsBackup.ts 使用无扩展名导入，需先打包再加载
const loadModule = (relativePath) => {
  const output = buildSync({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  }).outputFiles[0].text;
  const loaded = { exports: {} };
  new Function('module', 'exports', output)(loaded, loaded.exports);
  return loaded.exports;
};

const { DEFAULT_DEVTOOLS_DEBUG_PORT, normalizeDevToolsDebugPort, parseDevToolsDebugPort } =
  loadModule('../src/shared/devTools.ts');
const { sanitizePortableAppSettings } = loadModule('../src/shared/settingsBackup.ts');

test('合法端口原样保留，含数字字符串与边界值', () => {
  assert.equal(normalizeDevToolsDebugPort(9333), 9333);
  assert.equal(normalizeDevToolsDebugPort('9333'), 9333);
  assert.equal(normalizeDevToolsDebugPort(1024), 1024);
  assert.equal(normalizeDevToolsDebugPort(65535), 65535);
});

test('非法端口回退默认值', () => {
  for (const value of [
    undefined,
    null,
    '',
    ' ',
    'abc',
    NaN,
    Infinity,
    1023,
    65536,
    0,
    -1,
    9223.5,
    true,
    {},
    [],
  ]) {
    assert.equal(normalizeDevToolsDebugPort(value), DEFAULT_DEVTOOLS_DEBUG_PORT, String(value));
    assert.equal(parseDevToolsDebugPort(value), null, String(value));
  }
});

test('备份不携带开发者模式开关与调试端口', () => {
  const portable = sanitizePortableAppSettings({
    devToolsEnabled: true,
    devToolsDebugPort: 9333,
    keepAliveEnabled: true,
  });
  assert.equal(Object.hasOwn(portable, 'devToolsEnabled'), false);
  assert.equal(Object.hasOwn(portable, 'devToolsDebugPort'), false);
  assert.equal(portable.keepAliveEnabled, true);
});
