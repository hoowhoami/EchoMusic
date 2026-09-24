import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(
  new URL('../src/renderer/layouts/playerBarActions.ts', import.meta.url),
  'utf8',
)
  .replace(/^import type .*;\n/gm, '')
  .replace(/^export /gm, '');

const { code } = transformSync(
  `${source}\nreturn { emptyPlayerBarLayout, partitionPlayerBarActions, reorderPlayerBarLayout, resolvePlayerBarActions, setPlayerBarActionPlacement, setPlayerBarBadgeVisible };`,
  { loader: 'ts' },
);

const api = new Function(code)();

const action = (id, defaultPlacement, order, visible = true) => ({
  id,
  title: id,
  icon: {},
  defaultPlacement,
  order,
  visible,
  onClick() {},
});

const keyedAction = (key, id, defaultPlacement, order, visible = true) => ({
  ...action(id, defaultPlacement, order, visible),
  key,
});

const resolvedAction = (id, placement, order) => ({
  ...action(id, placement, order),
  key: id,
  placement,
  isBadgeVisible: false,
  visibleBadge: null,
});

test('player bar action layout resolves saved placement and order', () => {
  const actions = [
    action('queue', 'right', 30),
    action('comments', 'left', 10),
    action('share', 'right', 20),
  ];
  const placed = api.setPlayerBarActionPlacement(api.emptyPlayerBarLayout(), 'comments', 'center');
  const layout = api.reorderPlayerBarLayout(placed, actions, ['queue', 'comments', 'share']);
  const resolved = api.resolvePlayerBarActions(actions, layout);

  assert.deepEqual(
    resolved.map((item) => [item.id, item.placement]),
    [
      ['queue', 'right'],
      ['comments', 'center'],
      ['share', 'right'],
    ],
  );
});

test('player bar action layout ignores hidden actions and invalid saved placement', () => {
  const actions = [
    action('share', 'right', 10),
    action('mv', 'left', 20, false),
    action('queue', 'right', 30),
  ];
  const resolved = api.resolvePlayerBarActions(actions, {
    placements: { share: 'floating', queue: 'more' },
  });

  assert.deepEqual(
    resolved.map((item) => [item.id, item.placement]),
    [
      ['share', 'right'],
      ['queue', 'more'],
    ],
  );
});

test('player bar action layout migrates old toolbar placement to right', () => {
  const resolved = api.resolvePlayerBarActions([action('share', 'more', 10)], {
    placements: { share: 'toolbar' },
  });

  assert.equal(resolved[0].placement, 'right');
});

test('player bar action placement changes preserve saved order', () => {
  const actions = [action('a', 'left', 10), action('b', 'right', 20)];
  const ordered = api.reorderPlayerBarLayout(api.emptyPlayerBarLayout(), actions, ['b', 'a']);
  const placed = api.setPlayerBarActionPlacement(ordered, 'a', 'center');

  assert.deepEqual(placed.order, ['b', 'a']);
  assert.equal(placed.placements.a, 'center');
  assert.deepEqual(
    api.resolvePlayerBarActions(actions, placed).map((item) => item.id),
    ['b', 'a'],
  );
});

test('player bar action badge visibility uses saved preference and default fallback', () => {
  const actions = [
    { ...action('queue', 'right', 10), badge: '7', badgeDefaultVisible: false },
    { ...action('desktop', 'right', 20), badge: 'ON' },
  ];
  const fallback = api.resolvePlayerBarActions(actions, api.emptyPlayerBarLayout());
  assert.deepEqual(
    fallback.map((item) => [item.id, item.isBadgeVisible, item.visibleBadge]),
    [
      ['queue', false, null],
      ['desktop', true, 'ON'],
    ],
  );

  const layout = api.setPlayerBarBadgeVisible(api.emptyPlayerBarLayout(), 'queue', true);
  const resolved = api.resolvePlayerBarActions(actions, layout);
  assert.deepEqual(
    resolved.map((item) => [item.id, item.isBadgeVisible, item.visibleBadge]),
    [
      ['queue', true, '7'],
      ['desktop', true, 'ON'],
    ],
  );
});

test('player bar action layout keys plugin actions independently from ids', () => {
  const actions = [
    action('share', 'right', 10),
    keyedAction('["plugin","share"]', 'share', 'more', 20),
  ];
  const layout = {
    placements: { '["plugin","share"]': 'left' },
    order: ['["plugin","share"]', 'share'],
  };
  const resolved = api.resolvePlayerBarActions(actions, layout);

  assert.deepEqual(
    resolved.map((item) => [item.key, item.id, item.placement]),
    [
      ['["plugin","share"]', 'share', 'left'],
      ['share', 'share', 'right'],
    ],
  );
});

test('player bar action reorder ignores invalid keys', () => {
  const actions = [action('a', 'left', 10), action('b', 'right', 20)];
  const layout = api.reorderPlayerBarLayout(
    { placements: { a: 'center' }, order: ['a', 'b'] },
    actions,
    ['b', 'missing'],
  );

  assert.deepEqual(layout, { placements: { a: 'center' }, order: ['a', 'b'] });
});

test('player bar action rendering overflows by capacity without changing placement', () => {
  const partitioned = api.partitionPlayerBarActions(
    [
      resolvedAction('a', 'left', 10),
      resolvedAction('b', 'left', 20),
      resolvedAction('c', 'right', 30),
      resolvedAction('d', 'more', 40),
    ],
    { left: 1, center: 0, right: 0 },
  );

  assert.deepEqual(
    partitioned.left.map((item) => [item.id, item.placement]),
    [['a', 'left']],
  );
  assert.deepEqual(
    partitioned.overflow.map((item) => [item.id, item.placement]),
    [
      ['b', 'left'],
      ['c', 'right'],
      ['d', 'more'],
    ],
  );
});
