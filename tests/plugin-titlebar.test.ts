import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ref } from 'vue';
import {
  createTitlebarApi,
  titlebarItems,
  resolveTitlebarLayout,
  partitionTitlebarActions,
  emptyTitlebarLayout,
  reorderTitlebarLayout,
  removeTitlebarItemsByPlugin,
} from '../src/renderer/plugins/titlebar.ts';

afterEach(() => ['a', 'b'].forEach(removeTitlebarItemsByPlugin));

test('titlebar scopes ids, orders entries, and cleans replacement registrations safely', () => {
  const disposers: (() => void)[] = [];
  const a = createTitlebarApi(
    'a',
    (dispose) => disposers.push(dispose),
    () => {},
  );
  const b = createTitlebarApi(
    'b',
    () => {},
    () => {},
  );
  const old = a.register({ id: 'open', icon: 'tabler:tools', title: 'Old', onClick() {} });
  a.register({ id: 'open', icon: 'tabler:tools', title: 'New', order: 1, onClick() {} });
  b.register({ id: 'open', icon: 'tabler:tools', title: 'Other', order: 2, onClick() {} });
  old();
  assert.deepEqual(
    titlebarItems.value.map((item) => item.title),
    ['New', 'Other'],
  );
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(
    titlebarItems.value.map((item) => item.pluginId),
    ['b'],
  );
  removeTitlebarItemsByPlugin('b');
  assert.equal(titlebarItems.value.length, 0);
});

test('reactive visibility, disabled actions, and stale entries are respected', async () => {
  const visible = ref(true);
  const disabled = ref(false);
  let calls = 0;
  const api = createTitlebarApi(
    'a',
    () => {},
    () => {},
  );
  api.register({
    id: 'open',
    icon: 'tabler:tools',
    title: 'Open',
    visible: () => visible.value,
    disabled: () => disabled.value,
    onClick() {
      calls++;
    },
  });
  const entry = titlebarItems.value[0];
  await entry.onClick();
  disabled.value = true;
  await entry.onClick();
  visible.value = false;
  assert.equal(
    resolveTitlebarLayout(titlebarItems.value).filter((item) => item.isVisible).length,
    0,
  );
  visible.value = true;
  disabled.value = false;
  removeTitlebarItemsByPlugin('a');
  await entry.onClick();
  assert.equal(calls, 1);
});

test('plugin predicate and asynchronous action failures are reported without escaping', async () => {
  const errors: unknown[] = [];
  const api = createTitlebarApi(
    'a',
    () => {},
    (_, error) => errors.push(error),
  );
  api.register({
    id: 'hidden',
    icon: 'tabler:tools',
    title: 'Hidden',
    visible() {
      throw Error('predicate');
    },
    onClick() {},
  });
  api.register({
    id: 'action',
    icon: 'tabler:tools',
    title: 'Action',
    async onClick() {
      throw Error('action');
    },
  });
  const visibleActions = resolveTitlebarLayout(titlebarItems.value).filter(
    (item) => item.isVisible,
  );
  assert.equal(visibleActions.length, 1);
  await visibleActions[0].onClick();
  assert.equal(errors.length, 2);
  assert.throws(() =>
    api.register({ id: '', icon: 'tabler:tools', title: 'Invalid', onClick() {} }),
  );
});

test('user placement and order survive plugin reload and changed defaults', () => {
  const api = createTitlebarApi(
    'a',
    () => {},
    () => {},
  );
  api.register({
    id: 'first',
    title: 'First',
    icon: 'tabler:tools',
    defaultPlacement: 'toolbar',
    onClick() {},
  });
  api.register({ id: 'second', title: 'Second', icon: 'tabler:tools', onClick() {} });
  const [first, second] = titlebarItems.value;
  const layout = {
    placements: { [first.key]: 'more' as const, [second.key]: 'toolbar' as const },
    order: [second.key, first.key],
  };
  removeTitlebarItemsByPlugin('a');
  api.register({
    id: 'first',
    title: 'Renamed',
    icon: 'tabler:tools',
    defaultPlacement: 'toolbar',
    order: -10,
    onClick() {},
  });
  api.register({ id: 'second', title: 'Second', icon: 'tabler:tools', onClick() {} });
  assert.deepEqual(
    resolveTitlebarLayout(titlebarItems.value, layout).map((item) => [item.id, item.placement]),
    [
      ['second', 'toolbar'],
      ['first', 'more'],
    ],
  );
  assert.deepEqual(
    resolveTitlebarLayout(titlebarItems.value, emptyTitlebarLayout()).map((item) => [
      item.id,
      item.placement,
    ]),
    [
      ['first', 'toolbar'],
      ['second', 'more'],
    ],
  );
});

test('narrow-window overflow preserves preferences and pinned actions remain in More', () => {
  const api = createTitlebarApi(
    'a',
    () => {},
    () => {},
  );
  for (let i = 0; i < 3; i++)
    api.register({
      id: String(i),
      title: String(i),
      icon: 'tabler:tools',
      defaultPlacement: 'toolbar',
      order: i,
      onClick() {},
    });
  const layout = emptyTitlebarLayout();
  const items = resolveTitlebarLayout(titlebarItems.value, layout);
  const narrow = partitionTitlebarActions(items, 1);
  assert.deepEqual(
    narrow.toolbar.map((item) => item.id),
    ['0'],
  );
  assert.deepEqual(
    narrow.more.map((item) => item.id),
    ['0', '1', '2'],
  );
  assert.equal(partitionTitlebarActions(items, 3).more.length, 3);
  assert.deepEqual(layout, emptyTitlebarLayout());
});

test('async action prevents duplicate activation and clears busy after failure', async () => {
  const errors: unknown[] = [];
  let reject!: (error: Error) => void;
  let calls = 0;
  const api = createTitlebarApi(
    'a',
    () => {},
    (_, error) => errors.push(error),
  );
  api.register({
    id: 'run',
    title: 'Run',
    icon: 'tabler:tools',
    onClick: () => {
      calls++;
      return new Promise<void>((_, fail) => {
        reject = fail;
      });
    },
  });
  const item = titlebarItems.value[0];
  const pending = item.onClick();
  assert.equal(item.busy(), true);
  await item.onClick();
  assert.equal(calls, 1);
  reject(new Error('failed'));
  await pending;
  assert.equal(item.busy(), false);
  assert.equal(item.disabled(), false);
  assert.equal(errors.length, 1);
});

test('icon and valid placement are required; tooltip defaults to the label', () => {
  const api = createTitlebarApi(
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
      defaultPlacement: 'left',
      onClick() {},
    } as never),
  );
  api.register({ id: 'x', title: 'X', icon: 'tabler:tools', onClick() {} });
  assert.equal(titlebarItems.value[0].tooltip, 'X');
  assert.equal(titlebarItems.value[0].defaultPlacement, 'more');
});

test('host actions cannot collide with plugin ids and hidden actions remain manageable', () => {
  const host = createTitlebarApi(
    null,
    () => {},
    () => {},
  );
  const dispose = host.register({
    id: 'tasks',
    title: 'Tasks',
    icon: 'tabler:list',
    defaultPlacement: 'toolbar',
    onClick() {},
  });
  try {
    createTitlebarApi(
      'a',
      () => {},
      () => {},
    ).register({
      id: 'tasks',
      title: 'Plugin tasks',
      icon: 'tabler:list',
      visible: false,
      onClick() {},
    });
    const actions = resolveTitlebarLayout(titlebarItems.value);
    assert.equal(new Set(actions.map((item) => item.key)).size, 2);
    assert.equal(actions.length, 2);
    assert.equal(partitionTitlebarActions(actions, 10).toolbar.length, 1);
    assert.equal(partitionTitlebarActions(actions, 10).more.length, 1);
    removeTitlebarItemsByPlugin('a');
    assert.equal(titlebarItems.value[0].pluginId, null);
  } finally {
    dispose();
  }
});

test('drag inserts at the new position while preserving other regions and inactive plugins', () => {
  const layout = {
    placements: { a: 'toolbar' as const },
    order: ['a', 'offline', 'b', 'other', 'c'],
  };
  const actions = ['a', 'b', 'other', 'c'].map((key) => ({ key }));
  const result = reorderTitlebarLayout(layout, actions, ['c', 'a', 'b']);
  assert.deepEqual(result.order, ['c', 'offline', 'a', 'other', 'b']);
  assert.deepEqual(result.placements, layout.placements);
  assert.deepEqual(layout.order, ['a', 'offline', 'b', 'other', 'c']);
});

test('dragging new items saves the complete order and rejects stale or duplicate keys', () => {
  const actions = ['a', 'b', 'c'].map((key) => ({ key }));
  const layout = emptyTitlebarLayout();
  assert.deepEqual(reorderTitlebarLayout(layout, actions, ['c', 'a', 'b']).order, ['c', 'a', 'b']);
  assert.equal(reorderTitlebarLayout(layout, actions, ['missing']), layout);
  assert.equal(reorderTitlebarLayout(layout, actions, ['a', 'a']), layout);
});
