import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAlbumDynamicCoverLoader,
  mapAlbumDynamicCover,
  normalizeAlbumCoverId,
} from '../src/renderer/utils/albumDynamicCover.ts';

const primary = 'https://kgv.stream.tencentmusic.com/cover.mp4?dis_k=signed&dis_t=123';
const backup = `${primary}&isbak=1`;
const response = (albumId = 65482908) => ({
  status: 1,
  data: [
    {
      base: { album_id: albumId },
      dycover: {
        h264_url: primary,
        h264_backup_url: [backup, primary],
        h265_url: 'https://example.com/hevc.mp4',
      },
    },
  ],
});

test('maps the real dycover shape, preserves signed URLs and prefers H.264 with unique backups', () => {
  assert.deepEqual(mapAlbumDynamicCover(response(), '65482908'), {
    albumId: '65482908',
    urls: [primary, backup],
  });
  assert.equal(mapAlbumDynamicCover(response(), '123'), null);
  assert.equal(mapAlbumDynamicCover({ status: 1, data: [] }), null);
  assert.equal(mapAlbumDynamicCover({ status: 1, data: [{ base: { album_id: 1 } }] }), null);
  assert.equal(
    mapAlbumDynamicCover({ status: 1, data: [...response().data, ...response(1).data] }),
    null,
  );
});

test('malformed/unplayable URLs and unsupported-only resources fall back to static artwork', () => {
  const body = response();
  body.data[0].dycover.h264_url = 'javascript:alert(1)';
  body.data[0].dycover.h264_backup_url = [
    'file:///tmp/test.mp4',
    'not-a-url',
    'https://user:pass@example.com/a',
  ];
  assert.equal(mapAlbumDynamicCover(body), null);
  body.data[0].dycover.h264_backup_url.push(backup);
  assert.deepEqual(mapAlbumDynamicCover(body)?.urls, [backup]);
  assert.throws(() => mapAlbumDynamicCover({ status: 0, error_code: 1 }));
});

test('only positive safe numeric album-audio IDs are requested', async () => {
  const calls: unknown[] = [];
  const load = createAlbumDynamicCoverLoader(async (r) => {
    calls.push(r);
    return response();
  });
  for (const id of [
    undefined,
    null,
    '',
    0,
    -1,
    'local:track',
    '123,456',
    NaN,
    Infinity,
    1.5,
    '999999999999999999',
  ]) {
    assert.equal(await load(id), null);
    assert.equal(normalizeAlbumCoverId(id), '');
  }
  assert.equal(calls.length, 0);
  await load('0468087825', 'invalid');
  assert.deepEqual(calls, [{ albumAudioId: '468087825', albumId: '' }]);
});

test('concurrent consumers share one request; successful and absent resources expire', async () => {
  let now = 0;
  let calls = 0;
  const load = createAlbumDynamicCoverLoader(
    async () => {
      calls++;
      return response();
    },
    () => now,
  );
  const a = load(468087825, 65482908);
  const b = load('468087825', '65482908');
  assert.equal(a, b);
  assert.deepEqual(await a, await b);
  await load(468087825, 65482908);
  assert.equal(calls, 1);
  now = 5 * 60_000;
  await load(468087825, 65482908);
  assert.equal(calls, 2);
  await load(468087825, 1);
  await load(468087825, 1);
  assert.equal(calls, 3, 'cache negative results too, scoped by album edition');
});

test('transport and business failures are not cached as permanent absence', async () => {
  let calls = 0;
  const load = createAlbumDynamicCoverLoader(async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    if (calls === 2) return { status: 0 };
    return response();
  });
  await assert.rejects(load(1));
  await assert.rejects(load(1));
  assert.ok(await load(1));
  assert.equal(calls, 3);
});

test('cache keeps at most 64 recent entries', async () => {
  let calls = 0;
  const load = createAlbumDynamicCoverLoader(async () => {
    calls++;
    return response();
  });
  for (let i = 1; i <= 65; i++) await load(i);
  await load(65);
  assert.equal(calls, 65);
  await load(1);
  assert.equal(calls, 66);
});
