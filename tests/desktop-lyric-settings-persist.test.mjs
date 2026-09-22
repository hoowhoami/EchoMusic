import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// In-memory stand-in for the native KV store so the main-process settings layer runs headless.
const kv = new Map();
const harness = {
  native: {
    kvGet: (key) => kv.get(key) ?? null,
    kvSet: (key, valueJson) => kv.set(key, valueJson),
    kvDelete: (key) => kv.delete(key),
    kvApplyBatch: () => {},
  },
};

const bundle = await build({
  stdin: {
    contents: `export * from './src/main/desktopLyric/store'; export { DEFAULT_DESKTOP_LYRIC_SETTINGS } from './src/shared/desktopLyric';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'fixture',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture',
        }));
        builder.onResolve({ filter: /storage\/native$|^\.\/native$/ }, () => ({
          path: 'native',
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: {
            electron: `export const screen = {}; export const app = {};`,
            native: `export const getNativeStorage = () => harness.native;`,
          }[args.path],
        }));
      },
    },
  ],
});

const module = { exports: {} };
new Function('require', 'module', 'exports', 'harness', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
  harness,
);
const { persistDesktopLyricSettings, getDesktopLyricSettings, DEFAULT_DESKTOP_LYRIC_SETTINGS } =
  module.exports;

test('desktop lyric ruby romanization style survives a restart', () => {
  kv.clear();
  persistDesktopLyricSettings({ ...DEFAULT_DESKTOP_LYRIC_SETTINGS, showRomanizationAsRuby: true });
  assert.equal(getDesktopLyricSettings().showRomanizationAsRuby, true);
});

// filterEnabled/filterPattern are owned by the renderer settingStore and synced in, not persisted here.
const RENDERER_OWNED = new Set(['filterEnabled', 'filterPattern']);

test('every boolean desktop lyric setting round-trips through persistence', () => {
  for (const [key, value] of Object.entries(DEFAULT_DESKTOP_LYRIC_SETTINGS)) {
    if (typeof value !== 'boolean' || RENDERER_OWNED.has(key)) continue;
    kv.clear();
    persistDesktopLyricSettings({ ...DEFAULT_DESKTOP_LYRIC_SETTINGS, [key]: !value });
    assert.equal(getDesktopLyricSettings()[key], !value, `${key} was not persisted`);
  }
});
