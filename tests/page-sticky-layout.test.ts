import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPageStickyLayout } from '../src/renderer/utils/pageStickyLayout.ts';

test('fast jumps in both directions keep the scroller barrier below both detail headers', () => {
  for (const scrollTop of [0, 5, 50, 170, 174, 180, 5000, 320, 20, 0]) {
    const expanded = Math.max(56, 230 - scrollTop);
    const plan = planPageStickyLayout(
      [
        { naturalTop: -scrollTop, stickyTop: 0, visualHeight: expanded, marginTop: 0 },
        { naturalTop: 230 - scrollTop, stickyTop: expanded, visualHeight: 94, marginTop: 0 },
      ],
      600,
    );
    assert.deepEqual(plan.tops, [0, expanded]);
    assert.equal(plan.inset, expanded + 94);
    // Native scrolling can move rows anywhere; no row can paint above this barrier.
    assert.ok(plan.tops.every((top, i) => top + (i ? 94 : expanded) <= plan.inset));
  }
});

test('an unpinned FM card does not hide the intervening scrolling content', () => {
  const plan = planPageStickyLayout(
    [
      { naturalTop: 0, stickyTop: 0, visualHeight: 56, marginTop: 0 },
      { naturalTop: 150, stickyTop: 56, visualHeight: 260, marginTop: 0 },
    ],
    600,
  );
  assert.deepEqual(plan, { tops: [0, 150], inset: 56 });
});

test('stacked search toolbars share one continuous barrier', () => {
  const plan = planPageStickyLayout(
    [
      { naturalTop: -300, stickyTop: 0, visualHeight: 48, marginTop: 0 },
      { naturalTop: -200, stickyTop: 48, visualHeight: 52, marginTop: 0 },
      { naturalTop: -148, stickyTop: 100, visualHeight: 44, marginTop: 0 },
    ],
    600,
  );
  assert.deepEqual(plan, { tops: [0, 48, 100], inset: 144 });
});

test('removing a conditional header restores the viewport, and small windows clamp the barrier', () => {
  assert.deepEqual(planPageStickyLayout([], 600), { tops: [], inset: 0 });
  assert.equal(
    planPageStickyLayout([{ naturalTop: 0, stickyTop: 0, visualHeight: 300, marginTop: 0 }], 200)
      .inset,
    200,
  );
});
