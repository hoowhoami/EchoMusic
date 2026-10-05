import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const cover = compile('../src/renderer/utils/cover.ts', {
  '@/plugins/coverFallback': {},
  './themedCover': {},
});
const shared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': cover,
  '../../../shared/object': compile('../src/shared/object.ts'),
});
const { mapPlaylistSong } = compile('../src/renderer/utils/mappers/song.ts', {
  './shared': shared,
});
const mapping = compile('../src/renderer/utils/mappers/songMetadata.ts', { './shared': shared });
const { applyMissingSongMetadata, needsSongMetadata } = mapping;
// Selected fields from the exact favorite and /krm/audio responses, 2026-10-05.
const favorite = {
  hash: '208D789BD23B987FBAFCD99E24A75308',
  mixsongid: 64323384,
  fileid: 2418,
  audio_id: 363820878,
  name: '云朵 - 我的楼兰.mp3',
  timelen: 325616,
  singerinfo: [{ name: '', id: 0 }],
  albuminfo: { name: '', id: 0 },
  album_id: '2603117',
  cover: '',
  sort: 0,
  media_privilege: 0,
  media_pay_type: 0,
  media_old_cpy: 1,
};
const metadata = {
  __status: 1,
  base: { album_audio_id: 64323384, audio_id: 363820878, songname: '我的楼兰', album_id: 2603117 },
  album_info: {
    album_id: 2603117,
    album_name: '倔强',
    cover: 'http://imge.kugou.com/stdmusic/{size}/20240628/20240628181912160687.jpg',
  },
  authors: [
    {
      base: {
        author_id: 6743,
        author_name: '云朵',
        avatar:
          'http://singerimg.kugou.com/uploadpic/softhead/{size}/20231206/20231206171439467.jpg',
      },
    },
  ],
};
const setup = (getSongMetadata) => {
  let time = 1_000;
  const warnings = [];
  const service = compile('../src/renderer/services/songMetadata.ts', {
    '@/api/music': { getSongMetadata },
    '@/utils/mappers/songMetadata': mapping,
    '@/utils/mappers/shared': shared,
    '@/utils/logger': { warn: (...args) => warnings.push(args) },
  });
  const complete = service.createSongMetadataCompleter({
    fetch: getSongMetadata,
    now: () => time,
  });
  return Object.assign(complete, {
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
    warnings,
  });
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('invalid albuminfo ID does not hide the real outer album ID', () => {
  const song = mapPlaylistSong(favorite);
  assert.equal(song.albumId, '2603117');
  assert.equal(song.albumAudioId, '64323384');
  assert.equal(song.coverUrl, '');
  assert.equal(song.artists[0].name, '云朵');
  assert.equal(song.artists[0].id, undefined);
  for (const id of [0, '0', '', null, false, 'oops']) {
    assert.equal(mapPlaylistSong({ ...favorite, albuminfo: { id } }).albumId, '2603117');
  }
});

test('exact metadata completes artwork, singer ID and album without altering favorite or playback identity', () => {
  const song = mapPlaylistSong(favorite);
  const [completed] = applyMissingSongMetadata([song], { data: [metadata] });
  assert.equal(
    completed.coverUrl,
    'https://imge.kugou.com/stdmusic/400/20240628/20240628181912160687.jpg',
  );
  assert.equal(completed.albumName, '倔强');
  assert.equal(completed.artists[0].id, '6743');
  assert.equal(completed.singers, completed.artists);
  for (const key of [
    'id',
    'hash',
    'mixSongId',
    'albumAudioId',
    'fileId',
    'playlistSort',
    'privilege',
    'payType',
    'oldCpy',
    'audioUrl',
    'duration',
  ]) {
    assert.equal(completed[key], song[key], key);
  }
  assert.equal(song.coverUrl, '');
  assert.equal(needsSongMetadata(completed), false);
});

test('reordered, omitted and other-version records are joined by album audio ID', () => {
  const song = mapPlaylistSong(favorite);
  const other = { ...song, id: 'other', albumAudioId: '780780493' };
  const wrong = {
    ...metadata,
    base: { album_audio_id: 780780493 },
    album_info: { album_name: 'other album' },
  };
  const completed = applyMissingSongMetadata([song, other], { data: [wrong, metadata] });
  assert.equal(completed[0].albumName, '倔强');
  assert.equal(completed[1].albumName, 'other album');
  assert.equal(applyMissingSongMetadata([song], { data: [wrong] })[0], song);
  assert.equal(applyMissingSongMetadata([song], { data: [{ ...metadata, __status: 0 }] })[0], song);
});

test('existing metadata and artist IDs remain intact; different artist names do not receive a guessed ID', () => {
  const song = {
    ...mapPlaylistSong(favorite),
    coverUrl: 'existing',
    cover: 'existing',
    albumId: '99',
    albumName: 'existing',
    album: 'existing',
    artists: [{ name: '云朵', id: 'existing-id' }],
  };
  const [completed] = applyMissingSongMetadata([song], { data: [metadata] });
  // Non-numeric IDs cannot be used for artist navigation, so the exact author ID can complete them.
  assert.equal(completed.artists[0].id, '6743');
  const valid = { ...song, artists: [{ name: '云朵', id: '123' }] };
  assert.equal(applyMissingSongMetadata([valid], { data: [metadata] })[0], valid);
  for (const key of ['coverUrl', 'cover', 'albumId', 'albumName', 'album'])
    assert.equal(completed[key], song[key]);
  const unknown = { ...song, artists: [{ name: '另一个歌手' }] };
  assert.equal(applyMissingSongMetadata([unknown], { data: [metadata] })[0], unknown);
});

test('only incomplete catalog entries are requested in bounded, deduplicated batches', async () => {
  const song = mapPlaylistSong(favorite);
  const filled = applyMissingSongMetadata([song], { data: [metadata] })[0];
  const requests = [];
  const complete = setup(async (ids) => {
    requests.push(ids);
    return { status: 1, data: [metadata] };
  });
  const songs = [
    filled,
    { ...song, source: 'cloud' },
    { ...song, albumAudioId: undefined },
    song,
    song,
    ...Array.from({ length: 100 }, (_, i) => ({ ...song, albumAudioId: String(900000 + i) })),
  ];
  const result = await complete(songs);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].length, 100);
  assert.equal(requests[1].length, 1);
  assert.equal(new Set(requests.flat()).size, 101);
  assert.equal(result[3].artists[0].id, '6743');
  requests.length = 0;
  await complete([filled]);
  assert.equal(requests.length, 0);
});

test('metadata failures preserve playable entries and stale responses are discarded', async () => {
  const song = mapPlaylistSong(favorite);
  assert.equal(
    (
      await setup(async () => {
        throw Error('offline');
      })([song])
    )[0],
    song,
  );
  let current = true;
  const completed = await setup(async () => {
    current = false;
    return { status: 1, data: [metadata] };
  })([song], () => current);
  assert.equal(completed[0], song);
  let requests = 0;
  await setup(async () => {
    requests++;
  })([song], () => false);
  assert.equal(requests, 0);
});

test('refreshes reuse successful metadata for 24 hours, including partial metadata', async () => {
  const song = mapPlaylistSong(favorite);
  let calls = 0;
  const complete = setup(async () => {
    calls++;
    return { status: 1, data: [{ ...metadata, authors: [] }] };
  });
  assert.equal((await complete([song]))[0].albumName, '倔强');
  assert.equal((await complete([{ ...song }]))[0].albumName, '倔强');
  assert.equal(calls, 1);
  complete.advance(24 * 60 * 60_000 - 1);
  await complete([song]);
  assert.equal(calls, 1);
  complete.advance(1);
  await complete([song]);
  assert.equal(calls, 2);
});

test('missing records are negatively cached for 30 minutes', async () => {
  const song = mapPlaylistSong(favorite);
  let calls = 0;
  const complete = setup(async () => {
    calls++;
    return { status: 1, data: [] };
  });
  assert.equal((await complete([song]))[0], song);
  await complete([song]);
  complete.advance(30 * 60_000 - 1);
  await complete([song]);
  assert.equal(calls, 1);
  complete.advance(1);
  await complete([song]);
  assert.equal(calls, 2);
});

test('overlapping concurrent refreshes deduplicate individual IDs and merge the batch', async () => {
  const song = mapPlaylistSong(favorite);
  const other = { ...song, albumAudioId: '123' };
  const requests = [];
  const response = deferred();
  const complete = setup(async (ids) => {
    requests.push(ids);
    return response.promise;
  });
  const left = complete([song]);
  const right = complete([{ ...song }, other]);
  await flush();
  assert.deepEqual(requests, [['64323384', '123']]);
  const third = complete([song]);
  response.resolve({ status: 1, data: [metadata] });
  for (const result of await Promise.all([left, right, third]))
    assert.equal(result[0].artists[0].id, '6743');
  assert.equal(requests.length, 1);
});

test('the queue permits three concurrent batches without a fixed interval and caps each at 100 IDs', async () => {
  const song = mapPlaylistSong(favorite);
  const first = deferred();
  const starts = [];
  let active = 0;
  let peak = 0;
  const complete = setup(async (ids) => {
    starts.push({ ids, time: complete.now() });
    peak = Math.max(peak, ++active);
    const result = starts.length <= 3 ? await first.promise : { status: 1, data: [] };
    active--;
    return result;
  });
  const songs = Array.from({ length: 450 }, (_, i) => ({ ...song, albumAudioId: String(i + 1) }));
  const loading = complete(songs);
  await flush();
  assert.equal(starts.length, 3);
  assert.equal(active, 3);
  first.resolve({ status: 1, data: [] });
  await loading;
  assert.equal(peak, 3);
  assert.deepEqual(
    starts.map((entry) => entry.ids.length),
    [100, 100, 100, 100, 50],
  );
  assert.ok(starts.every((entry) => entry.time === starts[0].time));
});

test('a failed batch pauses all metadata requests with exponential backoff and no automatic retry', async () => {
  const song = mapPlaylistSong(favorite);
  let calls = 0;
  const complete = setup(async () => {
    calls++;
    throw Error('offline');
  });
  await complete(Array.from({ length: 350 }, (_, i) => ({ ...song, albumAudioId: String(i + 1) })));
  await complete([song]);
  assert.equal(calls, 3);
  assert.equal(complete.warnings.length, 1);
  complete.advance(60_000 - 1);
  await complete([song]);
  assert.equal(calls, 3);
  complete.advance(1);
  await complete([song]);
  assert.equal(calls, 4);
  complete.advance(120_000 - 1);
  await complete([song]);
  assert.equal(calls, 4);
  complete.advance(1);
  await complete([song]);
  assert.equal(calls, 5);
  assert.equal(complete.warnings.length, 3);
});

test('HTTP 403, 429 and API rejection pause supplementation for 30 minutes', async () => {
  const song = mapPlaylistSong(favorite);
  for (const status of [403, 429, 'api']) {
    let calls = 0;
    const complete = setup(async () => {
      calls++;
      if (status === 'api') return { status: 0, error_code: 123, data: [] };
      throw Object.assign(Error('refused'), { response: { status } });
    });
    await complete([song]);
    complete.advance(30 * 60_000 - 1);
    await complete([song]);
    assert.equal(calls, 1);
    complete.advance(1);
    await complete([song]);
    assert.equal(calls, 2);
  }
});

test('cancelled queued pages do not send requests when a concurrent slot becomes free', async () => {
  const song = mapPlaylistSong(favorite);
  const response = deferred();
  let calls = 0;
  const complete = setup(async () => {
    calls++;
    return response.promise;
  });
  const warming = complete(
    Array.from({ length: 300 }, (_, i) => ({ ...song, albumAudioId: String(i + 1) })),
  );
  await flush();
  assert.equal(calls, 3);
  let current = true;
  const other = { ...song, albumAudioId: '9001' };
  const loading = complete([other], () => current);
  await flush();
  current = false;
  response.resolve({ status: 1, data: [] });
  await warming;
  assert.equal((await loading)[0], other);
  assert.equal(calls, 3);
});

test('server Retry-After can extend cooldown beyond the local default', async () => {
  const song = mapPlaylistSong(favorite);
  for (const retryAfter of ['3600', new Date(3_601_000).toUTCString()]) {
    let calls = 0;
    const complete = setup(async () => {
      calls++;
      throw Object.assign(Error('rate limited'), {
        response: { status: 429, headers: { 'retry-after': retryAfter } },
      });
    });
    await complete([song]);
    complete.advance(3_600_000 - 1);
    await complete([song]);
    assert.equal(calls, 1);
    complete.advance(1);
    await complete([song]);
    assert.equal(calls, 2);
  }
});

test('a replacement refresh can reuse an in-flight public metadata request while the old caller remains stale', async () => {
  const song = mapPlaylistSong(favorite);
  const response = deferred();
  let current = true;
  let calls = 0;
  const complete = setup(async () => {
    calls++;
    return response.promise;
  });
  const old = complete([song], () => current);
  await flush();
  current = false;
  const fresh = complete([{ ...song }]);
  response.resolve({ status: 1, data: [metadata] });
  assert.equal((await old)[0], song);
  assert.equal((await fresh)[0].artists[0].id, '6743');
  assert.equal(calls, 1);
});

test('LRU cache stays bounded at 2000 entries and keeps recently used entries', async () => {
  const song = mapPlaylistSong(favorite);
  let calls = 0;
  const complete = setup(async (ids) => {
    calls++;
    return {
      status: 1,
      data: ids.map((id) => ({ ...metadata, base: { ...metadata.base, album_audio_id: id } })),
    };
  });
  const songs = Array.from({ length: 2001 }, (_, i) => ({ ...song, albumAudioId: String(i + 1) }));
  await complete(songs);
  assert.equal(calls, 21);
  await complete([songs[2000]]);
  assert.equal(calls, 21);
  await complete([songs[0]]);
  assert.equal(calls, 22);
});

for (const data of [undefined, null, {}, [], [{}]]) {
  test(`successful empty metadata ${JSON.stringify(data)} preserves the song without failure cooldown`, async () => {
    const song = mapPlaylistSong(favorite);
    let calls = 0;
    const complete = setup(async () => {
      calls++;
      return { status: 1, data };
    });
    assert.equal((await complete([song]))[0], song);
    await complete([{ ...song, albumAudioId: '123' }]);
    assert.equal(calls, 2);
    assert.deepEqual(complete.warnings, []);
  });
}

test('metadata parsing accepts a data array without demanding an extra status field', async () => {
  const song = mapPlaylistSong(favorite);
  const complete = setup(async () => ({ data: [metadata] }));
  assert.equal((await complete([song]))[0].artists[0].id, '6743');
  assert.deepEqual(complete.warnings, []);
});
