import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLatestRequestQueue } from '../src/shared/latest-request-queue.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test('serializes calls and coalesces pending settings without applying stale failures', async () => {
  const first = deferred(),
    last = deferred();
  const calls: number[] = [],
    applied: number[] = [],
    failed: number[] = [];
  const queue = createLatestRequestQueue<number>({
    apply: (value) => {
      calls.push(value);
      return value === 1 ? first.promise : last.promise;
    },
    applied: async (value) => {
      applied.push(value);
    },
    failed: (value) => {
      failed.push(value);
    },
    report: assert.fail,
  });
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  assert.deepEqual(calls, [1]);
  first.reject(new Error('stale command'));
  await tick();
  assert.deepEqual(calls, [1, 3]);
  assert.deepEqual(failed, []);
  last.resolve();
  await tick();
  assert.deepEqual(applied, [3]);
});
test('a latest failure may enqueue recovery, while diagnostic failures do not disable audio', async () => {
  const applied: number[] = [],
    failed: number[] = [],
    reported: unknown[] = [];
  const queue = createLatestRequestQueue<number>({
    apply: async (value) => {
      if (value === 1) throw new Error('audio');
    },
    applied: async (value) => {
      applied.push(value);
      throw new Error('diagnostics');
    },
    failed: (value) => {
      failed.push(value);
      queue.enqueue(2);
    },
    report: (error) => {
      reported.push(error);
    },
  });
  queue.enqueue(1);
  await tick();
  assert.deepEqual(failed, [1]);
  assert.deepEqual(applied, [2]);
  assert.equal(reported.length, 1);
});
test('new settings submitted during diagnostics are applied after refresh completes', async () => {
  const refresh = deferred(),
    calls: number[] = [];
  const queue = createLatestRequestQueue<number>({
    apply: async (value) => {
      calls.push(value);
    },
    applied: (value) => (value === 1 ? refresh.promise : Promise.resolve()),
    failed: assert.fail,
    report: assert.fail,
  });
  queue.enqueue(1);
  await tick();
  queue.enqueue(2);
  queue.enqueue(3);
  assert.deepEqual(calls, [1]);
  refresh.resolve();
  await tick();
  assert.deepEqual(calls, [1, 3]);
});
