import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoundedWindowShape } from '../src/main/window/roundedShape.ts';

test('rounded shape removes corners while preserving a continuous symmetric window', () => {
  for (const [width, height] of [
    [1150, 750],
    [1725, 1125],
    [10, 6],
  ]) {
    const rects = buildRoundedWindowShape(width, height);
    const spans = Array.from({ length: height }, (_, y) =>
      rects.filter((rect) => y >= rect.y && y < rect.y + rect.height),
    );
    assert.ok(
      spans.every((row) => row.length === 1),
      'every row is covered exactly once',
    );
    assert.ok(spans[0][0].x > 0, 'top corners are excluded');
    for (let y = 0; y < height; y++) {
      const rect = spans[y][0];
      assert.equal(rect.x * 2 + rect.width, width, 'left/right symmetry');
      assert.equal(rect.x, spans[height - 1 - y][0].x, 'top/bottom symmetry');
      assert.ok(rect.width > 0);
    }
  }
});

test('zero-radius and degenerate windows use the default rectangular shape', () => {
  assert.deepEqual(buildRoundedWindowShape(1100, 750, 0), []);
  assert.deepEqual(buildRoundedWindowShape(0, 0), []);
});
