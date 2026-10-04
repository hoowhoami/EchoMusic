import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { reactive, effectScope, nextTick } from 'vue';
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['src/renderer/theme/useWindowAppearance.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['vue'],
  plugins: [
    {
      name: 'fixture',
      setup(builder) {
        builder.onResolve({ filter: /^@\/stores\/(theme|setting)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents:
            'export const useThemeStore = () => fixture.theme; export const useSettingStore = () => fixture.setting;',
        }));
      },
    },
  ],
});
const flush = async () => {
  await nextTick();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function setup(preferences = { windowFrosted: false }) {
  const fixture = {
    theme: reactive({
      activePreferences: preferences,
      windowTransparency: 40,
      updateGeneralPreferences(patch) {
        Object.assign(this.activePreferences, patch);
      },
    }),
    calls: [],
    fail: false,
  };
  fixture.setting = {
    async setWindowBackground(value) {
      fixture.calls.push(value);
      if (fixture.fail) throw new Error('native unavailable');
    },
  };
  const module = { exports: {} };
  const vue = require('vue');
  new Function('require', 'module', 'exports', 'fixture', bundle.outputFiles[0].text)(
    (id) =>
      id === 'vue'
        ? {
            ...vue,
            provide(_key, controls) {
              fixture.controls = controls;
            },
          }
        : require(id),
    module,
    module.exports,
    fixture,
  );
  const scope = effectScope();
  scope.run(() => module.exports.provideWindowAppearance());
  return { ...fixture, scope };
}
test('window frost toggle persists and reaches native sync; transparency changes retain it', async () => {
  const f = setup();
  await flush();
  assert.equal(f.calls.at(-1).frosted, false);
  f.controls.setFrosted(true);
  await flush();
  assert.equal(f.theme.activePreferences.windowFrosted, true);
  assert.deepEqual(f.calls.at(-1), { enabled: true, frosted: true, transparency: 40, color: '' });
  f.theme.windowTransparency = 70;
  await flush();
  assert.equal(f.calls.at(-1).frosted, true);
  assert.equal(f.calls.at(-1).transparency, 70);
  f.controls.setFrosted(false);
  await flush();
  assert.equal(f.calls.at(-1).frosted, false);
  f.scope.stop();
});
test('saved frost is restored on layout mount rather than forcibly disabled', async () => {
  const f = setup({ windowFrosted: true });
  await flush();
  assert.equal(f.controls.frosted.value, true);
  assert.equal(f.calls.at(-1).frosted, true);
  f.scope.stop();
  const count = f.calls.length;
  f.theme.windowTransparency = 20;
  await flush();
  assert.equal(f.calls.length, count);
});
