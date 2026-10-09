import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { userSession, userSessionWatch } from './helpers/user-session.mjs';

const { captureUserSession, userSessionSources } = userSession;
const { watchUserSession } = userSessionWatch;
const fixture = (t) => {
  const user = reactive({
    isLoggedIn: true,
    accountRevision: 1,
    info: { userid: 7, token: 'one', nickname: 'A' },
  });
  const scope = effectScope();
  t.after(() => scope.stop());
  return { user, scope };
};

for (const field of ['login', 'revision', 'userid', 'userId', 'token']) {
  test(`${field} invalidates the captured session and notifies with previous identity`, (t) => {
    const { user, scope } = fixture(t);
    if (field === 'userId') user.info = { userId: 7, token: 'one' };
    const current = captureUserSession(user);
    const calls = [];
    scope.run(() => watchUserSession(user, (...args) => calls.push(args), { flush: 'sync' }));
    if (field === 'login') user.isLoggedIn = false;
    else if (field === 'revision') user.accountRevision++;
    else if (field === 'token') user.info.token = 'two';
    else user.info[field] = 8;
    assert.equal(current(), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], {
      isLoggedIn: true,
      accountRevision: 1,
      userId: '7',
      token: 'one',
    });
  });
}

test('same-session profile replacement and numeric/string aliases do not trigger a reset', async (t) => {
  const { user, scope } = fixture(t);
  const current = captureUserSession(user);
  const calls = [];
  scope.run(() => watchUserSession(user, (...args) => calls.push(args), { flush: 'sync' }));
  user.info = { ...user.info, nickname: 'updated', pic: 'new', vip: { is_vip: 1 } };
  user.info = { userId: '7', token: 'one', nickname: 'same account' };
  await nextTick();
  assert.equal(current(), true);
  assert.equal(calls.length, 0);
});

test('default scheduling batches store updates and immediate mode has no previous session', async (t) => {
  const { user, scope } = fixture(t);
  const calls = [];
  scope.run(() => watchUserSession(user, (...args) => calls.push(args), { immediate: true }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], undefined);
  user.accountRevision++;
  user.info = { userid: 8, token: 'two' };
  user.isLoggedIn = false;
  assert.equal(calls.length, 1);
  await nextTick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][0], {
    isLoggedIn: false,
    accountRevision: 2,
    userId: '8',
    token: 'two',
  });
  assert.equal(calls[1][1].userId, '7');
});

test('A to B to A never revalidates an old operation', async (t) => {
  const { user, scope } = fixture(t);
  const old = captureUserSession(user);
  const calls = [];
  scope.run(() => watchUserSession(user, (value) => calls.push(value), { flush: 'sync' }));
  user.accountRevision++;
  user.info = { userid: 8, token: 'two' };
  user.accountRevision++;
  user.info = { userid: 7, token: 'one' };
  await nextTick();
  assert.equal(old(), false);
  assert.equal(calls.at(-1).userId, '7');
  assert.equal(calls.at(-1).accountRevision, 3);
});

test('cleanup and explicit stop invalidate work; scope disposal removes cached view subscribers', (t) => {
  const { user, scope } = fixture(t);
  let notifications = 0;
  let cleanup = 0;
  const stop = scope.run(() =>
    watchUserSession(
      user,
      (_, __, onCleanup) => {
        notifications++;
        onCleanup(() => cleanup++);
      },
      { immediate: true, flush: 'sync' },
    ),
  );
  user.accountRevision++;
  assert.equal(cleanup, 1);
  stop();
  assert.equal(cleanup, 2);
  user.accountRevision++;
  assert.equal(notifications, 2);
  scope.run(() => watchUserSession(user, () => notifications++, { flush: 'sync' }));
  scope.stop();
  user.accountRevision++;
  assert.equal(notifications, 2);
});

test('mixed resource watchers keep their own conditions and use the same session identity', (t) => {
  const { user, scope } = fixture(t);
  const resource = ref('album:1');
  const calls = [];
  scope.run(() =>
    watch([resource, ...userSessionSources(user)], ([id]) => calls.push(id), { flush: 'sync' }),
  );
  resource.value = 'album:2';
  user.info = { ...user.info, nickname: 'new profile' };
  user.info.token = 'two';
  assert.deepEqual(calls, ['album:2', 'album:2']);
});
