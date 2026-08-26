import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as settings from '../src/shared/dsp-provider-settings.ts';

// Exercise the actual SFC setup/watchers without Electron, DOM, or audio playback.
function setupComponent(t, file, props, imports = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'navigation-test' });
  const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  const modules = {
    vue: { ...vue, useId: () => 'settings-panel', onMounted() {}, onUnmounted() {} },
    '@vueuse/core': { useThrottleFn: (fn) => fn },
    '../../../shared/dsp-provider-settings': settings,
    ...imports,
  };
  new Function('require', 'module', 'exports', code)(
    (id) => modules[id] ?? {},
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const events = [];
  const api = scope.run(() =>
    module.exports.default.setup(props, {
      expose() {},
      emit: (...args) => events.push(args),
    }),
  );
  return { api, events, descriptor };
}

test('settings remain inside the effect popover; back does not close or reapply effects', async (t) => {
  const store = vue.reactive({
    dspProviderEnabled: true,
    dspProviderPath: '/engine',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '{"presetId":"editable"}',
    impulseResponseEnabled: false,
    getSelectedImpulseResponse: () => null,
    getDspProviderPreset: () => '',
  });
  const controls = [{ id: 'speed', type: 'number', defaultValue: 10 }];
  const player = vue.reactive({
    playbackDiagnostics: {
      graph: {
        providerId: 'engine',
        providerPath: '/engine',
        providerManifestJson: JSON.stringify({
          presets: [
            { id: 'editable', label: '旋转', controls },
            { id: 'fixed', label: '固定', controls: [] },
          ],
        }),
      },
    },
  });
  const { api, descriptor } = setupComponent(
    t,
    '../src/renderer/components/player/EffectPopover.vue',
    {},
    {
      '@/composables/usePlayerControls': {
        usePlayerControls: () => ({ player, settingStore: store }),
      },
      '@/composables/useAudioEffectPlaza': { useAudioEffectPlaza: () => ({}) },
    },
  );
  // Verify containment as well as state: a sibling modal would regress this behavior.
  function ancestorsOfPanel(node, ancestors = []) {
    if (node.props?.some((p) => p.name === 'ref' && p.value?.content === 'providerSettingsPanel'))
      return ancestors;
    for (const child of node.children ?? []) {
      const found = ancestorsOfPanel(child, [...ancestors, node.tag]);
      if (found) return found;
    }
  }
  assert.ok(ancestorsOfPanel(descriptor.template.ast).includes('Popover'));

  let focusCount = 0;
  const event = { currentTarget: { focus: () => focusCount++ } };
  api.effectPopoverOpen.value = true;
  await vue.nextTick();
  await api.openProviderSettings('editable', event);
  assert.equal(api.providerSettingsOpen.value, true);
  assert.equal(api.effectPopoverOpen.value, true);
  await api.closeProviderSettings();
  assert.equal(api.providerSettingsOpen.value, false);
  assert.equal(api.effectPopoverOpen.value, true);
  assert.equal(focusCount, 1);
  assert.equal(store.dspProviderPresetJson, '{"presetId":"editable"}');

  await api.openProviderSettings('fixed', event);
  assert.equal(api.providerSettingsOpen.value, false);
  await api.openProviderSettings('editable', event);
  api.effectPopoverOpen.value = false;
  await vue.nextTick();
  assert.equal(api.providerSettingsOpen.value, false);
  api.effectPopoverOpen.value = true;
  await vue.nextTick();
  assert.equal(api.providerSettingsOpen.value, false);

  await api.openProviderSettings('editable', event);
  api.selectTab('eq');
  assert.equal(api.providerSettingsOpen.value, false);
  assert.equal(api.effectPopoverOpen.value, true);
});

test('editing cancels pending hover-close and keeps outside-click dismissal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const props = vue.reactive({ trigger: 'hover', delay: 100, duration: 100, disabled: false });
  const { api } = setupComponent(t, '../src/renderer/components/ui/Popover.vue', props);
  api.handleTriggerEnter();
  t.mock.timers.tick(100);
  assert.equal(api.isOpen.value, true);
  api.handleContentLeave();
  props.trigger = 'click';
  await vue.nextTick();
  t.mock.timers.tick(100);
  assert.equal(api.isOpen.value, true);
  api.handleContentLeave();
  t.mock.timers.tick(500);
  assert.equal(api.isOpen.value, true);
  api.handleDocumentMousedown({ target: {} });
  assert.equal(api.isOpen.value, false);
});
