import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as settings from '../src/shared/dsp-provider-settings.ts';
import * as audio from '../src/shared/audio.ts';
import * as audioSupport from '../src/shared/audio-effect-support.ts';

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
    '../../../shared/audio': audio,
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

test('my-effects buttons disable unsupported downloads and use the guarded player action', (t) => {
  const file = {
    id: 'combined',
    name: '组合',
    kind: 'community-combined',
    impulseResponsePath: '/a.wav',
    vpfPath: '/a.vpf',
  };
  const state = vue.reactive({ engine: { kind: 'builtin' } });
  const selected = [];
  const store = vue.reactive({
    dspProviderEnabled: false,
    dspProviderPath: '',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '',
    impulseResponseEnabled: true,
    selectedImpulseResponseId: file.id,
    impulseResponseFiles: [file],
    getSelectedImpulseResponse: () => file,
    getDspProviderPreset: () => '',
    rememberDspProviderPreset() {},
    selectOriginalSpatialAudio() {
      this.impulseResponseEnabled = false;
    },
  });
  const player = vue.reactive({
    playbackDiagnostics: { graph: null },
    getSpatialAudioEffectSupport: (file) => audioSupport.audioEffectSupport(file, state.engine),
    selectSpatialAudioEffect: (id) => {
      if (audioSupport.audioEffectSupport(file, state.engine).status === 'supported')
        selected.push(id);
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
  assert.equal(api.impulseResponseActive.value, false);
  assert.equal(api.impulseResponseSupport(file).status, 'unsupported');
  api.selectImpulseResponse(file.id);
  assert.equal(selected.length, 0);
  assert.match(
    descriptor.template.content,
    /:disabled="impulseResponseSupport\(file\)\.status !== 'supported'"/,
  );
  state.engine = {
    kind: 'provider',
    manifest: { resources: [{ kind: 'vpf' }, { kind: 'impulse-response' }] },
  };
  assert.equal(api.impulseResponseSupport(file).status, 'supported');
  api.selectImpulseResponse(file.id);
  assert.deepEqual(selected, [file.id]);
  state.engine = { kind: 'checking' };
  api.resetImpulseResponse();
  assert.equal(store.impulseResponseEnabled, false, 'original cancels a pending saved selection');
});

test('Basic DSP convolution exposes a per-effect mix and providers hide the host control', (t) => {
  const file = {
    id: 'local-ir-sha256',
    name: '空间卷积',
    kind: 'imported-ir',
    impulseResponsePath: '/a.wav',
  };
  const mixes = {};
  const store = vue.reactive({
    dspProviderEnabled: false,
    dspProviderPath: '',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '',
    impulseResponseEnabled: true,
    selectedImpulseResponseId: file.id,
    impulseResponseFiles: [file],
    getSelectedImpulseResponse: () => file,
    getDspProviderPreset: () => '',
    getImpulseResponseMix: (id) => mixes[id] ?? 0.5,
    setImpulseResponseMix: (id, value) => {
      mixes[id] = value;
    },
  });
  const player = vue.reactive({
    playbackDiagnostics: { graph: null },
    getSpatialAudioEffectSupport: () => ({ status: 'supported', reason: '' }),
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

  assert.equal(api.basicDspConvolutionActive.value, true);
  assert.equal(api.builtinAudioEngineActive.value, true);
  assert.equal(api.currentPlaybackEffectSelection.value.type, '本地音效');
  assert.equal(api.currentPlaybackEffectSelection.value.name, '空间卷积');
  assert.equal(api.convolutionMixPercent.value, 50);
  api.previewConvolutionMix(73);
  assert.equal(api.convolutionMixPercent.value, 73);
  api.commitConvolutionMix(73);
  assert.equal(mixes[file.id], 0.73);
  assert.match(descriptor.template.content, /v-if="builtinAudioEngineActive"/);
  assert.match(descriptor.template.content, /:disabled="!basicDspConvolutionActive"/);

  store.impulseResponseEnabled = false;
  assert.equal(api.basicDspConvolutionActive.value, false);
  assert.equal(api.builtinAudioEngineActive.value, true);

  store.impulseResponseEnabled = true;
  store.dspProviderEnabled = true;
  store.dspProviderPath = '/provider';
  assert.equal(api.basicDspConvolutionActive.value, false);
  assert.equal(api.builtinAudioEngineActive.value, false);
});

test('the current spatial effect is locatable without locking manual tab browsing', async (t) => {
  const files = [
    {
      id: 'headphone-effect',
      name: '耳机空间',
      kind: 'community-ir',
      source: 'headphone',
      impulseResponsePath: '/headphone.wav',
    },
    {
      id: 'artist-effect',
      name: '歌手现场',
      kind: 'community-ir',
      source: 'artist',
      impulseResponsePath: '/artist.wav',
    },
  ];
  const store = vue.reactive({
    dspProviderEnabled: true,
    dspProviderPath: '/provider',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '',
    impulseResponseEnabled: true,
    selectedImpulseResponseId: files[0].id,
    impulseResponseFiles: files,
    getSelectedImpulseResponse() {
      return this.impulseResponseFiles.find((file) => file.id === this.selectedImpulseResponseId);
    },
    getDspProviderPreset: () => '',
    getImpulseResponseMix: () => 0.5,
  });
  const player = vue.reactive({
    playbackDiagnostics: {
      graph: {
        providerId: 'provider',
        providerPath: '/provider',
        providerMode: 'speaker',
        providerManifestJson: JSON.stringify({
          displayName: '测试引擎',
          presets: [{ id: 'stage', label: '现场' }],
        }),
      },
    },
    getSpatialAudioEffectSupport: () => ({ status: 'supported', reason: '' }),
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

  assert.equal(api.activeTab.value, 'irs');
  assert.equal(api.activeImpulseResponseLibraryTab.value, 'mine');
  assert.equal(api.activeMyEffectSource.value, 'headphone');
  assert.equal(api.currentPlaybackEffectSelection.value.location, '我的音效 · 耳机音效');
  assert.equal(api.isMyEffectSourceActive('headphone'), true);

  api.selectImpulseResponseLibraryTab('engine');
  api.activeMyEffectSource.value = 'local';
  await vue.nextTick();
  assert.equal(api.activeImpulseResponseLibraryTab.value, 'engine');
  assert.equal(api.activeMyEffectSource.value, 'local');

  store.selectedImpulseResponseId = files[1].id;
  await vue.nextTick();
  assert.equal(api.activeImpulseResponseLibraryTab.value, 'mine');
  assert.equal(api.activeMyEffectSource.value, 'artist');
  assert.equal(api.isMyEffectSourceActive('artist'), true);

  store.impulseResponseEnabled = false;
  store.dspProviderPresetJson = '{"presetId":"stage"}';
  await vue.nextTick();
  assert.equal(api.activeImpulseResponseLibraryTab.value, 'engine');
  assert.equal(api.engineLibraryContainsActive.value, true);
  assert.equal(api.currentPlaybackEffectSelection.value.name, '现场');
  assert.equal(api.providerEqLocked.value, true);

  assert.match(descriptor.template.content, /class="current-spatial-effect-actions"/);
  assert.doesNotMatch(descriptor.template.content, /当前音效\s*·/);
  assert.match(
    descriptor.template.content,
    /class="current-effect-location"[\s\S]*currentPlaybackEffectSelection\.name/,
  );
  assert.doesNotMatch(descriptor.template.content, /iconArrowRight/);
  assert.doesNotMatch(descriptor.template.content, /iconCheckMark/);
  assert.match(descriptor.template.content, /class="original-effect-dot"/);
  assert.match(descriptor.template.content, /:disabled="!currentPlaybackEffectSelection\.active"/);
  assert.match(
    descriptor.styles[0].content,
    /\.current-spatial-effect\s*{[\s\S]*min-height:\s*59px/,
  );
  assert.match(
    descriptor.styles[0].content,
    /\.current-spatial-effect-copy strong\s*{[\s\S]*min-height:\s*26px/,
  );
  assert.match(descriptor.template.content, /当前由音效引擎自动处理/);
  assert.doesNotMatch(descriptor.template.content, /已保存的 EQ 设置/);
  assert.match(descriptor.template.content, /class="library-current-dot"/);
  assert.match(descriptor.template.content, /class="my-effect-source-current"/);
  assert.doesNotMatch(descriptor.template.content, />\s*使用中\s*</);
});

test('configured provider shows a loading state instead of flashing the not-imported state', (t) => {
  const store = vue.reactive({
    dspProviderEnabled: true,
    dspProviderPath: '/provider',
    dspProviderMode: 'speaker',
    dspProviderPresetJson: '',
    impulseResponseEnabled: false,
    selectedImpulseResponseId: '',
    impulseResponseFiles: [],
    getSelectedImpulseResponse: () => null,
    getDspProviderPreset: () => '',
    getImpulseResponseMix: () => 0.5,
  });
  const player = vue.reactive({
    playbackDiagnostics: { graph: null },
    dspProviderInspection: null,
    getSpatialAudioEffectSupport: () => ({ status: 'supported', reason: '' }),
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

  assert.equal(api.providerConfigured.value, true);
  assert.equal(api.providerChecking.value, true);
  assert.equal(api.providerInspectionFailed.value, false);
  assert.match(descriptor.template.content, /v-if="providerChecking"/);
  assert.match(descriptor.template.content, /v-else-if="providerConfigured"/);

  player.dspProviderInspection = {
    path: '/provider',
    mode: 'speaker',
    status: 'ready',
    info: {
      providerId: 'provider-id',
      providerVersion: '1.0.0',
      manifestJson: JSON.stringify({
        displayName: '测试引擎',
        presets: [{ id: 'preset', label: '测试预设' }],
      }),
    },
  };
  assert.equal(api.providerChecking.value, false);
  assert.equal(api.providerDisplayName.value, '测试引擎');
  assert.equal(api.providerVersion.value, '1.0.0');
  assert.equal(api.providerPresets.value.length, 1);
});

test('download cards disable by capability status, even if an unavailable reason is empty', (t) => {
  const state = vue.reactive({ support: { status: 'supported', reason: '' } });
  const { api, descriptor } = setupComponent(
    t,
    '../src/renderer/components/player/OnlineAudioEffectCard.vue',
    {
      effect: { name: '已下载音效' },
      plaza: { getEffectSupport: () => state.support },
    },
  );
  assert.equal(api.unavailable.value, false);
  for (const status of ['checking', 'unsupported']) {
    state.support = { status, reason: '' };
    assert.equal(api.unavailable.value, true);
    assert.equal(api.unavailableReason.value, '当前音效暂不可用');
  }
  state.support = { status: 'unsupported', reason: '当前引擎不支持此 VPF 音效' };
  assert.equal(api.unavailableReason.value, state.support.reason);
  state.support = { status: 'supported', reason: '' };
  assert.equal(api.unavailable.value, false);
  assert.equal(api.unavailableReason.value, '');
  assert.match(descriptor.template.content, /:disabled="unavailable \|\|/);
  assert.match(descriptor.template.content, /@click="plaza.actOnEffect\(effect\)"/);
});

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
            { id: 'editable', label: '旋转', recommendedDevice: 'headphone', controls },
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
  assert.match(descriptor.template.content, /preset\.recommendedDevice === 'headphone'/);
  assert.match(descriptor.template.content, />耳机<\/small/);

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
      { value: 'sensor', label: '自动（需方向传感器）', disabled: true },
    ],
  };
  const aging = {
    id: 'aging',
    type: 'number',
    defaultValue: 0,
    range: { min: 0, max: 100, step: 1, minLabel: '全新', maxLabel: '老化', inverted: true },
  };
  const mode = {
    id: 'mode',
    type: 'boolean',
    defaultValue: true,
    options: [
      { value: false, label: '自动', disabled: true },
      { value: true, label: '手动' },
    ],
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
          presets: [{ id: 'record', label: '唱片', controls: [year, aging, mode] }],
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
    { value: '"sensor"', label: '自动（需方向传感器）', disabled: true },
  ]);
  api.setProviderSelect(year, '1930');
  assert.equal(writes.at(-1).controls.year.value, 1930);
  api.setProviderSelect(year, 'invalid');
  api.setProviderSelect(year, '"sensor"');
  api.setProviderSelect(year, ['2010']);
  assert.equal(writes.length, 1);
  assert.equal(api.providerBooleanLabel(mode, false), '自动');
  assert.equal(api.providerBooleanLabel(mode, true), '手动');
  assert.equal(api.providerBooleanDisabled(mode), true);
  api.setProviderControl(mode, false);
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
  assert.match(descriptor.template.content, /<Switch\s/);
  assert.doesNotMatch(descriptor.template.content, /<select\s/);
  assert.doesNotMatch(descriptor.template.content, /type="checkbox"/);
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
