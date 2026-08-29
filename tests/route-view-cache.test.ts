import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateRouteViewCacheKey } from '../src/renderer/utils/routeViewCache.ts';

test('a refreshed route keeps using the refreshed cache entry after direct navigation', () => {
  const revisions = new Map<string, string>();
  const playlistA = '/main/playlist/a?type=user';
  const playlistB = '/main/playlist/b?type=user';

  const initialA = updateRouteViewCacheKey(playlistA, '', revisions);
  assert.deepEqual(initialA, { key: playlistA });

  const refreshedA = updateRouteViewCacheKey(playlistA, '1234', revisions);
  assert.equal(refreshedA.staleKey, initialA.key);
  assert.notEqual(refreshedA.key, initialA.key);

  assert.deepEqual(updateRouteViewCacheKey(playlistB, '', revisions), { key: playlistB });
  assert.deepEqual(updateRouteViewCacheKey(playlistA, '', revisions), {
    key: refreshedA.key,
  });
});

test('a later refresh replaces the previous refreshed cache entry', () => {
  const revisions = new Map<string, string>();
  const route = '/main/favorites';
  const first = updateRouteViewCacheKey(route, '1000', revisions);
  const second = updateRouteViewCacheKey(route, '2000', revisions);

  assert.equal(second.staleKey, first.key);
  assert.notEqual(second.key, first.key);
  assert.deepEqual(updateRouteViewCacheKey(route, '', revisions), { key: second.key });
});
