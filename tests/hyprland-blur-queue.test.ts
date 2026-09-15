import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHyprlandBlurQueue } from '../src/main/window/hyprlandBlurQueue.ts';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('normal settings sync deduplicates, but showing the window re-applies transparency', async () => {
  const calls: boolean[] = [];
  const queue = createHyprlandBlurQueue(
    async (enabled) => {
      calls.push(enabled);
    },
    () => false,
    () => assert.fail('unexpected compositor error'),
  );
  queue.setBlurEnabled(false);
  await nextTurn();
  queue.setBlurEnabled(false);
  await nextTurn();
  assert.deepEqual(calls, [false]);
  queue.setBlurEnabled(false, true);
  await nextTurn();
  assert.deepEqual(calls, [false, false]);
});

test('remap during an in-flight update re-applies to the new surface', async () => {
  const calls: boolean[] = [];
  let finishFirst: (() => void) | undefined;
  const queue = createHyprlandBlurQueue(
    async (enabled) => {
      calls.push(enabled);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
    },
    () => false,
    () => assert.fail('unexpected compositor error'),
  );
  queue.setBlurEnabled(false);
  queue.setBlurEnabled(false, true);
  finishFirst?.();
  await nextTurn();
  assert.deepEqual(calls, [false, false]);
});

test('a settings change while applying the old mode wins after remap', async () => {
  const calls: boolean[] = [];
  let finishFirst: (() => void) | undefined;
  const queue = createHyprlandBlurQueue(
    async (enabled) => {
      calls.push(enabled);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
    },
    () => false,
    () => assert.fail('unexpected compositor error'),
  );
  queue.setBlurEnabled(false);
  queue.setBlurEnabled(false, true);
  queue.setBlurEnabled(true);
  finishFirst?.();
  await nextTurn();
  assert.deepEqual(calls, [false, true]);
});

test('a window that is not yet in Hyprland clients retries its selected mode', async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const queue = createHyprlandBlurQueue(
    async () => {
      if (++attempts === 1) throw new Error('window not mapped yet');
    },
    () => false,
    (error) => errors.push(error),
    0,
  );
  queue.setBlurEnabled(false);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});
