import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const read = require('../server/module/user_preference.js');
const update = require('../server/module/user_preference_update.js');

test('copied preference modules use encrypted auth and preserve selective updates/clears', async () => {
  const cookie = {
    userid: '123',
    token: 'test-token',
    KUGOU_API_MID: 'test-mid',
    uuid: 'test-uuid',
    dfid: 'test-dfid',
  };
  const capture = async (config) => config;
  const query = await read({ cookie }, capture);
  assert.equal(query.url, '/userpreferservice/v1/get_user_conf');
  assert.equal(query.data.userid, 123);
  assert.equal(query.params.mid, 'test-mid');
  assert.equal(query.params.token, undefined);
  assert.equal(query.clearDefaultParams, true);
  assert.equal(query.encryptType, 'android');
  assert.match(query.data.p, /^[0-9a-f]+$/i);
  assert.match(query.data.params, /^[0-9a-f]+$/i);
  assert.equal(JSON.stringify(query.data).includes('test-token'), false);
  const mutation = await update(
    {
      cookie,
      mode: 0,
      song_lang: { L1: 75, S28: 0 },
      age: 0,
      lang: '',
      style: { 1: 100 },
      unrelated: 'ignored',
    },
    capture,
  );
  assert.equal(mutation.method, 'POST');
  assert.equal(mutation.url, '/userpreferservice/v1/update_user_conf');
  assert.deepEqual(mutation.data.data, {
    mode: '0',
    song_lang: '{"L1":75,"S28":0}',
    age: '0',
    lang: '',
    style: '{"1":100}',
  });
  await assert.rejects(update({ cookie }, capture), /至少需要/);
});
