import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['src/renderer/views/plugins/pluginPresentation.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
});
const module = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
const { getPluginFeatureTags } = module.exports;
test('theme capability produces a theme badge without marketplace metadata', () => {
  assert.deepEqual(getPluginFeatureTags({ capabilities: { theme: true } }), ['主题']);
  assert.deepEqual(getPluginFeatureTags({ capabilities: { theme: false } }), []);
  assert.deepEqual(getPluginFeatureTags({ capabilities: { theme: true, lyrics: true } }), [
    '主题',
    '歌词解析',
  ]);
});
