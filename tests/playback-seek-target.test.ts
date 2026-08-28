import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesPendingSeekTarget } from '../src/shared/playback.ts';

test('rejects an obsolete native seek position while a newer target is pending', () => {
  assert.equal(matchesPendingSeekTarget(40, 118.7), false);
  assert.equal(matchesPendingSeekTarget(40, 40.00002), true);
});

test('accepts normal playback positions when no seek target is pending', () => {
  assert.equal(matchesPendingSeekTarget(null, 118.7), true);
  assert.equal(matchesPendingSeekTarget(undefined, 118.7), true);
});

test('does not treat a context-free completion as the pending seek result', () => {
  assert.equal(matchesPendingSeekTarget(40, undefined), false);
});
