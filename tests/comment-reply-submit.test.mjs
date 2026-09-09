import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/renderer/components/music/CommentList.vue', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function submitFloorReply('), source.indexOf('// 评论内容展开/收起'));
const compiled = transformSync(handler, { loader: 'ts' }).code;
function setup(send, refresh) {
  const root = { id: '1' }, target = { id: '2' };
  const replyRoot = { value: root }, replyTarget = { value: target }, replyBusy = { value: true };
  const state = { expanded: false };
  const submit = new Function('props', 'sendFloorComment', 'replyRoot', 'replyTarget', 'replyBusy', 'getFloorState', 'fetchFloorReplies', `${compiled}; return submitFloorReply;`)(
    { sendFloorReply: send, resourceType: 'music' }, send, replyRoot, replyTarget, replyBusy, () => state, refresh,
  );
  return { submit, replyRoot, replyTarget, replyBusy, state, root, target };
}
test('successful send ends editing before a pending floor refresh can unmount the composer', async () => {
  let finishRefresh;
  const pending = new Promise(resolve => { finishRefresh = resolve; });
  const ui = setup(async () => {}, () => {
    assert.equal(ui.replyRoot.value, null);
    assert.equal(ui.replyTarget.value, null);
    return pending;
  });
  await ui.submit('333');
  assert.equal(ui.replyBusy.value, false);
  assert.equal(ui.state.expanded, true);
  finishRefresh();
  await pending;
  assert.equal(ui.replyTarget.value, null);
});
test('failed send keeps the editor target and does not refresh the list', async () => {
  const ui = setup(async () => { throw new Error('send failed'); }, () => assert.fail('unexpected refresh'));
  await assert.rejects(ui.submit('333'), /send failed/);
  assert.equal(ui.replyRoot.value, ui.root);
  assert.equal(ui.replyTarget.value, ui.target);
  assert.equal(ui.state.expanded, false);
});
