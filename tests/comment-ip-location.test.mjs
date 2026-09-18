import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const source = buildSync({
  entryPoints: [new URL('../src/renderer/utils/mappers/playlist.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { mapCommentItem } = module.exports;

test('maps IP location from location field', () => {
  const comment = mapCommentItem({
    comment_id: 1,
    user_name: '阿强',
    content: '好听',
    addtime: '2026-09-01 10:00:00',
    location: '广东',
  });
  assert.equal(comment.ipLocation, '广东');
});

test('maps IP location from ip_location alias', () => {
  const comment = mapCommentItem({
    comment_id: 2,
    content: '赞',
    ip_location: '四川',
  });
  assert.equal(comment.ipLocation, '四川');
});

test('missing location stays undefined', () => {
  const empty = mapCommentItem({ comment_id: 3, content: '嗨' });
  assert.equal(empty.ipLocation, undefined);
});
