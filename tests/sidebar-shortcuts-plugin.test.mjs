import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const exportsByModule = {
  './titlebar': ['createTitlebarApi', 'removeTitlebarItemsByPlugin'],
  './playerbar': ['createPlayerbarApi', 'removePlayerbarItemsByPlugin'],
  './lyricsPage': ['createLyricsPageApi', 'removeLyricsPagesByPlugin'],
  '@/components/music/songContextMenuExtensions': ['registerSongContextMenuExtension'],
  './coverFallback': ['registerCoverFallbackResolver', 'removeCoverFallbackResolversByPlugin'],
  './audioSource': ['removeAudioSourceResolversByPlugin'],
  './lyrics': ['removeLyricResolversByPlugin'],
  './lyricEffects': ['removeLyricEffectsByPlugin'],
};
const result = await build({
  stdin: {
    contents: `export * from './src/renderer/plugins/registry';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'unrelated-contributions',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.importer.endsWith('/plugins/registry.ts') && exportsByModule[args.path]
            ? { path: args.path, namespace: 'stub' }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: exportsByModule[args.path]
            .map((name) => `export const ${name}=()=>({});`)
            .join('\n'),
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const api = module.exports;
const disposers = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  api.removePluginContributions('first');
  api.removePluginContributions('second');
});
function ui(id = 'first') {
  return api.createPluginUiApi(id, (d) => disposers.push(d));
}
test('candidate registration never auto-adds a lower menu and plugin IDs isolate equal card IDs', () => {
  ui().sidebar.shortcuts.register({ id: 'same', title: 'First', onClick() {} });
  ui('second').sidebar.shortcuts.register({ id: 'same', title: 'Second', onClick() {} });
  assert.equal(api.pluginShortcuts.value.length, 2);
  assert.notEqual(api.pluginShortcuts.value[0].key, api.pluginShortcuts.value[1].key);
  assert.equal(api.pluginSidebarItems.value.length, 0);
});
test('replacement invalidates old dispose and callbacks while disabled contributions disappear', async () => {
  const host = ui();
  let old = 0,
    current = 0;
  const oldDispose = host.sidebar.shortcuts.register({
    id: 'card',
    title: 'Old',
    onClick: () => old++,
  });
  const stale = api.pluginShortcuts.value[0].onClick;
  host.sidebar.shortcuts.register({ id: 'card', title: 'New', onClick: () => current++ });
  oldDispose();
  assert.equal(api.pluginShortcuts.value[0].title, 'New');
  await stale();
  assert.equal(old, 0);
  const active = api.pluginShortcuts.value[0].onClick;
  await active();
  assert.equal(current, 1);
  api.removePluginContributions('first');
  await active();
  assert.equal(current, 1);
  assert.equal(api.pluginShortcuts.value.length, 0);
});
test('invalid actions reject registration and registered page candidates preserve lower menu semantics', () => {
  const host = ui();
  for (const entry of [
    { id: 'x', title: 'x' },
    { id: 'x', title: 'x', pageId: 'page', onClick() {} },
    { id: 'x', title: 'x', onClick: 'bad' },
  ])
    assert.throws(() => host.sidebar.shortcuts.register(entry));
  host.addPage({ id: 'page', title: 'Page', component: {}, sidebar: true });
  host.sidebar.shortcuts.register({ id: 'page', title: 'Page shortcut', pageId: 'page' });
  assert.equal(api.pluginPages.value.length, 1);
  assert.equal(api.pluginSidebarItems.value.length, 1);
  assert.equal(api.pluginShortcuts.value.length, 1);
});
