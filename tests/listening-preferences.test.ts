import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyPreferences,
  ensurePreferenceSuccess,
  parsePreferences,
  preferenceChanges,
  preferenceEqual,
  preferenceWeights,
  togglePreference,
  recommendationStrength,
  setRecommendationStrength,
  resetRecommendationPreferences,
  recommendationValidation,
  recommendationOptions,
} from '../src/shared/listeningPreferences.ts';

test('preference response preserves zero IDs and accepts string or object weights', () => {
  assert.deepEqual(
    parsePreferences({
      status: 1,
      error_code: 0,
      data: { age: 0, gender: '2', lang: { 1: 100 }, style: '' },
    }),
    { ...emptyPreferences(), age: '0', gender: '2', lang: '{"1":100}', style: '' },
  );
  for (const body of [null, {}, { status: 1 }, { status: 1, data: [] }, { status: 0, data: {} }]) {
    assert.throws(() => parsePreferences(body));
  }
  assert.throws(
    () => ensurePreferenceSuccess({ status: 1, error_code: 20018, errmsg: '请重新登录' }),
    /请重新登录/,
  );
});

test('editing known tags preserves unknown IDs and nonselected weights', () => {
  const initial = '{"1":100,"3":50,"777":83}';
  assert.deepEqual(preferenceWeights(togglePreference(initial, '1')), { 3: 50, 777: 83 });
  assert.deepEqual(preferenceWeights(togglePreference(initial, '3')), { 1: 100, 3: 100, 777: 83 });
  assert.equal(togglePreference('{"1":100}', '1'), '');
  assert.equal(togglePreference('', '1'), '{"1":100}');
});

test('invalid JSON cannot silently clear existing preferences', () => {
  for (const value of ['broken', 'null', '[]', '{"1":"100"}', '{"__proto__":100}']) {
    assert.equal(preferenceWeights(value), null);
    assert.equal(togglePreference(value, '1'), value);
  }
});

test('patches contain only changed fields, including intentional clears', () => {
  const baseline = { ...emptyPreferences(), gender: '2', age: '0', lang: '{"1":100,"9":65}' };
  assert.deepEqual(preferenceChanges(baseline, { ...baseline, style: '{"2":100}' }), {
    style: '{"2":100}',
  });
  assert.deepEqual(preferenceChanges(baseline, { ...baseline, age: '', lang: '' }), {
    age: '',
    lang: '',
  });
  assert.deepEqual(preferenceChanges(baseline, { ...baseline, lang: '{ "9":65, "1":100 }' }), {});
  assert.equal(preferenceEqual('style', '', '{}'), true);
});

test('recommendation intensity uses distinct H5 tags, neutral 50, and bounds 0–100', () => {
  assert.equal(recommendationStrength('', 'L1'), 50);
  assert.equal(recommendationStrength('{"S28":0}', 'S28'), 0);
  assert.deepEqual(preferenceWeights(setRecommendationStrength('{"X99":72}', 'L1', 200)), {
    X99: 72,
    L1: 100,
  });
  assert.equal(setRecommendationStrength('broken', 'L1', 40), 'broken');
  assert.equal(setRecommendationStrength('', 'X99', 40), '');
  assert.equal(preferenceEqual('song_lang', '', '{"L1":50}'), true);
  assert.equal(preferenceEqual('mode', '', '0'), true);
  assert.equal(preferenceEqual('mode', '1', '0'), false);
});

test('restore defaults keeps basic preferences and unknown recommendation tags', () => {
  const initial = {
    ...emptyPreferences(),
    mode: '2',
    gender: '1',
    age: '0',
    lang: '{"1":100}',
    song_lang: '{"L1":90,"S28":0,"X99":22}',
  };
  const reset = resetRecommendationPreferences(initial);
  assert.equal(reset.mode, '0');
  assert.equal(reset.lang, initial.lang);
  assert.equal(reset.gender, initial.gender);
  assert.equal(reset.age, initial.age);
  const weights = preferenceWeights(reset.song_lang);
  assert.equal(weights.X99, 22);
  for (const option of recommendationOptions) assert.equal(weights[option.value], 50);
  assert.deepEqual(preferenceChanges(reset, resetRecommendationPreferences(reset)), {});
});

test('official recommendation constraints prevent all languages blocked and DJ/cover conflicts', () => {
  assert.match(
    recommendationValidation({
      ...emptyPreferences(),
      song_lang: '{"L1":0,"L2":0,"L5":0,"L4":0,"L3":0,"L6":0}',
    }),
    /至少保留/,
  );
  assert.match(
    recommendationValidation({ ...emptyPreferences(), song_lang: '{"S9":75,"T1":0}' }),
    /翻唱/,
  );
  assert.equal(
    recommendationValidation({ ...emptyPreferences(), song_lang: '{"S9":50,"T1":0}' }),
    '',
  );
  assert.equal(recommendationValidation(emptyPreferences()), '');
});
