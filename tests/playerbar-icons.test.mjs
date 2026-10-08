import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createSSRApp, h, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';

const require = createRequire(import.meta.url);
const player = reactive({ volume: 100 });
const cache = new Map();
function load(path) {
  path = resolve(path);
  if (cache.has(path)) return cache.get(path);
  let source = readFileSync(path, 'utf8');
  if (path.endsWith('.vue')) {
    if (!source.includes('<script')) source = '<script setup>defineOptions({});</script>' + source;
    const { descriptor } = parse(source);
    source = compileScript(descriptor, { id: path, inlineTemplate: true }).content;
  }
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )(
    (id) => {
      if (id === '@iconify/vue') {
        const { Icon } = require(id);
        return { Icon: (props) => h(Icon, { ...props, ssr: true }) };
      }
      if (id === '@/stores/player') return { usePlayerStore: () => player };
      if (id.startsWith('@/'))
        return load(`src/renderer/${id.slice(2)}${id.endsWith('.vue') ? '' : '.ts'}`);
      if (id.startsWith('.')) return load(resolve(dirname(path), id));
      return require(id);
    },
    module,
    module.exports,
  );
  cache.set(path, module.exports);
  return module.exports;
}
const ActionIcon = load('src/renderer/layouts/PlayerBarActionIcon.vue').default;
const VolumeIcon = load('src/renderer/components/player/VolumeIcon.vue').default;
const icons = load('src/renderer/icons.ts');
const render = (component, props) =>
  renderToString(createSSRApp({ render: () => h(component, props) }));

test('layout icons render the supplied custom SVG without action ID lookup', async () => {
  for (const name of ['AudioWaveIcon', 'MvIcon', 'BarrageIcon']) {
    const component = load(`src/renderer/components/ui/${name}.vue`).default;
    const expected = await render(component, { width: 18, height: 18 });
    const actual = await render(ActionIcon, {
      item: { key: 'arbitrary-action', iconComponent: component },
      width: 18,
      height: 18,
    });
    assert.equal(actual, expected);
  }
});

test('volume preview uses the same dynamic icon as the volume button', async () => {
  const rendered = [];
  for (const [volume, icon] of [
    [0, icons.iconVolume3],
    [35, icons.iconVolume1],
    [80, icons.iconVolume2],
  ]) {
    player.volume = volume;
    const preview = await render(ActionIcon, {
      item: { iconComponent: VolumeIcon },
      width: 22,
      height: 22,
    });
    const button = await render(VolumeIcon);
    assert.equal(preview, button);
    const { Icon } = require('@iconify/vue');
    assert.equal(button, await render(Icon, { icon, width: 22, height: 22, ssr: true }));
    rendered.push(preview);
  }
  assert.equal(new Set(rendered).size, 3);
});
