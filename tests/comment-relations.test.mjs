import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const source = buildSync({ entryPoints: [new URL('../src/renderer/utils/commentRelations.ts', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { groupCommentRelations, mergeFloorReplies } = module.exports;
const root = { id: '14270239', content: '好听', raw: {} };
const preview = { id: '14270249', content: '111', raw: { pid: 14270239 } };
const floor = { id: '774320303', content: '111', raw: { tid: 14270239, pid: 0, ori_cmt_id: 14270249 } };
test('response fixture groups a main-list reply and keeps the floor ID after merging', () => {
  const result = groupCommentRelations([preview, root]);
  assert.deepEqual(result.roots, [root]);
  assert.deepEqual(result.replies.get(root.id), [preview]);
  assert.deepEqual(mergeFloorReplies([preview], [floor, floor]), [floor]);
});
test('pagination retains an orphan then groups it once its parent arrives', () => {
  assert.deepEqual(groupCommentRelations([preview]).roots, [preview]);
  assert.deepEqual(groupCommentRelations([preview, root]).roots, [root]);
  assert.deepEqual(mergeFloorReplies([preview], []), [preview]);
});
test('equal text is not identity; cyclic parents do not hide comments or hang', () => {
  const other = { ...preview, id: '99' };
  assert.deepEqual(mergeFloorReplies([preview, other], [floor]), [floor, other]);
  const a = { id: '1', raw: { pid: 2 } }, b = { id: '2', raw: { pid: 1 } };
  assert.deepEqual(groupCommentRelations([a, b]).roots, [a, b]);
});
const { presentFloorReply } = module.exports;
test('floor reply separates body and quote, preferring the actual pid target', () => {
  const reply = { id: '888', content: '333//@old-name:111', raw: { pid: 774320303, is_reply: 1 } };
  const target = { ...floor, userName: 'whoami' };
  assert.deepEqual(presentFloorReply(reply, [target]), {
    body: '333', quote: { userName: 'whoami', content: '111' },
  });
  assert.equal(reply.content, '333//@old-name:111');
  assert.equal(reply.id, '888');
  assert.deepEqual(presentFloorReply(reply, []), {
    body: '333', quote: { userName: 'old-name', content: '111' },
  });
});
test('ordinary content and malformed quotes stay intact; nested references remain in quoted text', () => {
  const content = 'example //@name:text';
  assert.deepEqual(presentFloorReply({ content, raw: {} }, []), { body: content, quote: undefined });
  assert.equal(presentFloorReply({ content: '333//@name', raw: { pid: 1 } }, []).body, '333//@name');
  assert.deepEqual(presentFloorReply({ content: '333//@name:111\n//@other:222', raw: { pid: 1 } }, []), {
    body: '333', quote: { userName: 'name', content: '111\n//@other:222' },
  });
});
test('floor replies sort chronologically across ranked pages and main-list previews', () => {
  const one = { ...floor, time: '2026-09-09 14:08:20' };
  const two = { id: '20', content: '222', time: '2026-09-09 14:20:45' };
  const three = { id: '30', content: '333', time: '2026-09-09 14:21:01' };
  const four = { id: '40', content: '444', time: '2026-09-09 14:26:46' };
  const incoming = [three, four, one];
  const first = mergeFloorReplies([two, { ...preview, time: one.time }], incoming);
  assert.deepEqual(first, [one, two, three, four]);
  assert.deepEqual(mergeFloorReplies([], [...first, two, three]), first);
  assert.deepEqual(incoming, [three, four, one]);
});
test('equal timestamps and missing dates retain stable order without losing records', () => {
  const a = { id: '1', time: '2026-09-09 14:00:00' };
  const b = { id: '2', time: a.time };
  const c = { id: '3', time: 'invalid' }, d = { id: '4' };
  assert.deepEqual(mergeFloorReplies([], [c, a, d, b]), [a, b, c, d]);
});
test('singer reply uses explicit thread tid rather than the quoted reply pid', () => {
  const singer = { id: '1060329201', content: '远山少年原唱是我～//@佳的太阳:黄文文的远山少年吗', raw: { pid: 732952861, tid: 1690487954 } };
  assert.equal(module.exports.mainCommentParentId(singer), '1690487954');
  const parent = { id: '1690487954', raw: {} };
  const grouped = groupCommentRelations([singer, parent]);
  assert.deepEqual(grouped.roots, [parent]);
  assert.deepEqual(grouped.replies.get(parent.id), [singer]);
  assert.deepEqual(presentFloorReply(singer, []), { body: '远山少年原唱是我～', quote: { userName: '佳的太阳', content: '黄文文的远山少年吗' } });
});
