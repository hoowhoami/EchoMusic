import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  row,
  page,
  deferred,
  flush,
  bounded,
} from './helpers/comment-component-fixture.mjs';

for (const kind of ['CommentComposer', 'FloorReplyComposer']) {
  const isFloor = kind === 'FloorReplyComposer';
  const setup = (t) =>
    fixture(
      t,
      kind,
      isFloor ? { target: row(1), send: async () => {} } : { resource: { type: 'music', id: 'A' } },
    );
  const draft = (f) => (isFloor ? f.view.draft : f.view.content);
  const busy = (f) => (isFloor ? f.view.busy : f.view.sending);
  const send = (f, fn) => {
    if (isFloor) f.props.send = fn;
    else f.api.sendComment = fn;
  };
  const changeTarget = (f) => {
    if (isFloor) f.props.target = row(2);
    else f.props.resource = { type: 'album', id: 'B' };
  };
  for (const change of ['resource', 'revision', 'token', 'userId', 'logout', 'unmount']) {
    for (const reject of [false, true]) {
      test(`round11: ${kind} ${change} ignores stale ${reject ? 'failure' : 'success'}`, async (t) => {
        const f = setup(t),
          task = deferred();
        draft(f).value = 'old draft';
        send(f, () => task.promise);
        await flush();
        const request = f.view.submit();
        if (change === 'resource') {
          changeTarget(f);
          await flush();
        }
        if (change === 'revision') f.user.accountRevision++;
        if (change === 'token') f.user.info.token = 'two';
        if (change === 'userId') f.user.info.userid = 8;
        if (change === 'logout') f.user.isLoggedIn = false;
        if (change === 'unmount') f.stop();
        draft(f).value = 'new draft';
        if (reject) task.reject(new Error('old failure'));
        else task.resolve();
        await request;
        assert.equal(draft(f).value, 'new draft');
        assert.deepEqual(f.notices, []);
        assert.deepEqual(f.emitted, []);
      });
    }
  }
  test(`round11: ${kind} old completion cannot release a new account send`, async (t) => {
    const f = setup(t),
      old = deferred(),
      fresh = deferred();
    let calls = 0;
    send(f, () => (++calls === 1 ? old.promise : fresh.promise));
    await flush();
    draft(f).value = 'old';
    const first = f.view.submit();
    f.user.accountRevision++;
    draft(f).value = 'new';
    const second = f.view.submit();
    assert.equal(calls, 2);
    old.resolve();
    await first;
    assert.equal(busy(f).value, true);
    assert.equal(draft(f).value, 'new');
    fresh.resolve();
    await second;
    assert.equal(busy(f).value, false);
    assert.equal(draft(f).value, '');
    assert.equal(f.notices.length, 1);
    assert.equal(f.emitted.length, 1);
  });
  test(`round11: ${kind} successful submission preserves a replaced draft`, async (t) => {
    const f = setup(t),
      task = deferred(),
      calls = [];
    send(f, (...args) => {
      calls.push(args);
      return task.promise;
    });
    await flush();
    draft(f).value = '  original  ';
    const request = f.view.submit();
    draft(f).value = 'new draft';
    task.resolve();
    await request;
    assert.equal(draft(f).value, 'new draft');
    assert.equal(f.notices.length, 1);
    assert.equal(calls[0][isFloor ? 0 : 1], 'original');
  });
  test(`round11: ${kind} unchanged submission clears only its own draft and blocks duplicates`, async (t) => {
    const f = setup(t),
      task = deferred();
    let calls = 0;
    send(f, () => {
      calls++;
      return task.promise;
    });
    await flush();
    draft(f).value = 'text';
    const first = f.view.submit();
    await f.view.submit();
    assert.equal(calls, 1);
    task.resolve();
    await first;
    assert.equal(draft(f).value, '');
    assert.equal(busy(f).value, false);
    assert.equal(f.emitted.length, 1);
  });
  test(`round11: ${kind} current failure retains draft and allows retry`, async (t) => {
    const f = setup(t);
    send(f, async () => {
      throw new Error('retry please');
    });
    await flush();
    draft(f).value = 'draft';
    await f.view.submit();
    assert.equal(draft(f).value, 'draft');
    assert.equal(busy(f).value, false);
    assert.equal(f.notices[0][1], 'retry please');
    send(f, async () => {});
    await flush();
    await f.view.submit();
    assert.equal(draft(f).value, '');
  });
  test(`round11: ${kind} ordinary profile update preserves draft and current send`, async (t) => {
    const f = setup(t),
      task = deferred();
    send(f, () => task.promise);
    await flush();
    draft(f).value = 'draft';
    const request = f.view.submit();
    f.user.info = { ...f.user.info, nickname: 'new name' };
    task.resolve();
    await request;
    assert.equal(draft(f).value, '');
    assert.equal(f.notices.length, 1);
  });
}

const setupList = (t) =>
  fixture(t, 'CommentList', { comments: [row(1)], resourceId: 'A', fallbackMixSongId: 'mix-A' });
const root = (f) => f.view.props.comments[0];
for (const change of ['resource', 'pool', 'revision', 'token', 'removed', 'unmount']) {
  for (const reject of [false, true]) {
    test(`round11: floor ${change} ignores stale ${reject ? 'failure' : 'success'}`, async (t) => {
      const f = setupList(t),
        task = deferred();
      f.api.getFloorComments = () => task.promise;
      const request = f.view.fetchFloorReplies(root(f), true);
      if (change === 'resource') f.props.resourceId = 'B';
      if (change === 'pool') f.props.comments = [row(1, { specialId: 'other-pool' })];
      if (change === 'removed') f.props.comments = [];
      if (change === 'revision') f.user.accountRevision++;
      if (change === 'token') f.user.info.token = 'two';
      if (change === 'unmount') f.stop();
      await flush();
      if (reject) task.reject(new Error('old failure'));
      else task.resolve(page([row(2)]));
      await request;
      assert.equal(f.view.floorStates.size, 0);
      assert.deepEqual(f.notices, []);
    });
  }
}
test('round11: first floor failure stays uninitialized and retry uses the same page', async (t) => {
  const f = setupList(t),
    calls = [];
  let failed = true;
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    if (failed) throw new Error('temporary');
    return page([row(2)]);
  };
  await f.view.fetchFloorReplies(root(f), true);
  const state = f.view.getFloorState('1');
  assert.equal(state.initialized, false);
  assert.equal(state.loading, false);
  assert.equal(state.hasMore, true);
  failed = false;
  await f.view.fetchFloorReplies(root(f));
  assert.deepEqual(calls, [1, 1]);
  assert.equal(state.initialized, true);
});
test('round11: floor reset during a pending request replaces it without losing its loading flag', async (t) => {
  const f = setupList(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.getFloorComments = () => (++calls === 1 ? old.promise : fresh.promise);
  const first = f.view.fetchFloorReplies(root(f), true);
  const second = f.view.fetchFloorReplies(root(f), true);
  assert.equal(calls, 2);
  old.resolve(page([row(2)]));
  await first;
  assert.equal(f.view.getFloorState('1').loading, true);
  fresh.resolve(page([row(3)]));
  await second;
  assert.deepEqual(
    f.view.getFloorState('1').replies.map((r) => r.id),
    ['3'],
  );
});
test('round11: empty floor page ends pagination despite a stale positive total', async (t) => {
  const f = setupList(t);
  f.api.getFloorComments = async () => page([], 99);
  await f.view.fetchFloorReplies(root(f), true);
  assert.equal(f.view.getFloorState('1').hasMore, false);
});
test('round11: floor pagination counts raw records when duplicate replies are merged', async (t) => {
  const f = setupList(t),
    calls = [];
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    return page(req.page === 1 ? Array.from({ length: 30 }, () => row(2)) : [row(3)], 31);
  };
  await f.view.fetchFloorReplies(root(f), true);
  await f.view.fetchFloorReplies(root(f));
  assert.deepEqual(
    f.view.getFloorState('1').replies.map((r) => r.id),
    ['2', '3'],
  );
  assert.equal(f.view.getFloorState('1').hasMore, false);
  assert.deepEqual(calls, [1, 2]);
});
test('round11: floor VIP does not block paging and only patches identity fields across later pages', async (t) => {
  const f = setupList(t),
    vip = deferred();
  t.after(() => vip.resolve([]));
  f.setVip((rows) => (rows.length === 30 ? vip.promise : Promise.resolve(rows)));
  f.api.getFloorComments = async (req) =>
    page(req.page === 1 ? Array.from({ length: 30 }, (_, i) => row(i + 2)) : [row(99)], 31);
  await bounded(f.view.fetchFloorReplies(root(f), true));
  const state = f.view.getFloorState('1');
  state.replies[0].likeCount = 8;
  await f.view.fetchFloorReplies(root(f));
  vip.resolve(Array.from({ length: 30 }, (_, i) => row(i + 2, { likeCount: 0, badges: ['VIP'] })));
  await flush();
  assert.equal(state.replies.length, 31);
  assert.deepEqual(state.replies[0].badges, ['VIP']);
  assert.equal(state.replies[0].likeCount, 8);
});
test('round11: replaced main-list objects keep existing floor and editor state', async (t) => {
  const f = setupList(t);
  f.api.getFloorComments = async () => page([row(2)]);
  await f.view.fetchFloorReplies(root(f), true);
  const state = f.view.getFloorState('1');
  f.view.startReply(root(f));
  f.props.comments = [row(1, { badges: ['VIP'] }), row(3, { raw: { pid: 1 } })];
  await flush();
  assert.equal(f.view.getFloorState('1'), state);
  assert.equal(f.view.replyTarget.value.id, '1');
});
for (const change of ['resource', 'revision', 'token', 'removed', 'unmount']) {
  for (const reject of [false, true]) {
    test(`round11: delete ${change} ignores stale ${reject ? 'failure' : 'success'}`, async (t) => {
      const f = setupList(t),
        task = deferred();
      f.api.deleteComment = () => task.promise;
      const request = f.view.handleDeleteComment(root(f));
      if (change === 'resource') f.props.resourceId = 'B';
      if (change === 'revision') f.user.accountRevision++;
      if (change === 'token') f.user.info.token = 'two';
      if (change === 'removed') f.props.comments = [];
      if (change === 'unmount') f.stop();
      await flush();
      if (reject) task.reject(new Error('old delete'));
      else task.resolve();
      await request;
      f.runTimers();
      assert.deepEqual(f.notices, []);
      assert.deepEqual(f.emitted, []);
    });
  }
}
for (const change of ['resource', 'revision', 'unmount']) {
  test(`round11: delete delayed refresh is cancelled by ${change}`, async (t) => {
    const f = setupList(t);
    await f.view.handleDeleteComment(root(f));
    assert.equal(f.timers.size, 1);
    if (change === 'resource') f.props.resourceId = 'B';
    if (change === 'revision') f.user.accountRevision++;
    if (change === 'unmount') f.stop();
    await flush();
    assert.equal(f.timers.size, 0);
    f.runTimers();
    assert.deepEqual(f.emitted, []);
  });
}
test('round11: successful delete keeps the 450ms refresh and duplicate clicks submit once', async (t) => {
  const f = setupList(t),
    task = deferred();
  let calls = 0;
  f.api.deleteComment = () => {
    calls++;
    return task.promise;
  };
  const first = f.view.handleDeleteComment(root(f));
  await f.view.handleDeleteComment(root(f));
  assert.equal(calls, 1);
  task.resolve();
  await first;
  assert.equal([...f.timers.values()][0].delay, 450);
  f.runTimers();
  assert.equal(f.emitted[0][0], 'deleted');
  assert.equal(f.emitted[0][1].id, '1');
});
for (const change of ['resource', 'revision', 'removed', 'unmount']) {
  test(`round11: reply ${change} does not close a new editor or refresh its floor`, async (t) => {
    const f = setupList(t),
      task = deferred();
    f.api.sendFloorComment = () => task.promise;
    f.view.startReply(root(f));
    const request = f.view.submitFloorReply('old reply');
    if (change === 'resource') f.props.resourceId = 'B';
    if (change === 'revision') f.user.accountRevision++;
    if (change === 'removed') f.props.comments = [];
    if (change === 'unmount') f.stop();
    await flush();
    if (change !== 'unmount') {
      f.props.comments = [row(4)];
      await flush();
      f.view.startReply(root(f));
    }
    task.resolve();
    await request;
    assert.deepEqual(f.notices, []);
    assert.equal(f.calls.filter((c) => c[0] === 'floor').length, 0);
    if (change !== 'unmount') assert.equal(f.view.replyTarget.value.id, '4');
  });
}

for (const reject of [false, true]) {
  test(`control: barrage outer owner survives verification input unmount and handles ${reject ? 'failure' : 'success'}`, async (t) => {
    const parent = fixture(t, 'BarrageControls', { resource: { type: 'song-barrage', hash: 'A' } });
    const task = deferred();
    parent.api.sendComment = () => task.promise;
    parent.view.draft.value = 'barrage';
    parent.view.open.value = true;
    const child = fixture(
      t,
      'CommentComposer',
      {
        resource: parent.props.resource,
        content: parent.view.draft.value,
        sending: parent.view.sending.value,
        submitRequest: parent.view.submitComment,
        'onUpdate:content': (value) => {
          parent.view.draft.value = value;
        },
        'onUpdate:sending': (value) => {
          parent.view.sending.value = value;
        },
      },
      { user: parent.user },
    );
    const request = child.view.submit();
    assert.equal(parent.view.sending.value, true);
    parent.verification.open = true;
    await flush();
    assert.equal(parent.view.open.value, false);
    child.stop();
    if (reject) task.reject(new Error('retry barrage'));
    else task.resolve();
    await request;
    assert.equal(parent.view.sending.value, false);
    assert.equal(parent.view.draft.value, reject ? 'barrage' : '');
    assert.equal(parent.notices.length, 1);
    assert.equal(child.notices.length, 0);
    assert.equal(parent.emitted.length, reject ? 0 : 1);
    parent.verification.open = false;
    await flush();
    assert.equal(parent.view.open.value, reject);
  });
}
test('control: barrage owner disposal ignores pending results without resetting another owner', async (t) => {
  const f = fixture(t, 'BarrageControls', { resource: { type: 'video-barrage', hash: 'A' } }),
    task = deferred();
  f.api.sendComment = () => task.promise;
  f.view.draft.value = 'old';
  const request = f.view.submitComment();
  f.stop();
  task.resolve();
  await request;
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.emitted, []);
});
test('control: barrage account change invalidates pending send and resets retry state', async (t) => {
  const f = fixture(t, 'BarrageControls', { resource: { type: 'song-barrage', hash: 'A' } }),
    task = deferred();
  f.api.sendComment = () => task.promise;
  f.view.draft.value = 'old';
  const request = f.view.submitComment();
  f.user.accountRevision++;
  assert.equal(f.view.sending.value, false);
  f.view.draft.value = 'new';
  task.resolve();
  await request;
  assert.equal(f.view.draft.value, 'new');
  assert.deepEqual(f.notices, []);
});

test('round11: late floor VIP does not refill a replaced resource with reused comment IDs', async (t) => {
  const f = setupList(t),
    vip = deferred();
  t.after(() => vip.resolve([]));
  f.setVip((rows) => (rows.length ? vip.promise : Promise.resolve([])));
  f.api.getFloorComments = async () => page([row(2)]);
  await bounded(f.view.fetchFloorReplies(root(f), true));
  f.props.resourceId = 'B';
  await flush();
  f.setVip(async (rows) => rows);
  f.api.getFloorComments = async () => page([row(2, { content: 'new floor' })]);
  await f.view.fetchFloorReplies(root(f), true);
  vip.resolve([row(2, { content: 'old VIP', badges: ['VIP'] })]);
  await flush();
  assert.equal(f.view.getFloorState('1').replies[0].content, 'new floor');
  assert.equal(f.view.getFloorState('1').replies[0].badges, undefined);
});
test('round11: delete failure preserves actionable comment and permits retry', async (t) => {
  const f = setupList(t);
  f.api.deleteComment = async () => {
    throw new Error('try again');
  };
  await f.view.handleDeleteComment(root(f));
  assert.equal(f.view.isDeletingComment(root(f)), false);
  assert.equal(f.view.canDeleteComment(root(f)), true);
  assert.equal(f.notices[0][1], 'try again');
  assert.equal(f.timers.size, 0);
  f.api.deleteComment = async () => {};
  await f.view.handleDeleteComment(root(f));
  assert.equal(f.timers.size, 1);
});
test('round11: old delete completion does not unlock a newer session delete with the same ID', async (t) => {
  const f = setupList(t),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  f.api.deleteComment = () => (++calls === 1 ? old.promise : fresh.promise);
  const first = f.view.handleDeleteComment(root(f));
  f.user.accountRevision++;
  const second = f.view.handleDeleteComment(root(f));
  assert.equal(calls, 2);
  old.resolve();
  await first;
  assert.equal(f.view.isDeletingComment(root(f)), true);
  fresh.resolve();
  await second;
  assert.equal(f.view.isDeletingComment(root(f)), false);
  assert.equal(f.notices.length, 1);
});
test('round11: removing a floor reply refreshes its actual visible root', async (t) => {
  const f = setupList(t),
    requests = [];
  f.api.getFloorComments = async (req) => {
    requests.push(req);
    return page([row(2, { tid: '1' })]);
  };
  await f.view.fetchFloorReplies(root(f), true);
  const reply = f.view.getFloorState('1').replies[0];
  await f.view.handleDeleteComment(reply);
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].tid, '1');
  assert.equal(requests[1].specialId, 'pool');
  assert.equal(requests[1].page, 1);
});
test('round11: logged-out cached user ID and stale row cannot initiate deletion', async (t) => {
  const f = setupList(t),
    original = root(f);
  f.user.isLoggedIn = false;
  await f.view.handleDeleteComment(original);
  f.user.isLoggedIn = true;
  f.props.comments = [];
  await flush();
  await f.view.handleDeleteComment(original);
  assert.equal(f.calls.filter((c) => c[0] === 'delete').length, 0);
});
test('round11: metadata-only resource update preserves current comment send', async (t) => {
  const f = fixture(t, 'CommentComposer', {
      resource: { type: 'album', id: 'A', name: 'old title' },
    }),
    task = deferred();
  f.api.sendComment = () => task.promise;
  f.view.content.value = 'draft';
  const request = f.view.submit();
  f.props.resource = { type: 'album', id: 'A', name: 'new title' };
  await flush();
  task.resolve();
  await request;
  assert.equal(f.view.content.value, '');
  assert.equal(f.notices.length, 1);
  assert.equal(f.emitted.length, 1);
});
test('round11: current reply success closes editing before refresh and emits one notice', async (t) => {
  const f = setupList(t);
  f.api.getFloorComments = async () => {
    throw new Error('refresh failed');
  };
  f.view.startReply(root(f));
  await f.view.submitFloorReply('submitted');
  await flush();
  assert.equal(f.view.replyTarget.value, null);
  assert.equal(f.view.replyBusy.value, false);
  assert.equal(f.notices.filter((n) => n[0] === 'show').length, 1);
  assert.equal(f.notices.filter((n) => n[0] === 'loadFailed').length, 1);
});
test('control: first-page floor failure exposes a retry with no replies', async (t) => {
  const f = setupList(t),
    calls = [];
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    throw new Error('temporary');
  };
  await f.view.fetchFloorReplies(root(f), true);
  assert.equal(f.view.canLoadMoreFloor(root(f)), true);
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    return page([row(2)]);
  };
  await f.view.loadMoreFloor(root(f));
  assert.deepEqual(calls, [1, 1]);
  assert.equal(f.view.canLoadMoreFloor(root(f)), false);
});
test('control: failed refresh of a terminal floor exposes first-page retry', async (t) => {
  const f = setupList(t),
    calls = [];
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    return page([row(2)]);
  };
  await f.view.fetchFloorReplies(root(f), true);
  f.api.getFloorComments = async () => {
    throw new Error('temporary');
  };
  await f.view.fetchFloorReplies(root(f), true);
  assert.equal(f.view.canLoadMoreFloor(root(f)), true);
  f.api.getFloorComments = async (req) => {
    calls.push(req.page);
    return page([row(3)]);
  };
  await f.view.loadMoreFloor(root(f));
  assert.deepEqual(calls, [1, 1]);
  assert.deepEqual(
    f.view.getFloorState('1').replies.map((r) => r.id),
    ['3'],
  );
});

for (const kind of ['CommentComposer', 'FloorReplyComposer']) {
  test(`control: ${kind} refuses invalid input and still accepts the Unicode character limit`, async (t) => {
    const floor = kind === 'FloorReplyComposer';
    let calls = 0;
    const f = fixture(
      t,
      kind,
      floor
        ? {
            target: row(1),
            send: async () => {
              calls++;
            },
          }
        : { resource: { type: 'music', id: 'A' } },
    );
    if (!floor)
      f.api.sendComment = async () => {
        calls++;
      };
    const draft = floor ? f.view.draft : f.view.content;
    for (const content of ['   ', '🙂'.repeat(201)]) {
      draft.value = content;
      await f.view.submit();
    }
    f.user.isLoggedIn = false;
    draft.value = 'text';
    await f.view.submit();
    assert.equal(calls, 0);
    f.user.isLoggedIn = true;
    draft.value = '🙂'.repeat(200);
    await f.view.submit();
    assert.equal(calls, 1);
    assert.equal(draft.value, '');
  });
}
test('control: reply input unmount after parent success does not duplicate feedback or retain busy state', async (t) => {
  const parent = setupList(t);
  parent.view.startReply(root(parent));
  let child;
  child = fixture(
    t,
    'FloorReplyComposer',
    {
      target: parent.view.replyTarget.value,
      notifySuccess: false,
      busy: parent.view.replyBusy.value,
      'onUpdate:busy': (value) => {
        parent.view.replyBusy.value = value;
      },
      send: async (text) => {
        await parent.view.submitFloorReply(text);
        child.stop();
      },
    },
    { user: parent.user },
  );
  child.view.draft.value = 'reply';
  await child.view.submit();
  await flush();
  assert.equal(parent.view.replyBusy.value, false);
  assert.equal(parent.view.replyTarget.value, null);
  assert.equal(parent.notices.filter((n) => n[0] === 'show').length, 1);
  assert.deepEqual(child.notices, []);
});

for (const success of [false, true]) {
  test(`layout-managed barrage keeps its owner during verification and ${success ? 'reports success' : 'reopens for retry'}`, async (t) => {
    const f = fixture(t, 'BarrageControls', {
      resource: { type: 'song-barrage', hash: 'A' },
      open: true,
    });
    const task = deferred();
    f.api.sendComment = () => task.promise;
    f.view.draft.value = 'managed barrage';
    const request = f.view.submitComment();
    f.verification.open = true;
    await flush();
    assert.equal(f.view.open.value, false);
    assert.deepEqual(f.emitted, [], 'temporary verification closure must not dismiss the owner');
    if (success) task.resolve();
    else task.reject(new Error('retry barrage'));
    await request;
    f.verification.open = false;
    await flush();
    assert.equal(f.view.open.value, !success);
    assert.equal(f.view.draft.value, success ? '' : 'managed barrage');
    assert.deepEqual(
      f.emitted,
      success
        ? [
            ['update:open', false],
            ['sent', 'managed barrage'],
          ]
        : [],
    );
  });
}

test('layout-managed barrage synchronizes external opening and reports user dismissal', async (t) => {
  const f = fixture(t, 'BarrageControls', {
    resource: { type: 'song-barrage', hash: 'A' },
    open: false,
  });
  f.props.open = true;
  await flush();
  assert.equal(f.view.open.value, true);
  f.view.updateOpen(false);
  assert.equal(f.view.open.value, false);
  assert.deepEqual(f.emitted, [['update:open', false]]);
});

test('uncontrolled video barrage retains its internal open behavior', (t) => {
  const f = fixture(t, 'BarrageControls', { resource: { type: 'video-barrage', hash: 'A' } });
  f.view.updateOpen(true);
  assert.equal(f.view.open.value, true);
  f.view.updateOpen(false);
  assert.equal(f.view.open.value, false);
  assert.deepEqual(f.emitted, []);
});
