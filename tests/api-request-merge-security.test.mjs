import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const output = buildSync({
  entryPoints: [new URL('../src/shared/apiRequestMerge.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('module', 'exports', output)(loaded, loaded.exports);
const { mergeApiRequestBody } = loaded.exports;

test('request body cannot replace authentication fields', () => {
  const query = {
    cookie: { token: 'header-token' },
    token: 'query-token',
    userid: 'query-user',
    page: '1',
  };
  mergeApiRequestBody(query, {
    cookie: { token: 'body-token' },
    TOKEN: 'body-token',
    userid: 'body-user',
    KUGOU_API_MID: 'body-mid',
    page: 2,
    nickname: 'Echo',
  });

  assert.deepEqual(query.cookie, { token: 'header-token' });
  assert.equal(query.token, 'query-token');
  assert.equal(query.userid, 'query-user');
  assert.equal(query.KUGOU_API_MID, undefined);
  assert.equal(query.page, 2);
  assert.equal(query.nickname, 'Echo');
});

test('request body cannot pollute the request prototype through object meta keys', () => {
  const query = { page: '1' };
  const body = JSON.parse(
    '{"__proto__":{"token":"PWNED","userid":"999","mid":"attacker-mid"},"constructor":{"token":"also-bad"},"prototype":{"token":"also-bad"},"page":2}',
  );

  mergeApiRequestBody(query, body);

  assert.equal(Object.getPrototypeOf(query), Object.prototype);
  assert.equal(query.token, undefined);
  assert.equal(query.userid, undefined);
  assert.equal(query.mid, undefined);
  assert.equal(Object.hasOwn(query, '__proto__'), false);
  assert.equal(Object.hasOwn(query, 'constructor'), false);
  assert.equal(Object.hasOwn(query, 'prototype'), false);
  assert.equal(query.page, 2);
});
