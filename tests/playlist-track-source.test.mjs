import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOwnedPlaylistListId } from '../src/renderer/utils/playlistTrackSource.ts';

test('owned cloud GIDs resolve to user listid rather than a public detail ID', () => {
  assert.equal(resolveOwnedPlaylistListId('collection_3_123_12_0', { currentUserId: 123 }), 12);
  assert.equal(
    resolveOwnedPlaylistListId(9999, {
      currentUserId: 123,
      listCreateGid: 'collection_3_123_12_0',
    }),
    12,
  );
  assert.equal(
    resolveOwnedPlaylistListId(9999, {
      currentUserId: 123,
      listCreateUserid: 123,
      listCreateListid: 12,
    }),
    12,
  );
  assert.equal(
    resolveOwnedPlaylistListId(9999, {
      currentUserId: 123,
      listCreateUserid: 123,
      listid: 12,
    }),
    12,
  );
});

test('public playlists, other users, albums and logged-out requests do not use the own-list endpoint', () => {
  for (const [id, context] of [
    [9999, { currentUserId: 123, listCreateUserid: 123 }],
    ['collection_3_456_12_0', { currentUserId: 123, listCreateUserid: 456, listid: 12 }],
    ['collection_3_123_12_0', {}],
    ['collection_3_123_12_0', { currentUserId: 123, source: 2 }],
    [9999, { currentUserId: 123, listCreateUserid: 123, listid: 0 }],
  ])
    assert.equal(resolveOwnedPlaylistListId(id, context), null);
});
