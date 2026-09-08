import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createListeningSession, type ListeningIdentity } from '../src/shared/listening-session.ts';

function fixture() {
  let now = 0;
  const calls: { event: string; id: ListeningIdentity; duration?: number; state?: string }[] = [];
  const session = createListeningSession({
    now: () => now,
    start: async (id) => {
      calls.push({ event: 'start', id });
      return true;
    },
    end: async (id, duration, state) => {
      calls.push({ event: 'end', id, duration, state });
    },
    onError: (error) => {
      throw error;
    },
  });
  const id = { account: 'a', track: 'song', mixsongid: 1 };
  return {
    session,
    calls,
    id,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('actual listening time handles rate, seek, stalled progress and suspension', async () => {
  const { session, calls, id, advance } = fixture();
  session.tick(id, 0, 2);
  advance(1000);
  session.tick(id, 2, 2);
  advance(1000);
  session.tick(id, 100, 2); // forward seek, no reset notification
  advance(1000);
  session.tick(id, 100, 2); // stalled
  session.resetPosition();
  advance(1000);
  session.tick(id, 20, 2); // explicit seek
  advance(1000);
  session.tick(id, 22, 2);
  advance(60000);
  session.tick(id, 142, 2); // sleep gap
  await session.flush('完整播放');
  assert.deepEqual(
    calls.map((c) => c.event),
    ['start', 'end'],
  );
  assert.equal(calls[1].duration, 2000);
});

test('pause/resume and track/account switches produce ordered independent pairs', async () => {
  const { session, calls, id, advance } = fixture();
  session.tick(id, 0, 1);
  advance(1000);
  session.tick(id, 1, 1);
  void session.flush('暂停');
  advance(10000);
  session.tick(id, 1, 1);
  advance(1000);
  session.tick(id, 2, 1);
  session.tick({ ...id, track: 'next', mixsongid: 2 }, 0, 1);
  advance(1000);
  session.tick({ ...id, track: 'next', mixsongid: 2 }, 1, 1);
  session.tick({ ...id, account: 'b' }, 0, 1);
  await session.flush();
  assert.deepEqual(
    calls.map((c) => c.event),
    ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'],
  );
  assert.deepEqual(
    calls.filter((c) => c.event === 'end').map((c) => c.duration),
    [1000, 1000, 1000, 0],
  );
});

test('long tracks keep one start/end pair and duplicate flushes do not resend', async () => {
  const { session, calls, id, advance } = fixture();
  session.tick(id, 0, 1);
  for (let second = 1; second <= 181; second++) {
    advance(1000);
    session.tick(id, second, 1);
  }
  await session.flush();
  await session.flush();
  assert.equal(calls.filter((c) => c.event === 'end').length, 1);
  assert.equal(calls[1].duration, 181000);
});

test('failed start preserves the real listening report and failed requests are not replayed', async () => {
  let starts = 0;
  let ends = 0;
  let errors = 0;
  const session = createListeningSession({
    now: () => 0,
    start: async () => {
      if (++starts === 1) throw new Error('start');
      return true;
    },
    end: async () => {
      ends++;
      throw new Error('end');
    },
    onError: () => {
      errors++;
    },
  });
  const id = { account: 'a', track: 'song', mixsongid: 1 };
  session.tick(id, 0, 1);
  await session.flush();
  assert.equal(ends, 1);
  session.tick(id, 0, 1);
  await session.flush();
  await session.flush();
  assert.equal(ends, 2);
  assert.equal(errors, 3);
});

test('pause preserves a single event pair and excludes paused wall time', async () => {
  const { session, calls, id, advance } = fixture();
  session.tick(id, 0, 1);
  advance(1000);
  session.tick(id, 1, 1);
  session.resetPosition();
  advance(60000);
  session.tick(id, 1, 1);
  advance(1000);
  session.tick(id, 2, 1);
  await session.flush('完整播放');
  assert.deepEqual(
    calls.map((c) => c.event),
    ['start', 'end'],
  );
  assert.equal(calls[1].duration, 2000);
});

test('gapless completion survives subsequent trackchange and precedes next start', async () => {
  const { session, calls, id, advance } = fixture();
  session.tick(id, 0, 1);
  advance(1000);
  session.tick(id, 1, 1);
  void session.flush('完整播放');
  void session.flush('中断播放');
  session.tick({ ...id, track: 'next', mixsongid: 2 }, 0, 1);
  await session.flush();
  assert.deepEqual(
    calls.map((c) => c.event),
    ['start', 'end', 'start', 'end'],
  );
  assert.equal(calls[1].state, '完整播放');
  assert.equal(calls[1].id.mixsongid, 1);
  assert.equal(calls[2].id.mixsongid, 2);
});
