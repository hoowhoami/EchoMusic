import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

function compile(path, deps = {}) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const cover = compile('../src/renderer/utils/cover.ts', {
  '@/plugins/coverFallback': {},
  './themedCover': {},
});
const shared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': cover,
  '../../../shared/object': compile('../src/shared/object.ts'),
});
const song = compile('../src/renderer/utils/mappers/song.ts', { './shared': shared });
const { mapDiscoverItems, applyDiscoverMetadata } = compile(
  '../src/renderer/utils/mappers/discover.ts',
  {
    './shared': shared,
    './song': song,
  },
);

// Selected non-sensitive fields from the live responses checked on 2026-09-30.
const row = {
  item_id: '644833397',
  item_type: 'song',
  song_info: {
    mixsongid: '644833397',
    songid: '429322031',
    songname: '恋人',
    author_name: '李荣浩',
    audio_id: 363537969,
    album_audio_id: 644833397,
    ori_album_id: 106374641,
    album_name: '黑马',
    album_cover: 'http://imge.kugou.com/stdmusic/{size}/20241016/20241016175101115675.jpg',
    hash_128: '9DA7851E2BF83B18C74CBBAB461CEFDD',
    hash_320: 'C8DE6F8214A0556AC3F0BE4872A6EED8',
    hash_flac: '34C52ED693A5519D72DA623EBA0E7DE1',
    timelength_128: 275957,
    privilege: 10,
    pay_type: 3,
    trans_param: { language: '国语' },
  },
};
const metadata = {
  base: { album_audio_id: 644833397, language: '国语' },
  album_info: { album_id: 106374641, album_name: '黑马' },
  authors: [
    {
      base: {
        author_id: 93475,
        author_name: '李荣浩',
        avatar:
          'http://singerimg.kugou.com/uploadpic/softhead/{size}/20240410/20240410145303317821.jpg',
      },
    },
  ],
};

test('maps the discover response identities, album, artwork, duration, rights and qualities', () => {
  const [item] = mapDiscoverItems({ data: { items: [row, row, { ...row, item_type: 'mv' }] } });
  const s = item.song;
  assert.equal(s.id, '644833397');
  assert.equal(s.songId, '429322031');
  assert.equal(s.albumAudioId, '644833397');
  assert.equal(s.fileId, 363537969);
  assert.equal(s.albumId, '106374641');
  assert.equal(s.albumName, '黑马');
  assert.equal(s.name, '恋人');
  assert.equal(s.artist, '李荣浩');
  assert.equal(s.artists[0].id, undefined);
  assert.equal(s.duration, 275);
  assert.equal(s.privilege, 10);
  assert.equal(s.payType, 3);
  assert.equal(s.language, '国语');
  assert.equal(s.hash, row.song_info.hash_128);
  assert.equal(
    s.coverUrl,
    row.song_info.album_cover.replace('http:', 'https:').replace('{size}', '400'),
  );
  assert.deepEqual(
    s.relateGoods.map((g) => g.quality),
    ['320', 'flac'],
  );
  assert.equal(mapDiscoverItems({ data: { items: [row, row] } }).length, 1);
});

test('joins nested authors by album_audio_id without changing playback identity or guessing missing IDs', () => {
  const items = mapDiscoverItems({ data: { items: [row] } });
  const [enriched] = applyDiscoverMetadata(items, {
    data: [
      {
        base: { album_audio_id: 32092078 },
        authors: [{ base: { author_id: 5826, author_name: '孙燕姿' } }],
      },
      metadata,
    ],
  });
  assert.equal(enriched.song.artists[0].id, '93475');
  assert.equal(enriched.song.singers[0].name, '李荣浩');
  assert.match(enriched.song.artists[0].pic, /softhead\/400\//);
  for (const key of ['id', 'songId', 'mixSongId', 'hash', 'duration', 'albumAudioId']) {
    assert.equal(enriched.song[key], items[0].song[key]);
  }
  assert.deepEqual(applyDiscoverMetadata(items, { data: [] }), items);
});

test('discover GET requests bypass cached batches, even within the same millisecond', () => {
  const requests = [];
  const api = compile('../src/renderer/api/music.ts', {
    '@/utils/request': { get: (...args) => requests.push(args) },
  });
  api.getHomeDiscover();
  api.getHomeDiscover();
  assert.equal(requests[0][0], '/home/discover');
  assert(requests[1][1].params.timestamp > requests[0][1].params.timestamp);
  assert.equal(requests[0][1].params.userid, undefined);
});
