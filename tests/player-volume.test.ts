import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePlayerVolume } from '../src/shared/playback.ts';

test('mini player volume keeps values on the shared 0–100 percentage scale', () => {
  assert.equal(normalizePlayerVolume(0), 0);
  assert.equal(normalizePlayerVolume(1), 1);
  assert.equal(normalizePlayerVolume(37.5), 37.5);
  assert.equal(normalizePlayerVolume(100), 100);
});

test('player volume is clamped at the percentage boundaries', () => {
  assert.equal(normalizePlayerVolume(-5), 0);
  assert.equal(normalizePlayerVolume(105), 100);
  assert.equal(normalizePlayerVolume(Number.NaN), 0);
});
