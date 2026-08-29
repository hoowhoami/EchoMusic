import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configurablePresetControls,
  controlDefault,
  controlVisible,
  dspPresetBankKey,
  dspPresetSettingsPatch,
  makeDspPresetJson,
  parseDspPreset,
  presetControls,
  presetControlValues,
  providerPresetSupportsSampleRate,
  runtimeMatchesPreset,
  validControlValue,
} from '../src/shared/dsp-provider-settings.ts';
import type { DspProviderControl, DspProviderManifest } from '../src/shared/player-audio-graph.ts';

const controls: DspProviderControl[] = [
  { id: 'amount', type: 'number', defaultValue: 10, range: { min: 0, max: 20, step: 1 } },
  {
    id: 'variant',
    type: 'select',
    defaultValue: 'a',
    options: [
      { value: 'a', label: '方案 A' },
      { value: 'b', label: '方案 B' },
    ],
  },
  { id: 'enabled', type: 'boolean', defaultValue: true },
];

test('editing inactive presets saves settings without selecting or changing playback', () => {
  const oldJson = makeDspPresetJson('preset-a', controls);
  const state = {
    dspProviderPresetJson: oldJson,
    dspProviderPresetBank: { [dspPresetBankKey('engine', 'speaker', 'preset-a')]: oldJson },
    dspProviderMode: 'headphone',
    impulseResponseEnabled: false,
  };
  const json = makeDspPresetJson('preset-b', controls);
  const patch = dspPresetSettingsPatch(state, 'engine', json);
  assert.equal(Object.hasOwn(patch, 'dspProviderPresetJson'), false);
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'headphone', 'preset-b')],
    json,
  );
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'speaker', 'preset-a')],
    oldJson,
  );
  assert.equal(state.dspProviderPresetJson, oldJson);
  assert.equal(Object.keys(state.dspProviderPresetBank).length, 1);
  for (const inactive of [
    { ...state, dspProviderPresetJson: '' },
    { ...state, dspProviderPresetJson: json, impulseResponseEnabled: true },
  ]) {
    assert.equal(
      Object.hasOwn(dspPresetSettingsPatch(inactive, 'engine', json), 'dspProviderPresetJson'),
      false,
    );
  }
});

test('editing the active preset applies and saves; reset and invalid identity are safe', () => {
  const defaults = makeDspPresetJson('preset-a', controls);
  const state = {
    dspProviderPresetJson: defaults,
    dspProviderPresetBank: {},
    dspProviderMode: 'speaker',
    impulseResponseEnabled: false,
  };
  const changed = makeDspPresetJson(
    'preset-a',
    controls,
    '{"presetId":"preset-a","controls":{"amount":{"value":20}}}',
  );
  const patch = dspPresetSettingsPatch(state, 'engine', changed);
  assert.equal(patch.dspProviderPresetJson, changed);
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'speaker', 'preset-a')],
    changed,
  );
  assert.equal(
    dspPresetSettingsPatch({ ...state, ...patch }, 'engine', defaults).dspProviderPresetJson,
    defaults,
  );
  assert.deepEqual(dspPresetSettingsPatch(state, '', changed), {});
  assert.deepEqual(dspPresetSettingsPatch(state, 'engine', '{}'), {});
});

test('per-preset controls override global controls, including an explicit empty list', () => {
  const manifest: DspProviderManifest = {
    schemaVersion: 1,
    controls,
    presets: [
      { id: 'fixed', label: '固定', controls: [] },
      { id: 'editable', label: '可调', controls: [controls[0]] },
      { id: 'legacy', label: '旧版' },
    ],
  };
  assert.deepEqual(presetControls(manifest, ''), []);
  assert.deepEqual(presetControls(manifest, 'fixed'), []);
  assert.deepEqual(presetControls(manifest, 'editable'), [controls[0]]);
  assert.deepEqual(presetControls(manifest, 'legacy'), controls);
});

test('commands retain preset identity and only valid applicable parameter values', () => {
  const saved = JSON.stringify({
    presetId: 'preset-a',
    controls: { amount: { value: 5 }, obsolete: { value: 99 } },
  });
  const result = parseDspPreset(makeDspPresetJson('preset-a', controls, saved));
  assert.equal(result.presetId, 'preset-a');
  assert.deepEqual(result.controls, {
    amount: { value: 5 },
    variant: { value: 'a' },
    enabled: { value: true },
  });
  assert.equal(
    parseDspPreset(makeDspPresetJson('another', controls, saved)).controls.amount.value,
    10,
  );
  assert.equal(makeDspPresetJson('fixed', []), '{"presetId":"fixed"}');
});

test('disabled select options are visible capabilities but never valid saved values', () => {
  const mode: DspProviderControl = {
    id: 'mode',
    type: 'select',
    defaultValue: 'manual',
    options: [
      { value: 'auto', label: '自动（需方向传感器）', disabled: true },
      { value: 'manual', label: '手动' },
    ],
  };
  assert.equal(validControlValue(mode, 'auto'), false);
  assert.equal(validControlValue(mode, 'manual'), true);
  assert.equal(
    parseDspPreset(
      makeDspPresetJson(
        'space',
        [mode],
        '{"presetId":"space","controls":{"mode":{"value":"auto"}}}',
      ),
    ).controls.mode.value,
    'manual',
  );
  assert.equal(controlDefault({ ...mode, defaultValue: 'auto' }), 'manual');
});

test('boolean controls can label switch sides and disable an unavailable state', () => {
  const mode: DspProviderControl = {
    id: 'mode',
    type: 'boolean',
    defaultValue: true,
    options: [
      { value: false, label: '自动', disabled: true },
      { value: true, label: '手动' },
    ],
  };
  assert.equal(validControlValue(mode, false), false);
  assert.equal(validControlValue(mode, true), true);
  assert.equal(controlDefault({ ...mode, defaultValue: false }), true);
});

test('configuration availability follows editable capabilities, never development status', () => {
  const manifest: DspProviderManifest = {
    schemaVersion: 1,
    presets: [
      { id: 'fixed', label: '固定', controls: [] },
      { id: 'editable', label: '可配置', controls },
      {
        id: 'readonly',
        label: '只读',
        controls: [
          { ...controls[0], ownership: 'host' },
          { ...controls[1], ownership: 'disabled' },
          { id: 'info', type: 'string', value: 'description' },
          { id: 'empty', type: 'select', options: [] },
        ],
      },
    ],
  };
  assert.deepEqual(configurablePresetControls(manifest, 'fixed'), []);
  assert.deepEqual(configurablePresetControls(manifest, 'readonly'), []);
  assert.deepEqual(configurablePresetControls(manifest, 'editable'), controls);
  assert.deepEqual(configurablePresetControls(null, 'missing'), []);
});

test('wrong types, invalid ranges, fractional steps and invalid enum values are rejected', () => {
  for (const value of [-1, 21, 1.5, NaN, Infinity, '5', null])
    assert.equal(validControlValue(controls[0], value), false);
  assert.equal(validControlValue(controls[0], 0), true);
  assert.equal(validControlValue(controls[1], 'unknown'), false);
  assert.equal(validControlValue(controls[2], 0), false);
  assert.equal(
    presetControlValues(controls, '{"presetId":"x","controls":{"amount":{"value":999}}}').amount
      .value,
    10,
  );
});

test('defaults, visibility and engine/device/preset storage remain independent', () => {
  const values = presetControlValues(controls, '');
  assert.equal(
    controlVisible({ ...controls[0], visibleWhen: { controlId: 'variant', value: 'b' } }, values),
    false,
  );
  const keys = [
    dspPresetBankKey('a', 'speaker', 'x'),
    dspPresetBankKey('a', 'headphone', 'x'),
    dspPresetBankKey('b', 'speaker', 'x'),
    dspPresetBankKey('a', 'speaker', 'y'),
  ];
  assert.equal(new Set(keys).size, 4);
  assert.equal(runtimeMatchesPreset({ effect: { id: 'old' } }, 'new'), false);
  assert.equal(runtimeMatchesPreset({ effect: { id: 'x' } }, 'x'), true);
  for (const text of ['no', 'null', '[]', '{}', '{"presetId":5}'])
    assert.equal(parseDspPreset(text).presetId, '');
});

test('preset sample rates trigger negotiation without becoming a UI availability rule', () => {
  const manifest: DspProviderManifest = {
    schemaVersion: 1,
    presets: [
      { id: 'limited', label: '限定采样率', supportedSampleRates: [44_100, 48_000] },
      { id: 'flexible', label: '通用' },
    ],
  };
  assert.equal(providerPresetSupportsSampleRate(manifest, '{"presetId":"limited"}', 48_000), true);
  assert.equal(
    providerPresetSupportsSampleRate(manifest, '{"presetId":"limited"}', 192_000),
    false,
  );
  assert.equal(
    providerPresetSupportsSampleRate(manifest, '{"presetId":"flexible"}', 192_000),
    true,
  );
  assert.equal(providerPresetSupportsSampleRate(manifest, '', 192_000), true);
  assert.equal(providerPresetSupportsSampleRate(manifest, '{"presetId":"limited"}', 0), true);
});

test('provider-owned controls only; saved __proto__ is data and cannot change prototypes', () => {
  assert.deepEqual(presetControlValues([{ ...controls[0], ownership: 'host' }], ''), {});
  assert.deepEqual(presetControlValues([{ ...controls[0], ownership: 'disabled' }], ''), {});
  const parsed = parseDspPreset('{"presetId":"x","controls":{"__proto__":{"value":1}}}');
  assert.equal(Object.getPrototypeOf(parsed.controls), Object.prototype);
  assert.equal(Object.hasOwn(parsed.controls, '__proto__'), true);
});

test('control schema upgrades add defaults without losing saved values', () => {
  const id = 'adjustable';
  const upgradedControls: DspProviderControl[] = [
    controls[0],
    { id: 'depth', type: 'number', defaultValue: 0, range: { min: 0, max: 400, step: 1 } },
    { id: 'width', type: 'number', defaultValue: 0, range: { min: 0, max: 4, step: 1 } },
  ];
  const legacy = JSON.stringify({ presetId: id, controls: { amount: { value: 16 } } });
  const upgraded = makeDspPresetJson(id, upgradedControls, legacy);
  assert.deepEqual(parseDspPreset(upgraded).controls, {
    amount: { value: 16 },
    depth: { value: 0 },
    width: { value: 0 },
  });
  const changed = makeDspPresetJson(
    id,
    upgradedControls,
    JSON.stringify({
      presetId: id,
      controls: { amount: { value: 16 }, depth: { value: 200 }, width: { value: 3 } },
    }),
  );
  const state = {
    dspProviderPresetJson: upgraded,
    dspProviderPresetBank: {},
    dspProviderMode: 'headphone',
    impulseResponseEnabled: false,
  };
  const patch = dspPresetSettingsPatch(state, 'engine', changed);
  const key = dspPresetBankKey('engine', 'headphone', id);
  assert.equal(patch.dspProviderPresetJson, changed);
  assert.equal(
    makeDspPresetJson(id, upgradedControls, patch.dspProviderPresetBank?.[key]),
    changed,
  );
  const defaults = makeDspPresetJson(id, upgradedControls);
  const reset = dspPresetSettingsPatch({ ...state, ...patch }, 'engine', defaults);
  assert.deepEqual(parseDspPreset(reset.dspProviderPresetJson!).controls, {
    amount: { value: 10 },
    depth: { value: 0 },
    width: { value: 0 },
  });
  assert.equal(validControlValue(upgradedControls[1], 401), false);
  assert.equal(validControlValue(upgradedControls[2], 5), false);
  assert.equal(validControlValue(upgradedControls[2], 1.5), false);
});

test('conditional controls switch visibility without dropping hidden settings', () => {
  const id = 'conditional';
  const choice = (id: string, values: number[], defaultValue: number): DspProviderControl => ({
    id,
    type: 'select',
    defaultValue,
    ownership: 'provider',
    options: values.map((value) => ({ value, label: String(value) })),
  });
  const conditional: DspProviderControl[] = [
    choice('mode', [0, 1], 0),
    { ...choice('amount', [0, 1, 2, 3, 4], 2), visibleWhen: { controlId: 'mode', value: 0 } },
    { ...choice('level', [0, 1, 2, 3, 4], 2), visibleWhen: { controlId: 'mode', value: 1 } },
  ];
  const manifest: DspProviderManifest = {
    schemaVersion: 1,
    presets: [{ id, label: '条件音效', controls: conditional }],
  };
  assert.equal(configurablePresetControls(manifest, id).length, 3);
  const upgraded = makeDspPresetJson(id, conditional, JSON.stringify({ presetId: id }));
  assert.deepEqual(parseDspPreset(upgraded).controls, {
    mode: { value: 0 },
    amount: { value: 2 },
    level: { value: 2 },
  });
  let current = makeDspPresetJson(
    id,
    conditional,
    JSON.stringify({
      presetId: id,
      controls: { mode: { value: 0 }, amount: { value: 4 }, level: { value: 1 } },
    }),
  );
  for (const mode of [0, 1, 0]) {
    const command = parseDspPreset(current);
    command.controls.mode.value = mode;
    current = makeDspPresetJson(id, conditional, JSON.stringify(command));
    const state = {
      dspProviderPresetJson: current,
      dspProviderPresetBank: {},
      dspProviderMode: 'headphone',
      impulseResponseEnabled: false,
    };
    const saved = dspPresetSettingsPatch(state, 'example-provider', current);
    current = makeDspPresetJson(
      id,
      conditional,
      saved.dspProviderPresetBank![dspPresetBankKey('example-provider', 'headphone', id)],
    );
    const values = presetControlValues(conditional, current);
    assert.deepEqual(
      conditional.filter((c) => controlVisible(c, values)).map((c) => c.id),
      ['mode', mode === 0 ? 'amount' : 'level'],
    );
    assert.equal(values.amount.value, 4);
    assert.equal(values.level.value, 1);
    assert.equal(saved.dspProviderPresetJson, current);
  }
  assert.equal(makeDspPresetJson(id, conditional), upgraded);
  for (const value of [-1, 5, 1.5, '2', true, null])
    assert.equal(validControlValue(conditional[1], value), false);
});
