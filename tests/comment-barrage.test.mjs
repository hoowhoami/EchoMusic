import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
const require = createRequire(import.meta.url);
const source = buildSync({
  entryPoints: [new URL('../src/renderer/api/comment.ts', import.meta.url).pathname],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['@/utils/request'],
}).outputFiles[0].text;
function client(mock) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(() => mock, module, module.exports);
  return module.exports;
}

test('all five send routes pass resource identity in POST body', async () => {
  const calls = [];
  const api = client({ post: async (...args) => { calls.push(args); return { status: 1, err_code: 0 }; } });
  for (const type of ['music', 'album', 'playlist', 'song-barrage', 'video-barrage']) {
    await api.sendComment({ type, id: '42', hash: 'ABC', name: 'name' }, 'hello');
  }
  assert.deepEqual(calls.map(([path]) => path), [
    '/comment/music/send', '/comment/album/send', '/comment/playlist/send', '/song/barrage/send', '/video/barrage/send',
  ]);
  assert.equal(calls[0][1].mixsongid, '42');
  assert.equal(calls[1][1].id, '42');
  assert.equal(calls[2][1].id, '42');
  for (const [, body] of calls.slice(3)) { assert.equal(body.hash, 'ABC'); assert.equal(body.id, undefined); }
});

test('business failures and HTTP failures do not report a successful send', async () => {
  for (const response of [null, {}, { status: 0, msg: '审核失败' }, { status: 1, err_code: 9 }]) {
    const api = client({ post: async () => response });
    await assert.rejects(api.sendComment({ type: 'music', id: '42' }, 'hello'));
  }
  const api = client({ post: async () => { throw { response: { body: { msg: '需要手机验证' } } }; } });
  await assert.rejects(api.sendComment({ type: 'music', id: '42' }, 'hello'), /需要手机验证/);
});

test('song comments, song barrage and MV barrage resolve distinct pools before sending', async () => {
  for (const [name, params, expectedCode, expectedAction] of [
    ['comment_music_send', { mixsongid: '42' }, 'fc4be23b4e972707f36b8a828a93ba8a', 'commentsv3/add'],
    ['song_barrage_send', { hash: 'ABC' }, 'articulossong', 'commentsv3/add'],
    ['video_barrage_send', { hash: 'ABC' }, 'db3664c219a6e350b00ab08d7f723a79', 'comments/addcomment'],
  ]) {
    const handler = require(`../server/module/${name}.js`);
    const calls = [];
    await handler({ ...params, content: 'hello', cookie: { userid: '123', token: 'test' } }, async config => {
      calls.push(config);
      return { status: 200, body: { status: 1, childrenid: 'resolved-id', list: [{ special_child_name: 'song' }] } };
    });
    assert.equal(calls.length, 2);
    const sent = calls[1];
    assert.equal(sent.params.childrenid, 'resolved-id');
    assert.equal(sent.params.code, expectedCode);
    assert.equal(sent.params.r, expectedAction);
    assert.equal(sent.params.clienttoken, 'test');
    if (name !== 'video_barrage_send') {
      assert.equal(sent.method, 'POST');
      assert.equal(JSON.parse(sent.data).data.content, 'hello');
    } else assert.equal(sent.params.content, 'hello');
  }
});

test('album and playlist send directly with known id and name; blank content never reaches network', async () => {
  for (const name of ['comment_album_send', 'comment_playlist_send']) {
    const handler = require(`../server/module/${name}.js`);
    const calls = [];
    await handler({ id: '42', name: 'resource', content: 'hello', cookie: {} }, async config => { calls.push(config); return {}; });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.childrenid, '42');
  }
  for (const name of ['comment_music_send', 'comment_album_send', 'comment_playlist_send', 'song_barrage_send', 'video_barrage_send']) {
    const result = await require(`../server/module/${name}.js`)({ content: '  ' }, () => assert.fail('must not request'));
    assert.equal(result.status, 400);
  }
});

test('unresolved barrage hash does not trigger a send', async () => {
  for (const name of ['song_barrage_send', 'video_barrage_send']) {
    let count = 0;
    const result = await require(`../server/module/${name}.js`)({ hash: 'unknown', content: 'hello' }, async () => {
      count++;
      return { body: { status: 1, list: [] } };
    });
    assert.equal(count, 1);
    assert.equal(result.status, 400);
  }
});

test('verification only resolves on an explicit successful business response', async () => {
  const output = buildSync({
    entryPoints: [new URL('../src/renderer/utils/kugouVerification.ts', import.meta.url).pathname],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['vue', '@/utils/logger'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(name => name === 'vue' ? { reactive: value => value } : { error() {} }, module, module.exports);
  const api = module.exports;
  const pending = api.requestKugouVerification('test-event', async path => path === '/get/verify/info'
    ? { status: 1, data: { v_type: 23 } } : { status: 0, err_code: 30791 });
  await Promise.resolve();
  assert.equal(await api.submitKugouVerification('test-code'), false);
  assert.equal(api.kugouVerificationState.open, true);
  api.cancelKugouVerification();
  await assert.rejects(pending, /取消/);
  assert.doesNotThrow(() => api.assertKugouVerificationSuccess({ status: 1, error_code: 0 }));
});

test('floor UI keeps root tid separate from the selected reply pid across all pools', async () => {
  const calls = [];
  const api = client({ post: async (...args) => { calls.push(args); return { status: 1 }; } });
  const root = { id: 'root', tid: 'root-tid', specialId: 'resource', mixSongId: '42' };
  for (const resourceType of ['music', 'album', 'playlist']) {
    await api.sendFloorComment({ root, target: root, content: ' hi ', resourceType });
    await api.sendFloorComment({ root, target: { id: 'child', tid: 'root-tid', userName: 'Alice', content: 'original' }, content: 'reply', resourceType });
  }
  for (let i = 0; i < calls.length; i += 2) {
    const [path, top] = calls[i];
    const [, child] = calls[i + 1];
    assert.equal(path, '/comment/floor/send');
    assert.equal(top.tid, 'root-tid');
    assert.equal(top.pid, 0);
    assert.equal(top.is_t, 1);
    assert.equal(top.content, 'hi');
    assert.equal(child.tid, 'root-tid');
    assert.equal(child.pid, 'child');
    assert.equal(child.is_t, 0);
    assert.equal(child.reply_user_name, 'Alice');
    assert.equal(child.reply_content, 'original');
  }
  assert.equal(calls[0][1].resource_type, 'song');
  assert.equal(calls[2][1].resource_type, 'album');
  assert.equal(calls[4][1].resource_type, 'playlist');
  const invalid = client({ post: () => assert.fail('missing identity must not send') });
  await assert.rejects(invalid.sendFloorComment({ root: { id: 'root' }, target: { id: 'root' }, content: 'hi', resourceType: 'music' }));
});

test('floor module sends the correct pool, root and quoted target in a POST', async () => {
  const handler = require('../server/module/comment_floor_send.js');
  for (const [resource_type, code] of [['song', 'fc4be23b4e972707f36b8a828a93ba8a'], ['album', '94f1792ced1df89aa68a7939eaf2efca'], ['playlist', 'ca53b96fe5a1d9c22d71c8f522ef7c4f']]) {
    const calls = [];
    await handler({ special_id: 'resource', tid: 'root', pid: 'child', content: 'reply', reply_user_name: 'Alice', reply_content: 'original', name: 'name', resource_type, cookie: {} }, async config => { calls.push(config); return { body: { status: 1 } }; });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].params.r, 'commentsv2/reply');
    assert.equal(calls[0].params.code, code);
    assert.equal(calls[0].params.tid, 'root');
    assert.equal(calls[0].params.pid, 'child');
    assert.equal(calls[0].params.content, 'reply//@Alice:original');
  }
});
test('client rejects oversized barrage and comment bodies before making requests', async () => {
  const api = client({ post: async () => assert.fail('oversized content must not reach API') });
  await assert.rejects(api.sendComment({ type: 'song-barrage', hash: 'ABC' }, '😀'.repeat(101)), /100/);
  await assert.rejects(api.sendComment({ type: 'music', id: '42' }, '字'.repeat(201)), /200/);
  await assert.rejects(api.sendFloorComment({ root: {}, target: {}, content: '字'.repeat(201), resourceType: 'music' }), /200/);
  const allowed = client({ post: async () => ({ status: 1, err_code: 0 }) });
  await allowed.sendComment({ type: 'video-barrage', hash: 'ABC' }, '😀'.repeat(100));
  await allowed.sendComment({ type: 'album', id: '42' }, '字'.repeat(200));
});
