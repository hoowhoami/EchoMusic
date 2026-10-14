import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMvAudio, officialMv } from './helpers/mv-audio.mjs';

const mv = loadMvAudio();
const payload = (...records) => ({ status: 1, data: [records] });

test('catalog MV selection excludes platform short videos, UGC, other editions and unpublished records', () => {
  for (const patch of [
    { is_ugc: 1 },
    { is_short: 4 },
    { is_other: 1 },
    { is_publish: 0 },
    { duration: 0 },
    { is_short: undefined },
    { is_ugc: undefined },
    { is_short: null },
    { is_other: null },
    { __status: 0 },
    { h264: {}, h265: {}, mkv: {} },
  ]) {
    assert.equal(mv.pickCatalogMv(payload(officialMv(patch))), null);
  }
  const result = mv.pickCatalogMv(
    payload(
      officialMv({ video_id: 1, is_recommend: 0 }),
      officialMv({ video_id: 2, is_recommend: 1 }),
      officialMv({ video_id: 3, is_ugc: 1 }),
    ),
  );
  assert.equal(result.videoId, '2');
  assert.equal(mv.pickCatalogMv({}), null);
  assert.equal(mv.pickCatalogMv({ ...payload(officialMv()), status: 0 }), null);
});

test('fetches at most three small codec sources and keeps exact-hash primary/backup URLs', async () => {
  const hashes = [];
  const api = loadMvAudio({
    getSongMv: async (id) => {
      assert.equal(id, '123');
      return payload(officialMv());
    },
    getVideoUrl: async (hash) => {
      hashes.push(hash);
      if (hash === 'MKV') throw new Error('network unavailable');
      return {
        status: 1,
        data: {
          unrelated: { downurl: 'https://wrong.test/file.mp4' },
          [hash.toLowerCase()]: {
            downurl: `https://mv.test/${hash}.mp4`,
            backupdownurl: [`https://backup.test/${hash}.mp4`, 'file:///bad', null],
          },
        },
      };
    },
  });
  const result = await api.resolveMvAudioSource({ albumAudioId: 123 }, () => true);
  assert.deepEqual(hashes, ['SMALL265', 'SMALL264', 'MKV']);
  assert.equal(result.sourceKind, 'mv');
  assert.equal(result.quality, null);
  assert.equal(result.loudness, null);
  assert.equal(result.effect, 'none');
  assert.equal(result.sources.length, 4);
  assert.equal(
    result.urls.some((url) => url.includes('wrong')),
    false,
  );
  assert.equal(
    result.sources.some((source) => source.audioTrackId),
    false,
  );
});

test('never requests addresses for UGC results, bad IDs or superseded MV metadata', async () => {
  let calls = 0;
  let current = true;
  const api = loadMvAudio({
    getSongMv: async () => {
      current = false;
      return payload(officialMv());
    },
    getVideoUrl: async () => {
      calls++;
    },
  });
  assert.equal(await api.resolveMvAudioSource({ albumAudioId: 123 }, () => current), null);
  assert.equal(await api.resolveMvAudioSource({ albumAudioId: 0 }, () => true), null);
  const rejected = loadMvAudio({
    getSongMv: async () => payload(officialMv({ is_ugc: 1 })),
    getVideoUrl: async () => {
      calls++;
    },
  });
  assert.equal(await rejected.resolveMvAudioSource({ albumAudioId: 123 }, () => true), null);
  assert.equal(calls, 0);
});

test('late address results and business errors do not produce a playable source', async () => {
  let current = true;
  const api = loadMvAudio({
    getSongMv: async () => payload(officialMv()),
    getVideoUrl: async (hash) => {
      current = false;
      return { status: 1, data: { [hash.toLowerCase()]: { downurl: 'https://mv.test/file' } } };
    },
  });
  assert.equal(await api.resolveMvAudioSource({ albumAudioId: 123 }, () => current), null);
  const failed = loadMvAudio({
    getSongMv: async () => payload(officialMv()),
    getVideoUrl: async () => ({ status: 0, data: {} }),
  });
  assert.equal(await failed.resolveMvAudioSource({ albumAudioId: 123 }, () => true), null);
});

test('source errors are eligible; output, DSP, seek and cancellation errors are not', () => {
  for (const errorCode of ['decode', 'network'])
    assert.equal(mv.canFallbackToMvAudio({ errorCode, message: 'failed' }), true);
  for (const errorCode of ['dsp', 'cache', 'seek', 'output-runtime', 'output-exclusive']) {
    assert.equal(mv.canFallbackToMvAudio({ errorCode, message: 'decode failed' }), false);
  }
  assert.equal(
    mv.canFallbackToMvAudio({ message: 'failed to create audio decoder: invalid data' }),
    true,
  );
  assert.equal(mv.canFallbackToMvAudio({ message: 'Audio source load was superseded' }), false);
  assert.equal(mv.canFallbackToMvAudio({ message: 'audio output device unavailable' }), false);
});

test('account switch and same-account login invalidate the captured MV operation', () => {
  const user = { isLoggedIn: true, accountRevision: 0, info: { userid: 1, token: 'first' } };
  const api = loadMvAudio({}, user);
  const first = api.captureMvAudioSession();
  user.accountRevision++;
  assert.equal(first(), false);
  const second = api.captureMvAudioSession();
  user.info.token = 'second';
  assert.equal(second(), false);
});

test('client MV classification does not depend on editorial tags, titles or response album ID', () => {
  const tags = [{ tag_name: '短版' }];
  const result = mv.pickCatalogMv(
    payload(officialMv({ tags, mv_name: 'Song (短版)', album_audio_id: 999 })),
  );
  assert.ok(result);
  assert.equal(mv.pickCatalogMv(payload(officialMv({ tags: [], is_short: 1 }))), null);
});

test('real 数鸭子 response remains eligible under client classification and resolves playback addresses', async () => {
  const { readFileSync } = await import('node:fs');
  const response = JSON.parse(
    readFileSync(new URL('./fixtures/mv-audio-short.json', import.meta.url), 'utf8'),
  );
  let addressCalls = 0;
  const reasons = [];
  const api = loadMvAudio({
    getSongMv: async () => response,
    getVideoUrl: async (hash) => {
      addressCalls++;
      return {
        status: 1,
        data: { [hash.toLowerCase()]: { downurl: 'https://mv.test/ducks.mp4' } },
      };
    },
  });
  const result = await api.resolveMvAudioSource(
    { id: '588704117', albumAudioId: '588704117' },
    () => true,
    (reason) => reasons.push(reason),
  );
  assert.equal(result.sourceKind, 'mv');
  assert.equal(addressCalls, 3);
  assert.deepEqual(reasons, []);
});

test('platform short-video responses produce clear unavailable feedback', async () => {
  const reasons = [];
  const api = loadMvAudio({ getSongMv: async () => payload(officialMv({ is_short: 1 })) });
  assert.equal(
    await api.resolveMvAudioSource(
      { albumAudioId: 123 },
      () => true,
      (reason) => reasons.push(reason),
    ),
    null,
  );
  assert.deepEqual(reasons, ['关联视频均被平台标记为短视频，未找到可用 MV']);
});
