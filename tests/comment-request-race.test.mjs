import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const code = transformSync(
  readFileSync(new URL('../src/renderer/composables/useComments.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const calls = [],
    vip = [],
    failures = [];
  const api = Object.fromEntries(
    [
      'getMusicComments',
      'getPlaylistComments',
      'getAlbumComments',
      'getMusicClassifyComments',
      'getMusicHotwordComments',
      'getFloorComments',
    ].map((method) => [
      method,
      (...args) => {
        const task = deferred();
        calls.push({ method, args, ...task });
        return task.promise;
      },
    ]),
  );
  const deps = {
    vue,
    '@/api/comment': api,
    '@/utils/mappers': { mapCommentItem: (item) => item },
    '@/utils/commentVipCache': {
      enrichCommentsWithYoungVip: (items) => {
        const task = deferred();
        vip.push({ items, ...task });
        return task.promise;
      },
    },
    '@/stores/toast': { useToastStore: () => ({ loadFailed: (type) => failures.push(type) }) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    mod,
    mod.exports,
  );
  return {
    calls,
    vip,
    failures,
    comments: mod.exports.useComments({
      resourceId: 'a',
      mixSongId: 'mix-a',
      resourceType: 'music',
    }),
    floor: mod.exports.useFloorComments('music'),
  };
}
const result = (id) => ({ status: 1, data: { list: [{ id, content: id }], count: 1 } });
test('switching comment resources starts the new request and discards late old response and VIP data', async () => {
  const s = fixture();
  const a = s.comments.fetchComments(true);
  s.calls[0].resolve(result('shared'));
  await a;
  const old = s.comments.fetchComments(true);
  s.comments.updateResource({ resourceId: 'b', mixSongId: undefined });
  const fresh = s.comments.fetchComments(true);
  assert.equal(s.calls[2].args[0], 'b');
  s.calls[1].resolve(result('old'));
  await old;
  assert.equal(s.comments.isLoadingComments.value, true);
  assert.equal(s.comments.comments.value.length, 0);
  s.calls[2].resolve(result('shared'));
  await fresh;
  s.vip[0].resolve([]);
  s.vip[1].resolve([{ id: 'shared', content: 'stale' }]);
  await flush();
  assert.equal(s.comments.comments.value[0].content, 'shared');
});
for (const type of ['music', 'playlist', 'album']) {
  test(`closing and reopening ${type} comments rejects old responses and errors`, async () => {
    const s = fixture();
    s.comments.updateResource({ resourceType: type });
    const old = s.comments.fetchComments(true);
    s.comments.stop();
    s.comments.resume();
    const fresh = s.comments.fetchComments(true);
    assert.equal(s.calls.length, 2);
    s.calls[0].reject(new Error('old failed'));
    await old;
    assert.deepEqual(s.failures, []);
    assert.equal(s.comments.isLoadingComments.value, true);
    s.calls[1].resolve(result('new'));
    await fresh;
    assert.equal(s.comments.comments.value[0].id, 'new');
  });
}
for (const domain of ['Classify', 'Hotword']) {
  test(`changing the ${domain.toLowerCase()} while loading resets the request and protects loading state`, async () => {
    const s = fixture();
    s.comments[`selected${domain}`].value = 'old';
    const old = s.comments[`fetch${domain}Comments`](true);
    s.comments[`selected${domain}`].value = 'new';
    const fresh = s.comments[`fetch${domain}Comments`](true);
    assert.equal(s.calls.length, 2);
    s.calls[0].resolve(result('old'));
    await old;
    assert.equal(s.comments[`isLoading${domain}`].value, true);
    s.calls[1].resolve(result('new'));
    await fresh;
    assert.equal(s.comments[`${domain.toLowerCase()}Comments`].value[0].id, 'new');
  });
}
test('floor reset while loading permits a new thread and ignores old completion', async () => {
  const s = fixture();
  const old = s.floor.fetchFloorReplies({ id: 'old', specialId: 's' }, true);
  s.floor.resetFloor();
  const fresh = s.floor.fetchFloorReplies({ id: 'new', specialId: 's' }, true);
  assert.equal(s.calls.length, 2);
  s.calls[0].resolve(result('old'));
  await old;
  assert.equal(s.floor.floorLoading.value, true);
  s.calls[1].resolve(result('new'));
  await fresh;
  assert.equal(s.floor.floorReplies.value[0].id, 'new');
});
