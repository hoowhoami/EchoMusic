import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioSpectrumOptionsIncludeWaveform,
  filterAudioSpectrumFrameForSubscriber,
  mergeAudioSpectrumOptions,
  normalizeAudioSpectrumWaveform,
} from '../src/shared/audioSpectrum.ts';

test('enables waveform generation when any spectrum subscriber requests it', () => {
  assert.equal(audioSpectrumOptionsIncludeWaveform([]), false);
  assert.equal(
    audioSpectrumOptionsIncludeWaveform([
      { includeWaveform: false },
      undefined,
      { includeWaveform: true },
    ]),
    true,
  );
});

test('sends waveform payloads only to subscribers that requested them', () => {
  const frame = {
    source: 'player' as const,
    state: 'playing' as const,
    timestamp: 1,
    timePos: 1,
    sampleRate: 48_000,
    fftSize: 2048,
    minFrequency: 20,
    maxFrequency: 20_000,
    bins: [0.5],
    waveform: [-0.5, 0.5],
    rms: 0.5,
    peak: 0.8,
  };

  assert.equal(filterAudioSpectrumFrameForSubscriber(frame, true), frame);
  assert.equal(filterAudioSpectrumFrameForSubscriber(frame, false).waveform, undefined);
  assert.deepEqual(filterAudioSpectrumFrameForSubscriber(frame, false).bins, [0.5]);
});

test('normalizes requested waveform samples and omits unrequested data', () => {
  assert.equal(normalizeAudioSpectrumWaveform([0.5], false), undefined);
  assert.equal(normalizeAudioSpectrumWaveform('invalid', true), undefined);
  assert.deepEqual(
    normalizeAudioSpectrumWaveform([-2, -0.25, 'bad', 0.5, 3], true),
    [-1, -0.25, 0, 0.5, 1],
  );
});

test('falls back to default spectrum options when nobody subscribes', () => {
  assert.deepEqual(mergeAudioSpectrumOptions([]), {
    fps: 30,
    binCount: 128,
    fftSize: 2048,
    smoothing: 0.65,
    minFrequency: 20,
    maxFrequency: 20000,
    scale: 'log',
    includeWaveform: false,
  });
});

test('merges subscribers by taking the most demanding option of each kind', () => {
  const merged = mergeAudioSpectrumOptions([
    { fps: 30, binCount: 128, minFrequency: 40, maxFrequency: 16000, smoothing: 0.8 },
    { fps: 60, binCount: 512, minFrequency: 20, maxFrequency: 20000, smoothing: 0.2 },
  ]);

  assert.equal(merged.fps, 60);
  assert.equal(merged.binCount, 512);
  assert.equal(merged.minFrequency, 20);
  assert.equal(merged.maxFrequency, 20000);
  assert.equal(merged.smoothing, 0.2);
});

test('clamps out-of-range and non-finite spectrum options', () => {
  const merged = mergeAudioSpectrumOptions([
    { fps: 9999, binCount: 1, minFrequency: 0, maxFrequency: 999999, smoothing: 5 },
    { fps: Number.NaN, binCount: Number.POSITIVE_INFINITY },
  ]);

  assert.equal(merged.fps, 60);
  assert.equal(merged.binCount, 8);
  assert.equal(merged.minFrequency, 1);
  assert.equal(merged.maxFrequency, 24000);
  assert.equal(merged.smoothing, 0.95);
});

test('ignores undefined entries so a paused subscriber cannot raise the shared rate', () => {
  // 暂停的订阅会以 undefined 传入：它不得抬高 fps/binCount，也不得强制生成 waveform。
  const merged = mergeAudioSpectrumOptions([
    undefined,
    { fps: 60, binCount: 512, includeWaveform: true },
    undefined,
  ]);

  assert.deepEqual(mergeAudioSpectrumOptions([undefined, undefined]), {
    fps: 30,
    binCount: 128,
    fftSize: 2048,
    smoothing: 0.65,
    minFrequency: 20,
    maxFrequency: 20000,
    scale: 'log',
    includeWaveform: false,
  });
  assert.equal(merged.includeWaveform, true);
  assert.equal(merged.fps, 60);
});

test('a lone low-rate subscriber keeps the shared rate low once others are paused', () => {
  const active = mergeAudioSpectrumOptions([{ fps: 30, binCount: 256 }]);
  assert.equal(active.fps, 30);
  assert.equal(active.binCount, 256);
});
