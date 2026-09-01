import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioSpectrumOptionsIncludeWaveform,
  filterAudioSpectrumFrameForSubscriber,
  normalizeAudioSpectrumWaveform,
} from '../src/shared/audio-spectrum.ts';

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
