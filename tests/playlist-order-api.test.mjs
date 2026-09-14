import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const require = createRequire(import.meta.url);
const loadSortModule = (name, createCloudRequest = async (config) => config) => {
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    readFileSync(new URL(`../server/module/${name}.js`, import.meta.url), 'utf8'),
  )(
    (dependency) => {
      assert.equal(dependency, '../util');
      return { createCloudRequest };
    },
    mod,
    mod.exports,
  );
  return mod.exports;
};

test('renderer sorting calls use GET query parameters through to cloud protocol payloads', async () => {
  const code = transformSync(
    readFileSync(new URL('../src/renderer/api/playlist.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code;
  const calls = [];
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.equal(name, '@/utils/request');
      return {
        get: async (url, { params }) => {
          calls.push({ url, params });
          const query = Object.fromEntries(
            Object.entries(params).map(([key, value]) => [key, String(value)]),
          );
          const handler = loadSortModule(
            url === '/playlist/sort' ? 'playlist_sort' : 'playlist_tracks_sort',
          );
          return handler(query, async (config) => config);
        },
      };
    },
    mod,
    mod.exports,
  );
  const list = await mod.exports.savePlaylistOrder(14, '8|0|0,4|0|1');
  const tracks = await mod.exports.savePlaylistTrackOrder(12, 9, '95|0,81|1');
  assert.deepEqual(calls, [
    { url: '/playlist/sort', params: { total_ver: 14, data: '8|0|0,4|0|1' } },
    {
      url: '/playlist/tracks/sort',
      params: { listid: 12, list_ver: 9, type: 0, data: '95|0,81|1' },
    },
  ]);
  assert.equal(list.url, '/v1/modify_list_sort');
  assert.equal(list.data.total_ver, 14);
  assert.deepEqual(list.data.data, [
    { listid: 8, type: 0, sort: 0 },
    { listid: 4, type: 0, sort: 1 },
  ]);
  assert.equal(tracks.url, '/v1/modify_song_sort');
  assert.equal(tracks.data.listid, 12);
  assert.equal(tracks.data.list_ver, 9);
  assert.deepEqual(tracks.data.data, [
    { fileid: 95, sort: 0 },
    { fileid: 81, sort: 1 },
  ]);
});

test('playlist metadata and cover updates use GET parameters and the new cloud modules', async () => {
  const code = transformSync(
    readFileSync(new URL('../src/renderer/api/playlist.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code;
  const mod = { exports: {} };
  const calls = [];
  new Function('require', 'module', 'exports', code)(
    () => ({
      get: async (url, { params }) => {
        calls.push({ url, params });
        return loadSortModule(url === '/playlist/update' ? 'playlist_update' : 'playlist_pic')({
          ...params,
          cookie: { userid: '7', token: 'mock' },
        });
      },
    }),
    mod,
    mod.exports,
  );
  const info = await mod.exports.updatePlaylistInfo({
    listid: 12,
    total_ver: 9,
    type: 0,
    name: '新名称',
    sort: 8,
    tags: '华语,流行',
    intro: '简介',
  });
  assert.equal(info.url, '/v1/modify_list');
  assert.deepEqual(info.data, {
    listid: 12,
    total_ver: 9,
    type: 0,
    name: '新名称',
    sort: 8,
    tags: '华语,流行',
    intro: '简介',
  });
  const pic = await mod.exports.updatePlaylistCover(
    10,
    12,
    1,
    'https://imge.kugou.com/stdmusic/400/2020/a.jpg',
  );
  assert.equal(pic.url, '/v1/modify_list_pic');
  assert.deepEqual(pic.data, {
    total_ver: 10,
    data: [{ listid: 12, type: 1, pic: 'stdmusic/a.jpg' }],
  });
  assert.deepEqual(pic.cookie, { userid: '7', token: 'mock' });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/playlist/update', '/playlist/pic'],
  );
});

test('cover uploads forward client bytes and extension without server format processing', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  let uploaded;
  const uploadModule = { exports: {} };
  const deps = {
    axios: async (config) => {
      uploaded = config;
      return { data: { IsSuccess: true, FileName: '20260914.png' } };
    },
    fs: { existsSync: (path) => path === '/tmp/封面.png', readFileSync: () => bytes },
    '../util/crypto': { cryptoMd5: () => 'mock-digest' },
    '../util/runtime': { resolveProxy: () => false },
  };
  new Function(
    'require',
    'module',
    'exports',
    readFileSync(new URL('../server/module/playlist_pic_upload.js', import.meta.url), 'utf8'),
  )(
    (id) => {
      assert.ok(id in deps, id);
      return deps[id];
    },
    uploadModule,
    uploadModule.exports,
  );
  const apiModule = { exports: {} };
  const code = transformSync(
    readFileSync(new URL('../src/renderer/api/playlist.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'cjs' },
  ).code;
  new Function('require', 'module', 'exports', code)(
    () => ({
      get: async (url, { params }) => {
        assert.equal(url, '/playlist/update');
        return loadSortModule('playlist_update')(params);
      },
      post: async (url, data, { params, headers }) => {
        assert.equal(url, '/playlist/pic/upload');
        assert.equal(headers['Content-Type'], 'application/octet-stream');
        assert.ok(data instanceof Uint8Array);
        return uploadModule.exports({ ...params, data: Buffer.from(data) });
      },
    }),
    apiModule,
    apiModule.exports,
  );
  const result = await apiModule.exports.uploadPlaylistCover(Uint8Array.from(bytes).buffer);
  assert.equal(result.body.FileName, '20260914.png');
  assert.equal(uploaded.method, 'post');
  assert.equal(uploaded.params.type, 'custom');
  assert.equal(uploaded.params.extendName, '.png');
  assert.deepEqual(uploaded.data, bytes);
  await uploadModule.exports({ file: '/tmp/封面.png', extendName: '.jpg' });
  assert.equal(uploaded.params.extendName, '.jpg');
  assert.deepEqual(uploaded.data, bytes);
  const otherBytes = Buffer.from('RIFF1234WEBP');
  await uploadModule.exports({ data: otherBytes, extendName: '.webp' });
  assert.equal(uploaded.params.extendName, '.webp');
  assert.deepEqual(uploaded.data, otherBytes);
  await uploadModule.exports({ data: bytes });
  assert.equal(uploaded.params.extendName, '.jpg');
  const saved = await apiModule.exports.updatePlaylistInfo({
    listid: 12,
    type: 0,
    total_ver: 9,
    sort: 8,
    tags: '流行',
    intro: '原简介',
    pic: 'custom/20260914.png',
  });
  assert.deepEqual(saved.data, {
    listid: 12,
    type: 0,
    total_ver: 9,
    sort: 8,
    tags: '流行',
    intro: '原简介',
    pic: 'custom/20260914.png',
  });
});

test('playlist queries no longer forward the ignored need_sort parameter', async () => {
  for (const name of ['playlist_track_all', 'playlist_track_all_new']) {
    const query = require(`../server/module/${name}.js`);
    const result = await query({}, async (config) => config);
    assert.equal('need_sort' in (result.params ?? result.data), false);
    const disabled = await query({ needsort: 0 }, async (config) => config);
    assert.equal('need_sort' in (disabled.params ?? disabled.data), false);
  }
});

test('new playlist query uses v3 with numeric paging and preserves response sorting metadata', async () => {
  const query = require('../server/module/playlist_track_all_new.js');
  const defaults = await query({ listid: 12 }, async (config) => config);
  assert.equal(defaults.url, '/v4/get_list_all_file_v3');
  assert.equal(defaults.data.type, 0);
  assert.equal(defaults.data.page, 1);
  assert.equal(defaults.data.pagesize, 300);
  assert.equal('show_relate_goods' in defaults.data, false);

  const response = { status: 1, data: { list_ver: 9, info: [{ fileid: 95, sort: 0 }] } };
  const result = await query(
    {
      listid: '12',
      type: '1',
      page: '2',
      pagesize: '200',
      cookie: { userid: '123', token: 'test' },
    },
    async (config) => {
      assert.equal(config.url, '/v4/get_list_all_file_v3');
      assert.equal(config.method, 'post');
      assert.equal(config.encryptType, 'android');
      assert.equal(config.headers['x-router'], 'cloudlist.service.kugou.com');
      assert.deepEqual(config.data, {
        listid: '12',
        userid: '123',
        type: 1,
        page: 2,
        pagesize: 200,
        area_code: 1,
        allplatform: 1,
        show_cover: 1,
        token: 'test',
      });
      return response;
    },
  );
  assert.equal(result, response);
});

test('server sorting endpoints forward versions and distinct category/file identifiers', async () => {
  const song = await loadSortModule('playlist_tracks_sort')(
    {
      listid: 12,
      list_ver: 9,
      type: 0,
      data: '95|0,81|1',
      cookie: { userid: 'test-user', token: 'test-token' },
    },
    async (config) => config,
  );
  assert.deepEqual(song.cookie, { userid: 'test-user', token: 'test-token' });
  assert.equal(song.url, '/v1/modify_song_sort');
  assert.equal(song.data.list_ver, 9);
  assert.deepEqual(song.data.data, [
    { fileid: 95, sort: 0 },
    { fileid: 81, sort: 1 },
  ]);
  const list = await loadSortModule('playlist_sort')(
    { total_ver: 14, data: '8|0|0,4|1|0' },
    async (config) => config,
  );
  assert.equal(list.url, '/v1/modify_list_sort');
  assert.equal(list.data.total_ver, 14);
  assert.deepEqual(list.data.data, [
    { listid: 8, type: 0, sort: 0 },
    { listid: 4, type: 1, sort: 0 },
  ]);
});

test('cloud sorting encrypts request data and decrypts the response before returning it', async () => {
  const requestUrl = new URL('../server/util/request.js', import.meta.url);
  const serverRequire = createRequire(requestUrl);
  const CryptoJS = serverRequire('crypto-js');
  const crypto = serverRequire('./crypto');
  let session;
  let sent;
  const mod = { exports: {} };
  const payload = { total_ver: 14, data: [{ listid: 8, type: 0, sort: 0 }] };
  new Function('require', 'module', 'exports', readFileSync(requestUrl, 'utf8'))(
    (name) => {
      if (name === './crypto')
        return {
          ...crypto,
          rsaEncrypt2: (plain) => {
            session = JSON.parse(plain);
            return 'abcd';
          },
        };
      if (name === './runtime') return { resolveProxy: () => false };
      if (name === 'axios')
        return async (config) => {
          sent = config;
          const digest = crypto.cryptoMd5(session.aes);
          const key = CryptoJS.enc.Utf8.parse(digest.slice(0, 16));
          const options = {
            iv: CryptoJS.enc.Utf8.parse(digest.slice(16)),
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7,
          };
          const plain = CryptoJS.AES.decrypt(
            CryptoJS.lib.CipherParams.create({
              ciphertext: CryptoJS.enc.Hex.parse(config.data.toString('hex')),
            }),
            key,
            options,
          ).toString(CryptoJS.enc.Utf8);
          assert.deepEqual(JSON.parse(plain), payload);
          const encrypted = CryptoJS.AES.encrypt(
            JSON.stringify({ status: 1, data: { total_ver: 15 } }),
            key,
            options,
          );
          return { data: Buffer.from(encrypted.ciphertext.toString(CryptoJS.enc.Hex), 'hex') };
        };
      return serverRequire(name);
    },
    mod,
    mod.exports,
  );
  const result = await loadSortModule(
    'playlist_sort',
    mod.exports.createCloudRequest,
  )({
    total_ver: 14,
    data: '8|0|0',
    cookie: { userid: 123, token: 'test-token', mid: 'test-mid' },
  });
  assert.equal(sent.method, 'post');
  assert.equal(sent.baseURL, 'https://gateway.kugou.com');
  assert.equal(sent.headers['x-router'], 'cloudlist.service.kugou.com');
  assert.equal(sent.url, '/v1/modify_list_sort');
  assert.equal(sent.params.p, 'ABCD');
  assert.equal(sent.params.mid, 'test-mid');
  assert.equal(session.uid, 123);
  assert.equal(session.token, 'test-token');
  assert.equal(Buffer.isBuffer(sent.data), true);
  assert.deepEqual(result.body, { status: 1, data: { total_ver: 15 } });
  assert.equal(result.status, 200);
});
