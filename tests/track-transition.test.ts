import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampFadeCrossSecs,
  formatTrackTransitionNotice,
  normalizeTrackTransitionMode,
  TRACK_TRANSITION_OPTIONS,
  transitionOverlapsTracks,
  transitionPrefetchLeadSecs,
  transitionPreparesNextTrack,
  transitionPreparationTimeoutSecs,
} from '../src/shared/track-transition.ts';

test('preparation has its own budget capped by the outgoing playback deadline', () => {
  assert.equal(transitionPreparationTimeoutSecs('automix-pro', 75, 1), 60);
  assert.equal(transitionPreparationTimeoutSecs('automix-basic', 75, 1), 60);
  assert.equal(transitionPreparationTimeoutSecs('fade', 35, 1), 20);
  assert.equal(transitionPreparationTimeoutSecs('gapless', 30, 1), 20);
  assert.equal(transitionPreparationTimeoutSecs('automix-pro', 10, 2), 3);
  assert.equal(transitionPreparationTimeoutSecs('automix-pro', 1.8, 1), 0);
  assert.equal(transitionPreparationTimeoutSecs('none', 75, 1), 0);
  assert.equal(transitionPreparationTimeoutSecs('gapless', Number.NaN, 1), 0);
  assert.equal(transitionPreparationTimeoutSecs('gapless', 30, Number.NaN), 20);
});

test('transition options keep stable mode values and behavior-based labels', () => {
  assert.deepEqual(
    TRACK_TRANSITION_OPTIONS.map((option) => option.value),
    ['automix-pro', 'automix-basic', 'fade', 'gapless', 'none'],
  );
  assert.deepEqual(
    TRACK_TRANSITION_OPTIONS.map((option) => option.label),
    ['节奏融合', '自然衔接', '淡入淡出', '无缝播放', '关闭'],
  );
  for (const option of TRACK_TRANSITION_OPTIONS) {
    assert.ok(option.label.length > 0);
    assert.ok(option.description.length > 0);
  }
});

test('playback notices describe the executed transition and incoming cue', () => {
  assert.equal(
    formatTrackTransitionNotice({ mode: 'gapless', overlapSecs: 0 }, 0.84),
    '无缝 · 跳过 0.8 秒',
  );
  assert.equal(
    formatTrackTransitionNotice({ mode: 'automix-pro', overlapSecs: 5 }, 1.26),
    '节奏融合 · 5 秒 · 跳过 1.3 秒',
  );
  assert.equal(
    formatTrackTransitionNotice({ mode: 'automix-basic', overlapSecs: 3.5 }, 0),
    '自然衔接 · 3.5 秒',
  );
  assert.equal(formatTrackTransitionNotice({ mode: 'fade', overlapSecs: 4 }, 0), '淡入淡出 · 4 秒');
});

test('ordinary loads have no notice and invalid or tiny durations are omitted', () => {
  assert.equal(formatTrackTransitionNotice(undefined, 3), null);
  assert.equal(formatTrackTransitionNotice({ mode: 'none', overlapSecs: 0 }, 0), null);
  assert.equal(formatTrackTransitionNotice({ mode: 'gapless', overlapSecs: 0 }, 0.01), '无缝');
  assert.equal(
    formatTrackTransitionNotice({ mode: 'fade', overlapSecs: Number.NaN }, -1),
    '淡入淡出',
  );
});

test('fade duration stays within the supported 0–15 seconds', () => {
  assert.equal(clampFadeCrossSecs(40), 15);
  assert.equal(clampFadeCrossSecs(-3), 0);
  assert.equal(clampFadeCrossSecs(7.6), 8);
  assert.equal(clampFadeCrossSecs('12'), 12);
  assert.equal(clampFadeCrossSecs(Number.NaN), 15);
  assert.equal(clampFadeCrossSecs(undefined), 15);
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
