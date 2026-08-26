import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configurablePresetControls,
  controlVisible,
  dspPresetBankKey,
  dspPresetSettingsPatch,
  makeDspPresetJson,
  parseDspPreset,
  presetControls,
  presetControlValues,
  runtimeMatchesPreset,
  validControlValue,
} from '../src/shared/dsp-provider-settings.ts';
import type { DspProviderControl, DspProviderManifest } from '../src/shared/player-audio-graph.ts';

const controls: DspProviderControl[] = [
  { id: 'speed', type: 'number', defaultValue: 10, range: { min: 0, max: 20, step: 1 } },
  {
    id: 'scene',
    type: 'select',
    defaultValue: 'loop',
    options: [
      { value: 'loop', label: '旋转' },
      { value: 'star', label: '星空' },
    ],
  },
  { id: 'enabled', type: 'boolean', defaultValue: true },
];

test('editing inactive presets saves settings without selecting or changing playback', () => {
  const oldJson = makeDspPresetJson('rotate', controls);
  const state = {
    dspProviderPresetJson: oldJson,
    dspProviderPresetBank: { [dspPresetBankKey('engine', 'speaker', 'rotate')]: oldJson },
    dspProviderMode: 'headphone',
    impulseResponseEnabled: false,
  };
  const json = makeDspPresetJson('record', controls);
  const patch = dspPresetSettingsPatch(state, 'engine', json);
  assert.equal(Object.hasOwn(patch, 'dspProviderPresetJson'), false);
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'headphone', 'record')],
    json,
  );
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'speaker', 'rotate')],
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
  const defaults = makeDspPresetJson('rotate', controls);
  const state = {
    dspProviderPresetJson: defaults,
    dspProviderPresetBank: {},
    dspProviderMode: 'speaker',
    impulseResponseEnabled: false,
  };
  const changed = makeDspPresetJson(
    'rotate',
    controls,
    '{"presetId":"rotate","controls":{"speed":{"value":20}}}',
  );
  const patch = dspPresetSettingsPatch(state, 'engine', changed);
  assert.equal(patch.dspProviderPresetJson, changed);
  assert.equal(
    patch.dspProviderPresetBank?.[dspPresetBankKey('engine', 'speaker', 'rotate')],
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
    presetId: 'rotate',
    controls: { speed: { value: 5 }, obsolete: { value: 99 } },
  });
  const result = parseDspPreset(makeDspPresetJson('rotate', controls, saved));
  assert.equal(result.presetId, 'rotate');
  assert.deepEqual(result.controls, {
    speed: { value: 5 },
    scene: { value: 'loop' },
    enabled: { value: true },
  });
  assert.equal(
    parseDspPreset(makeDspPresetJson('another', controls, saved)).controls.speed.value,
    10,
  );
  assert.equal(makeDspPresetJson('fixed', []), '{"presetId":"fixed"}');
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
    presetControlValues(controls, '{"presetId":"x","controls":{"speed":{"value":999}}}').speed
      .value,
    10,
  );
});

test('defaults, visibility and engine/device/preset storage remain independent', () => {
  const values = presetControlValues(controls, '');
  assert.equal(
    controlVisible({ ...controls[0], visibleWhen: { controlId: 'scene', value: 'star' } }, values),
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

test('provider-owned controls only; saved __proto__ is data and cannot change prototypes', () => {
  assert.deepEqual(presetControlValues([{ ...controls[0], ownership: 'host' }], ''), {});
  assert.deepEqual(presetControlValues([{ ...controls[0], ownership: 'disabled' }], ''), {});
  const parsed = parseDspPreset('{"presetId":"x","controls":{"__proto__":{"value":1}}}');
  assert.equal(Object.getPrototypeOf(parsed.controls), Object.prototype);
  assert.equal(Object.hasOwn(parsed.controls, '__proto__'), true);
});

test('rotation engine upgrade adds bass and field defaults without losing saved speed', () => {
  const id = 'kugou-3d-rotation';
  const rotation: DspProviderControl[] = [
    controls[0],
    { id: 'bass', type: 'number', defaultValue: 0, range: { min: 0, max: 400, step: 1 } },
    { id: 'field', type: 'number', defaultValue: 0, range: { min: 0, max: 4, step: 1 } },
  ];
  const legacy = JSON.stringify({ presetId: id, controls: { speed: { value: 16 } } });
  const upgraded = makeDspPresetJson(id, rotation, legacy);
  assert.deepEqual(parseDspPreset(upgraded).controls, {
    speed: { value: 16 },
    bass: { value: 0 },
    field: { value: 0 },
  });
  const changed = makeDspPresetJson(
    id,
    rotation,
    JSON.stringify({
      presetId: id,
      controls: { speed: { value: 16 }, bass: { value: 200 }, field: { value: 3 } },
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
  assert.equal(makeDspPresetJson(id, rotation, patch.dspProviderPresetBank?.[key]), changed);
  const defaults = makeDspPresetJson(id, rotation);
  const reset = dspPresetSettingsPatch({ ...state, ...patch }, 'engine', defaults);
  assert.deepEqual(parseDspPreset(reset.dspProviderPresetJson!).controls, {
    speed: { value: 10 },
    bass: { value: 0 },
    field: { value: 0 },
  });
  assert.equal(validControlValue(rotation[1], 401), false);
  assert.equal(validControlValue(rotation[2], 5), false);
  assert.equal(validControlValue(rotation[2], 1.5), false);
});
