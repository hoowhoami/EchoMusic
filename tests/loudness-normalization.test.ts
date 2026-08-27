import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateNormalizationGainDb, resolveTrackLoudness } from '../src/shared/loudness.ts';

test('real Kugou negative dB peak metadata is accepted', () => {
  assert.deepEqual(
    resolveTrackLoudness({
      volume: -9.4,
      volume_gain: 0,
      volume_peak: -0.1,
    }),
    { lufs: -9.4, gain: 0, peak: -0.1 },
  );
});

test('missing peak remains unknown instead of pretending to be a full-scale peak', () => {
  assert.deepEqual(resolveTrackLoudness({ data: { volume: -12.6 } }), {
    lufs: -12.6,
    gain: 0,
    peak: null,
  });
});

test('target loudness uses the LUFS delta without compounding upstream gain metadata', () => {
  const loudness = { lufs: -9.4, gain: -4, peak: -0.1 };
  assert.ok(Math.abs(calculateNormalizationGainDb(loudness, -14) - -4.6) < 0.000_001);
  assert.ok(Math.abs(calculateNormalizationGainDb(loudness, -20) - -10.6) < 0.000_001);
});

test('positive target adjustment respects the reported dB peak ceiling', () => {
  const loudness = { lufs: -15, gain: 0, peak: -0.1 };
  assert.ok(Math.abs(calculateNormalizationGainDb(loudness, -14) - -0.4) < 0.000_001);
});
