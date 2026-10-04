import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/renderer/utils/PagedSongLoader.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  () => ({ debug() {}, info() {}, warn() {} }),
  module,
  module.exports,
);
const { PagedSongLoader } = module.exports;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('waiter did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const page = (items, hasMore = false) => ({ items, hasMore });

test('concurrent first-page/all/remaining calls fetch each page once and publish ordered data', async () => {
  const first = deferred();
  const calls = [],
    published = [];
  const loader = new PagedSongLoader(
    async (number) => {
      calls.push(number);
      return number === 1 ? first.promise : page([number], number < 3);
    },
    { concurrency: 2, onPageLoaded: (_, __, number) => published.push(number) },
  );
  const a = loader.loadFirstPage(),
    b = loader.loadAll(),
    c = loader.loadRemaining(),
    d = loader.loadAll();
  first.resolve(page([1], true));
  await Promise.all([a, b, c, d]);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(published, [1, 2, 3]);
  assert.deepEqual(loader.items, [1, 2, 3]);
});

test('completed loads are reusable without refetching or calling onComplete twice', async () => {
  let reads = 0,
    completed = 0;
  const loader = new PagedSongLoader(
    async () => {
      reads += 1;
      return page([1]);
    },
    {
      onComplete: () => {
        completed += 1;
      },
    },
  );
  await loader.loadAll();
  await Promise.all([loader.loadAll(), loader.loadFirstPage(), loader.loadRemaining()]);
  assert.equal(reads, 1);
  assert.equal(completed, 1);
});

for (const rejected of [false, true]) {
  test(`reset settles old waiters and ignores a late ${rejected ? 'failure' : 'success'} without ending a new load`, async () => {
    const old = deferred(),
      fresh = deferred();
    let reads = 0,
      errors = 0;
    const published = [];
    const loader = new PagedSongLoader(() => (++reads === 1 ? old.promise : fresh.promise), {
      onPageLoaded: (items) => published.push([...items]),
      onError: () => {
        errors += 1;
      },
    });
    const a = loader.loadAll(),
      waiting = loader.waitForAll();
    loader.reset();
    const b = loader.loadAll();
    const oldSnapshot = await bounded(waiting);
    assert.deepEqual(oldSnapshot, []);
    if (rejected) old.reject(new Error('old failure'));
    else old.resolve(page([1]));
    assert.deepEqual(await a, []);
    assert.equal(loader.loading, true);
    assert.equal(loader.failed, false);
    assert.equal(errors, 0);
    assert.deepEqual(published, []);
    fresh.resolve(page([2]));
    await b;
    assert.deepEqual(loader.items, [2]);
    assert.deepEqual(oldSnapshot, []);
  });
}

test('reset during remaining-page fetching does not append or complete the new cycle', async () => {
  const old = deferred(),
    fresh = deferred();
  let cycle = 0;
  const completed = [];
  const loader = new PagedSongLoader(
    async (number) =>
      cycle === 0 ? (number === 1 ? page([1], true) : old.promise) : fresh.promise,
    { concurrency: 1, onComplete: (items) => completed.push([...items]) },
  );
  const a = loader.loadAll();
  await flush();
  const waiting = loader.waitForAll();
  loader.reset();
  cycle += 1;
  const b = loader.loadAll();
  assert.deepEqual(await bounded(waiting), [1]);
  old.resolve(page([9]));
  assert.deepEqual(await a, [1]);
  assert.deepEqual(loader.items, []);
  assert.equal(loader.loading, true);
  assert.deepEqual(completed, []);
  fresh.resolve(page([2]));
  await b;
  assert.deepEqual(completed, [[2]]);
});

test('duplicate-only pages do not hide later unique songs', async () => {
  const loader = new PagedSongLoader(async (number) => page(number < 3 ? [1] : [2], number < 3), {
    dedupeKey: String,
    concurrency: 1,
  });
  await loader.loadAll();
  assert.deepEqual(loader.items, [1, 2]);
  assert.equal(loader.loadedPages, 3);
  assert.equal(loader.fullyLoaded, true);
});

for (const maxPages of [1, 3]) {
  test(`maxPages=${maxPages} resolves partial waiters as failed without claiming a complete snapshot`, async () => {
    const completed = [],
      errors = [];
    const loader = new PagedSongLoader(async (number) => page([number], true), {
      maxPages,
      concurrency: 2,
      onComplete: (items) => completed.push([...items]),
      onError: (error) => errors.push(error),
    });
    const waiting = loader.waitForAll();
    await loader.loadAll();
    assert.equal(loader.loadedPages, maxPages);
    assert.equal(loader.fullyLoaded, false);
    assert.equal(loader.failed, true);
    assert.equal(loader.loading, false);
    assert.equal(errors.length, 1);
    assert.deepEqual(completed, []);
    assert.equal((await bounded(waiting)).length, maxPages);
  });
}

test('a terminal page exactly at the limit remains a successful complete snapshot', async () => {
  const loader = new PagedSongLoader(async (number) => page([number], number < 3), {
    maxPages: 3,
    concurrency: 2,
  });
  await loader.loadAll();
  assert.equal(loader.fullyLoaded, true);
  assert.equal(loader.failed, false);
});

for (const stage of ['page', 'complete', 'error']) {
  test(`a throwing ${stage} callback still settles waiting callers`, async () => {
    const loader = new PagedSongLoader(
      async () => {
        if (stage === 'error') throw new Error('fetch error');
        return page([1]);
      },
      {
        onPageLoaded: () => {
          if (stage === 'page') throw new Error('page error');
        },
        onComplete: () => {
          if (stage === 'complete') throw new Error('complete error');
        },
        onError: () => {
          throw new Error('error callback');
        },
      },
    );
    const waiting = loader.waitForAll();
    await bounded(loader.loadAll());
    await bounded(waiting);
    assert.equal(loader.failed, true);
    assert.equal(loader.loading, false);
    assert.equal(loader.fullyLoaded, false);
  });
}

for (const stage of ['page', 'complete', 'error']) {
  test(`a reset from the ${stage} callback cannot release or alter the next cycle`, async () => {
    const fresh = deferred();
    let reset = false,
      next;
    const restart = () => {
      if (reset) return;
      reset = true;
      loader.reset();
      next = loader.loadAll();
    };
    const loader = new PagedSongLoader(
      async () => {
        if (reset) return fresh.promise;
        if (stage === 'error') throw new Error('old error');
        return page([1]);
      },
      {
        onPageLoaded: stage === 'page' ? restart : undefined,
        onComplete: stage === 'complete' ? restart : undefined,
        onError: stage === 'error' ? restart : undefined,
      },
    );
    await bounded(loader.loadAll());
    assert.equal(loader.loading, true);
    assert.equal(loader.failed, false);
    assert.equal(loader.fullyLoaded, false);
    fresh.resolve(page([2]));
    await next;
    assert.deepEqual(loader.items, [2]);
  });
}

test('abort resolves waiters and ignores late responses without triggering completion', async () => {
  const pending = deferred();
  let completed = 0;
  const loader = new PagedSongLoader(() => pending.promise, {
    onComplete: () => {
      completed += 1;
    },
  });
  const operation = loader.loadAll(),
    waiting = loader.waitForAll();
  loader.abort();
  await bounded(waiting);
  pending.resolve(page([1]));
  await operation;
  assert.equal(completed, 0);
  assert.equal(loader.loading, false);
  assert.deepEqual(loader.items, []);
});

test('invalid page sizes fall back to a positive integer and fractional sizes are rounded down', async () => {
  for (const [size, expected] of [
    [0, 200],
    [-1, 200],
    [NaN, 200],
    [Infinity, 200],
    [3.8, 3],
  ]) {
    let actual;
    const loader = new PagedSongLoader(
      async (_, pageSize) => {
        actual = pageSize;
        return page([]);
      },
      { pageSize: size },
    );
    await loader.loadAll();
    assert.equal(actual, expected);
  }
});

test('prefetch results retain page order and ignore failures beyond the terminal page', async () => {
  const loader = new PagedSongLoader(
    async (number) => {
      if (number === 3) throw new Error('past end');
      return page([number], number < 2);
    },
    { concurrency: 2 },
  );
  await loader.loadAll();
  assert.deepEqual(loader.items, [1, 2]);
  assert.equal(loader.failed, false);
});

test('a synchronous fetch failure with an onError reset preserves the new first-page flight', async () => {
  const fresh = deferred();
  let reads = 0,
    next;
  const loader = new PagedSongLoader(
    () => {
      reads += 1;
      if (reads === 1) throw new Error('sync failure');
      return fresh.promise;
    },
    {
      onError: () => {
        loader.reset();
        next = loader.loadAll();
      },
    },
  );
  await bounded(loader.loadAll());
  const first = loader.loadFirstPage();
  assert.equal(reads, 2);
  fresh.resolve(page([2]));
  await Promise.all([next, first]);
  assert.deepEqual(loader.items, [2]);
});

test('filtered empty pages with hasMore=true do not hide subsequent valid songs', async () => {
  const calls = [];
  const loader = new PagedSongLoader(
    async (number) => {
      calls.push(number);
      return page(number < 3 ? [] : [1], number < 3);
    },
    { concurrency: 1 },
  );
  await loader.loadFirstPage();
  assert.equal(loader.fullyLoaded, false);
  await loader.loadRemaining();
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(loader.items, [1]);
  assert.equal(loader.fullyLoaded, true);
});
