import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { computed, reactive } from 'vue';
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['src/renderer/views/plugins/usePluginFailures.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['vue'],
  plugins: [
    {
      name: 'runtime-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^@\/(plugins\/runtime|stores\/toast)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `
      export const pluginRuntimeState = fixture.state;
      export const clearRuntimePluginFailure = (...args) => fixture.clear(...args);
      export const useToastStore = () => fixture.toast;
    `,
        }));
      },
    },
  ],
});
function setup() {
  const fixture = {
    state: reactive({ lastFailure: null, failures: {}, safeMode: false }),
    toast: {
      actionCompleted() {},
      warning(message) {
        fixture.warning = message;
      },
    },
    async clear(id) {
      assert.equal(id, undefined);
      fixture.state.lastFailure = null;
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fixture', bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
    fixture,
  );
  const record = {
    descriptor: { id: 'installed', name: 'Installed', compatibility: { compatible: true } },
    status: 'idle',
  };
  const ui = module.exports.usePluginFailures({ records: computed(() => [record]) });
  return { fixture, ui, record };
}
const failure = { reason: 'activation-error', message: 'error', createdAt: 123 };
test('removed plugin errors are hidden, installed errors stay on their own card', () => {
  const { fixture, ui, record } = setup();
  fixture.state.lastFailure = { ...failure, pluginId: 'removed' };
  assert.equal(ui.globalFailure.value, null);
  assert.equal(ui.getPluginCardFailure(record), null);
  fixture.state.lastFailure = { ...failure, pluginIds: ['removed', 'installed'] };
  assert.equal(ui.globalFailure.value, null);
  assert.equal(ui.getPluginCardFailure(record).isHistorical, true);
});
test('anonymous error can be cleared, with repeat clicks blocked while pending', async () => {
  const { fixture, ui } = setup();
  fixture.state.lastFailure = failure;
  let finish;
  let calls = 0;
  fixture.clear = async () => {
    calls++;
    await new Promise((resolve) => {
      finish = resolve;
    });
    fixture.state.lastFailure = null;
  };
  const clearing = ui.clearGlobalFailureRecord();
  await ui.clearGlobalFailureRecord();
  assert.equal(calls, 1);
  assert.equal(ui.isClearingFailure.value, true);
  finish();
  await clearing;
  assert.equal(ui.globalFailure.value, null);
  assert.equal(ui.isClearingFailure.value, false);
});
test('failed clear retains the banner and allows retry', async () => {
  const { fixture, ui } = setup();
  fixture.state.lastFailure = failure;
  fixture.clear = async () => {
    throw new Error('clear failed');
  };
  await ui.clearGlobalFailureRecord();
  assert.equal(ui.globalFailure.value.message, 'error');
  assert.equal(ui.isClearingFailure.value, false);
  assert.equal(fixture.warning, 'clear failed');
});
