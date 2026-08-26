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
    vue: {
      ...vue,
      useId: () => 'settings-panel',
      onMounted() {},
      onUnmounted() {},
      inject: () => null,
      provide() {},
    },
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

test('portalled select descendants do not dismiss the outer popover; siblings still do', (t) => {
  const props = () => vue.reactive({ trigger: 'click', disabled: false });
  const parent = setupComponent(t, '../src/renderer/components/ui/Popover.vue', props()).api;
  const child = setupComponent(t, '../src/renderer/components/ui/Popover.vue', props()).api;
  const grandchild = setupComponent(t, '../src/renderer/components/ui/Popover.vue', props()).api;
  const inside = {},
    nested = {},
    sibling = {};
  child.contentWrapRef.value = { contains: (target) => target === inside };
  grandchild.contentWrapRef.value = { contains: (target) => target === nested };
  const unregister = parent.registerPopoverBranch(child.containsPopoverTarget);
  child.registerPopoverBranch(grandchild.containsPopoverTarget);
  parent.handleTriggerClick();
  parent.handleDocumentMousedown({ target: inside });
  parent.handleDocumentMousedown({ target: nested });
  assert.equal(parent.isOpen.value, true);
  parent.handleDocumentMousedown({ target: sibling });
  assert.equal(parent.isOpen.value, false);
  parent.handleTriggerClick();
  unregister();
  parent.handleDocumentMousedown({ target: inside });
  assert.equal(parent.isOpen.value, false);
});

test('provider select uses project Select and retains numeric/JSON option types', async (t) => {
  const year = {
    id: 'year',
    type: 'select',
    defaultValue: 2010,
    options: [
      { value: 1930, label: '1930年' },
      { value: 2010, label: '2010年' },
    ],
  };
  const aging = {
    id: 'aging',
    type: 'number',
    defaultValue: 0,
    range: { min: 0, max: 100, step: 1, minLabel: '全新', maxLabel: '老化', inverted: true },
  };
  const writes = [];
  const store = vue.reactive({
    dspProviderEnabled: true,
    dspProviderPath: '/engine',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '{"presetId":"record"}',
    impulseResponseEnabled: false,
    getSelectedImpulseResponse: () => null,
    getDspProviderPreset: () => '',
    saveDspProviderPresetSettings: (json) => writes.push(JSON.parse(json)),
  });
  const player = vue.reactive({
    playbackDiagnostics: {
      graph: {
        providerId: 'engine',
        providerPath: '/engine',
        providerManifestJson: JSON.stringify({
          presets: [{ id: 'record', label: '唱片', controls: [year, aging] }],
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
  await api.openProviderSettings('record', { currentTarget: null });
  assert.deepEqual(api.providerSelectOptions(year), [
    { value: '1930', label: '1930年' },
    { value: '2010', label: '2010年' },
  ]);
  api.setProviderSelect(year, '1930');
  assert.equal(writes.at(-1).controls.year.value, 1930);
  api.setProviderSelect(year, 'invalid');
  api.setProviderSelect(year, ['2010']);
  assert.equal(writes.length, 1);
  const structured = {
    id: 'scene',
    type: 'select',
    options: [{ value: { layout: 2 }, label: '双声道' }],
  };
  assert.equal(api.providerSelectOptions(structured)[0].value, '{"layout":2}');
  api.previewProviderControl(aging, 100);
  assert.equal(api.providerControlValue(aging), 100);
  assert.equal(writes.length, 1, 'drag preview does not send a command');
  api.setProviderControl(aging, 100);
  assert.equal(writes.at(-1).controls.aging.value, 100, 'left endpoint keeps API aging=100');
  api.setProviderControl(aging, 0);
  assert.equal(writes.at(-1).controls.aging.value, 0, 'right endpoint keeps API aging=0');
  assert.match(descriptor.template.content, /<Select\s/);
  assert.doesNotMatch(descriptor.template.content, /<select\s/);
  assert.match(descriptor.template.content, /:inverted="control.range\?\.inverted \?\? false"/);
  assert.match(
    descriptor.template.content,
    /control.range.inverted \? control.range.maxLabel : control.range.minLabel/,
  );
});

test('project Select respects disabled state and keeps numeric values', (t) => {
  const props = vue.reactive({
    options: [{ value: 1930, label: '1930年' }],
    modelValue: 1930,
    disabled: true,
    multiple: false,
    filterable: false,
    clearable: false,
    maxTagCount: 1,
    virtualThreshold: 50,
  });
  const { api, events } = setupComponent(t, '../src/renderer/components/ui/Select.vue', props);
  api.handleSelect(props.options[0]);
  api.handleClear({ stopPropagation() {} });
  assert.deepEqual(events, []);
  props.disabled = false;
  api.handleSelect(props.options[0]);
  assert.deepEqual(events, [['update:modelValue', 1930]]);
});
