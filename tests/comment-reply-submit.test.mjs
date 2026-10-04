import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, row, page, deferred, flush } from './helpers/comment-component-fixture.mjs';

function setup(t) {
  const f = fixture(t, 'CommentList', {
    comments: [row(1), row(2, { raw: { pid: 1 } })],
    resourceId: 'resource',
  });
  const [root, target] = f.view.props.comments;
  f.view.startReply(root, target);
  f.view.replyBusy.value = true;
  return { f, root, target };
}
test('successful send ends editing before a pending floor refresh can unmount the composer', async (t) => {
  const { f } = setup(t),
    pending = deferred();
  f.api.getFloorComments = () => {
    assert.equal(f.view.replyRoot.value, null);
    assert.equal(f.view.replyTarget.value, null);
    return pending.promise;
  };
  await f.view.submitFloorReply('333');
  assert.equal(f.view.replyBusy.value, false);
  assert.equal(f.view.getFloorState('1').expanded, true);
  assert.equal(f.notices.length, 1);
  pending.resolve(page([]));
  await flush();
  assert.equal(f.view.replyTarget.value, null);
});
test('failed send keeps the editor target and does not refresh the list', async (t) => {
  const { f, root, target } = setup(t);
  f.api.sendFloorComment = async () => {
    throw new Error('send failed');
  };
  f.api.getFloorComments = () => assert.fail('unexpected refresh');
  await assert.rejects(f.view.submitFloorReply('333'), /send failed/);
  assert.equal(f.view.replyRoot.value, root);
  assert.equal(f.view.replyTarget.value, target);
  assert.equal(f.view.getFloorState('1').expanded, false);
});
