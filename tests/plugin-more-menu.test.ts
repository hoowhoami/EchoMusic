import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ref } from 'vue';
import {
  createMoreMenuApi,
  pluginMoreMenuItems,
  removeMoreMenuItemsByPlugin,
} from '../src/renderer/plugins/moreMenu.ts';

afterEach(() => ['a', 'b'].forEach(removeMoreMenuItemsByPlugin));

test('more menu scopes ids, orders entries, and cleans replacement registrations safely', () => {
  const disposers: (() => void)[] = [];
  const a = createMoreMenuApi(
    'a',
    (dispose) => disposers.push(dispose),
    () => {},
  );
  const b = createMoreMenuApi(
    'b',
    () => {},
    () => {},
  );
  const old = a.addItem({ id: 'open', title: 'Old', onClick() {} });
  a.addItem({ id: 'open', title: 'New', order: 1, onClick() {} });
  b.addItem({ id: 'open', title: 'Other', order: 2, onClick() {} });
  old();
  assert.deepEqual(
    pluginMoreMenuItems.value.map((item) => item.title),
    ['New', 'Other'],
  );
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(
    pluginMoreMenuItems.value.map((item) => item.pluginId),
    ['b'],
  );
  removeMoreMenuItemsByPlugin('b');
  assert.equal(pluginMoreMenuItems.value.length, 0);
});

test('reactive visibility, disabled actions, and stale entries are respected', async () => {
  const visible = ref(true);
  const disabled = ref(false);
  let calls = 0;
  const api = createMoreMenuApi(
    'a',
    () => {},
    () => {},
  );
  api.addItem({
    id: 'open',
    title: 'Open',
    visible: () => visible.value,
    disabled: () => disabled.value,
    onClick() {
      calls++;
    },
  });
  const entry = pluginMoreMenuItems.value[0];
  await entry.onClick();
  disabled.value = true;
  await entry.onClick();
  visible.value = false;
  assert.equal(pluginMoreMenuItems.value.length, 0);
  visible.value = true;
  disabled.value = false;
  removeMoreMenuItemsByPlugin('a');
  await entry.onClick();
  assert.equal(calls, 1);
});

test('plugin predicate and asynchronous action failures are reported without escaping', async () => {
  const errors: unknown[] = [];
  const api = createMoreMenuApi(
    'a',
    () => {},
    (_, error) => errors.push(error),
  );
  api.addItem({
    id: 'hidden',
    title: 'Hidden',
    visible() {
      throw Error('predicate');
    },
    onClick() {},
  });
  api.addItem({
    id: 'action',
    title: 'Action',
    async onClick() {
      throw Error('action');
    },
  });
  assert.equal(pluginMoreMenuItems.value.length, 1);
  await pluginMoreMenuItems.value[0].onClick();
  assert.equal(errors.length, 2);
  assert.throws(() => api.addItem({ id: '', title: 'Invalid', onClick() {} }));
});
