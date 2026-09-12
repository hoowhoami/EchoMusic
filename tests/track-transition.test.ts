import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampFadeCrossSecs,
  normalizeTrackTransitionMode,
  TRACK_TRANSITION_OPTIONS,
  transitionOverlapsTracks,
  transitionPrefetchLeadSecs,
  transitionPreparesNextTrack,
} from '../src/shared/track-transition.ts';

test('options mirror the QQ Music transition choices', () => {
  assert.deepEqual(
    TRACK_TRANSITION_OPTIONS.map((option) => option.value),
    ['automix-pro', 'automix-basic', 'fade', 'gapless', 'none'],
  );
  for (const option of TRACK_TRANSITION_OPTIONS) {
    assert.ok(option.label.length > 0);
    assert.ok(option.description.length > 0);
  }
});

test('fade length is clamped to the 0–15 s slider', () => {
  assert.equal(clampFadeCrossSecs(40), 15);
  assert.equal(clampFadeCrossSecs(-3), 0);
  assert.equal(clampFadeCrossSecs(7.6), 8);
  assert.equal(clampFadeCrossSecs('12'), 12);
  assert.equal(clampFadeCrossSecs(Number.NaN), 5);
  assert.equal(clampFadeCrossSecs(undefined), 5);
});

test('unknown persisted modes fall back to the first option', () => {
  assert.equal(normalizeTrackTransitionMode('automix-pro'), 'automix-pro');
  assert.equal(normalizeTrackTransitionMode('none'), 'none');
  assert.equal(normalizeTrackTransitionMode('bogus'), 'automix-pro');
  assert.equal(normalizeTrackTransitionMode(undefined), 'automix-pro');
});

test('prefetch lead grows with the overlap requirements of each mode', () => {
  assert.equal(transitionPrefetchLeadSecs('none', 5), 0);
  assert.equal(transitionPrefetchLeadSecs('gapless', 5), 30);
  assert.equal(transitionPrefetchLeadSecs('fade', 15), 45);
  assert.equal(transitionPrefetchLeadSecs('automix-basic', 5), 75);
  assert.equal(transitionPrefetchLeadSecs('automix-pro', 5), 75);
  assert.ok(transitionPreparesNextTrack('gapless'));
  assert.ok(!transitionPreparesNextTrack('none'));
  assert.ok(transitionOverlapsTracks('fade'));
  assert.ok(!transitionOverlapsTracks('gapless'));
});
