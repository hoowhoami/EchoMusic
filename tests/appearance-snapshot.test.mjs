import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
function load(file, mocks) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    if (!(id in mocks)) throw new Error('Unexpected dependency: ' + id);
    return mocks[id];
  });
  return module.exports;
}
const api = load('../src/main/nowPlaying.ts', {
  electron: { BrowserWindow: { getAllWindows: () => [] } },
  './ipc/registry': {},
  './window': {},
  './storage/settings': {},
  '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
  '../shared/playback': load('../src/shared/playback.ts', {}),
  '../shared/opencc': load('../src/shared/opencc.ts', {}),
  './taskbarThumbnail': { isCoverPreviewEnabled: () => false, setTaskbarCardPlayback() {} },
  './taskbarProgress': {},
  './thumbar': { updateThumbarPlayback() {} },
});
test('main appearance snapshot retains theme surfaces and frosted floats across IPC sanitization', () => {
  const appearance = {
    isDark: true,
    accentColor: '#8d9deb',
    fontFamily: 'Test',
    floatingSurfaceFrosted: true,
    colors: {
      '--surface-main-base': '#1b2230',
      '--surface-dialog-base': '#2a3446',
      '--text-main': '#ffe3a3',
      '--floating-text-main': '#f3f5fb',
      '--floating-text-secondary': '#b8bfcb',
      '--floating-card-base': '#343943',
      '--floating-border': '#676767',
      '--floating-tone': '#ffffff',
      '--content-tone': '#000000',
      '--floating-accent-text': '#187db3',
    },
  };
  const snapshot = api.syncNowPlayingSnapshot({ appearance });
  assert.deepEqual(snapshot.appearance, appearance);
  const unchanged = api.syncNowPlayingSnapshot({ playback: null });
  assert.deepEqual(unchanged.appearance, appearance);
});
test('appearance color snapshot accepts semantic hex tokens only', () => {
  const snapshot = api.syncNowPlayingSnapshot({
    appearance: {
      isDark: false,
      accentColor: '#0071e3',
      colors: {
        '--surface-main-base': '#ffffff',
        '--surface-card-base': 'url(file:///bad)',
        '--unrelated': '#123456',
      },
    },
  });
  assert.deepEqual(snapshot.appearance.colors, { '--surface-main-base': '#ffffff' });
  assert.equal(snapshot.appearance.floatingSurfaceFrosted, false);
});
