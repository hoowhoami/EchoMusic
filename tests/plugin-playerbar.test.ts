import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ref } from 'vue';
import {
  createPlayerbarApi,
  playerbarItems,
  removePlayerbarItemsByPlugin,
} from '../src/renderer/plugins/playerbar.ts';

afterEach(() => ['a', 'b'].forEach(removePlayerbarItemsByPlugin));

test('playerbar scopes ids, orders entries, and cleans replacement registrations safely', () => {
  const disposers: (() => void)[] = [];
  const a = createPlayerbarApi(
    'a',
    (dispose) => disposers.push(dispose),
    () => {},
  );
  const b = createPlayerbarApi(
    'b',
    () => {},
    () => {},
  );
  const old = a.register({ id: 'open', icon: 'tabler:tools', title: 'Old', onClick() {} });
  a.register({
    id: 'open',
    icon: 'tabler:tools',
    title: 'New',
    defaultPlacement: 'left',
    trigger: 'hover',
    order: 1,
    onClick() {},
  });
  b.register({ id: 'open', icon: 'tabler:tools', title: 'Other', order: 2, onClick() {} });
  old();
  assert.deepEqual(
    playerbarItems.value.map((item) => [item.title, item.defaultPlacement, item.trigger]),
    [
      ['New', 'left', 'hover'],
      ['Other', 'more', 'click'],
    ],
  );
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(
    playerbarItems.value.map((item) => item.pluginId),
    ['b'],
  );
  removePlayerbarItemsByPlugin('b');
  assert.equal(playerbarItems.value.length, 0);
});

test('playerbar visibility, disabled state, and async failures are contained', async () => {
  const visible = ref(true);
  const disabled = ref(false);
  const errors: unknown[] = [];
  let calls = 0;
  const api = createPlayerbarApi(
    'a',
    () => {},
    (_, error) => errors.push(error),
  );
  api.register({
    id: 'open',
    icon: 'tabler:tools',
    title: 'Open',
    visible: () => visible.value,
    disabled: () => disabled.value,
    async onClick() {
      calls++;
      throw new Error('failed');
    },
  });
  const entry = playerbarItems.value[0];
  await entry.onClick();
  disabled.value = true;
  await entry.onClick();
  visible.value = false;
  assert.equal(entry.visible(), false);
  visible.value = true;
  disabled.value = false;
  removePlayerbarItemsByPlugin('a');
  await entry.onClick();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(entry.busy(), false);
});

test('playerbar validates icon and placement', () => {
  const api = createPlayerbarApi(
    'a',
    () => {},
    () => {},
  );
  assert.throws(() => api.register({ id: 'x', title: 'X', onClick() {} } as never));
  assert.throws(() =>
    api.register({
      id: 'x',
      title: 'X',
      icon: 'tabler:tools',
      defaultPlacement: 'toolbar',
      onClick() {},
    } as never),
  );
  assert.throws(() =>
    api.register({
      id: 'x',
      title: 'X',
      icon: 'tabler:tools',
      trigger: 'focus',
      onClick() {},
    } as never),
  );
  api.register({ id: 'x', title: 'X', icon: 'tabler:tools', onClick() {} });
  assert.equal(playerbarItems.value[0].tooltip, 'X');
  assert.equal(playerbarItems.value[0].defaultPlacement, 'more');
  assert.equal(playerbarItems.value[0].trigger, 'click');
});

test('playerbar supports plugin badges and reports badge failures', () => {
  const errors: unknown[] = [];
  const count = ref(3);
  const api = createPlayerbarApi(
    'a',
    () => {},
    (_, error) => errors.push(error),
  );
  api.register({
    id: 'badge',
    title: 'Badge',
    icon: 'tabler:tools',
    badgeTitle: '插件徽标',
    badgeDefaultVisible: false,
    badge: () => count.value,
    onClick() {},
  });
  api.register({
    id: 'bad-badge',
    title: 'Bad badge',
    icon: 'tabler:tools',
    badge() {
      throw new Error('badge');
    },
    onClick() {},
  });

  const [badge, badBadge] = playerbarItems.value;
  assert.equal(badge.badge(), '3');
  assert.equal(badge.badgeTitle, '插件徽标');
  assert.equal(badge.badgeDefaultVisible, false);
  count.value = 12;
  assert.equal(badge.badge(), '12');
  assert.equal(badBadge.badge(), null);
  assert.equal(errors.length, 1);
});
