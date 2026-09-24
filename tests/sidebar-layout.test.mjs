import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(
  new URL('../src/renderer/layouts/sidebarLayout.ts', import.meta.url),
  'utf8',
)
  .replace(/^import type .*;\n/gm, '')
  .replace(/^export /gm, '');

const { code } = transformSync(
  `${source}\nreturn { emptySidebarLayout, reorderSidebarItems, reorderSidebarSections, resolveSidebarLayout, setSidebarItemHidden, setSidebarRailSectionVisible, setSidebarSectionHidden };`,
  { loader: 'ts' },
);

const api = new Function(code)();

const sections = [
  {
    id: 'discover',
    title: '发现音乐',
    order: 100,
    items: [
      { id: 'home', key: 'home', title: '为您推荐', order: 10 },
      { id: 'explore', key: 'explore', title: '探索发现', order: 20 },
    ],
  },
  {
    id: 'library',
    title: '我的乐库',
    order: 200,
    items: [
      { id: 'favorites', key: 'favorites', title: '我最喜爱', order: 10 },
      { id: 'history', key: 'history', title: '播放历史', order: 20 },
    ],
  },
];

test('sidebar layout resolves saved section and item order', () => {
  const sectionOrdered = api.reorderSidebarSections(api.emptySidebarLayout(), sections, [
    'library',
    'discover',
  ]);
  const itemOrdered = api.reorderSidebarItems(sectionOrdered, 'library', sections[1].items, [
    'history',
    'favorites',
  ]);
  const resolved = api.resolveSidebarLayout(sections, itemOrdered);

  assert.deepEqual(
    resolved.map((section) => section.id),
    ['library', 'discover'],
  );
  assert.deepEqual(
    resolved[0].items.map((item) => item.key),
    ['history', 'favorites'],
  );
});

test('sidebar layout hides sections and items while editor can include hidden entries', () => {
  let layout = api.setSidebarItemHidden(api.emptySidebarLayout(), 'history', true);
  layout = api.setSidebarSectionHidden(layout, 'discover', true);

  const visible = api.resolveSidebarLayout(sections, layout);
  assert.deepEqual(
    visible.map((section) => [section.id, section.items.map((item) => item.key)]),
    [['library', ['favorites']]],
  );

  const editable = api.resolveSidebarLayout(sections, layout, { includeHidden: true });
  assert.equal(editable.find((section) => section.id === 'discover').isHidden, true);
  assert.equal(
    editable
      .find((section) => section.id === 'library')
      .items.find((item) => item.key === 'history').isHidden,
    true,
  );
});

test('sidebar layout stores rail visibility and rejects stale drag payloads', () => {
  const layout = api.setSidebarRailSectionVisible(api.emptySidebarLayout(), 'library', false);
  const resolved = api.resolveSidebarLayout(sections, layout);
  assert.equal(resolved.find((section) => section.id === 'library').isRailVisible, false);

  assert.equal(api.reorderSidebarSections(layout, sections, ['missing']), layout);
  assert.equal(
    api.reorderSidebarItems(layout, 'library', sections[1].items, ['history', 'history']),
    layout,
  );
});

test('sidebar layout does not reorder locked items', () => {
  const lockedItems = [
    { id: 'default', key: 'playlist:default', title: '默认收藏', order: 10, lockedOrder: true },
    { id: 'liked', key: 'playlist:liked', title: '我喜欢', order: 20, lockedOrder: true },
  ];
  const layout = api.reorderSidebarItems(api.emptySidebarLayout(), 'playlists', lockedItems, [
    'playlist:liked',
    'playlist:default',
  ]);

  assert.deepEqual(layout, api.emptySidebarLayout());
});
