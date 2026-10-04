import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const result = await build({
  entryPoints: [
    'src/renderer/layouts/sidebarShortcutResources.ts',
    'src/renderer/layouts/sidebarLayout.ts',
  ],
  outdir: 'unused',
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const require = createRequire(import.meta.url);
const modules = result.outputFiles.map((file) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', file.text)(require, module, module.exports);
  return module.exports;
});
const [api, layout] = modules;
const history = (artists, playCount, lastPlayedAt = 1, singers = []) => ({
  song: { artists, singers },
  playCount,
  lastPlayedAt,
});
const queue = (id, updatedAt, options = {}) => ({
  id: `queue:playlist:${id}`,
  type: 'playlist',
  title: `歌单 ${id}`,
  coverUrl: '',
  songs: [{}],
  updatedAt,
  ...options,
});

test('frequent artists rank real identities by plays and recency without double-counting singer aliases', () => {
  const a = { id: 1, name: '同名艺人' },
    b = { id: 2, name: '同名艺人', pic: 'portrait' };
  const artists = api.frequentArtistShortcuts([
    history([a, b], 3, 10, [a, b]),
    history([a], 2, 20),
    history([{ ...b, pic: undefined }], 2, 30),
    history([{ id: 3, name: '第三位' }], 6, 5),
    history([{ name: '没有 ID' }, { id: 0, name: '未知歌手' }], 100),
  ]);
  assert.deepEqual(
    artists.map((item) => item.id),
    ['3', '2', '1'],
  );
  assert.equal(artists[1].image, 'portrait');
  assert.equal(api.frequentArtistShortcuts([history([a, b], NaN)], 1).length, 1);
});

test('recent playlists include active and lazily-loaded queues while excluding albums, FM and empty queues', () => {
  const entries = api.recentPlaylistShortcuts([
    queue(1, 10),
    queue(2, 20, { songs: [], songCount: 12 }),
    queue(3, 30, { type: 'album' }),
    queue(4, 40, { type: 'fm' }),
    queue(5, 50, { songs: [], songCount: 0 }),
    queue(6, 60, { id: 'manual' }),
    queue(0, 70),
    queue(7, 80, { title: '' }),
  ]);
  assert.deepEqual(
    entries.map((item) => item.id),
    ['2', '1'],
  );
  assert.equal(api.resourceShortcutPath(entries[0]), '/main/playlist/2');
});

test('playlist identity resolves saved collection IDs, deduplicates aliases and preserves genuine cover metadata', () => {
  const playlists = [
    {
      id: 12,
      globalCollectionId: '12345',
      listCreateGid: '67890',
      name: '自己的歌单',
      pic: 'cover',
      source: 1,
    },
  ];
  const entries = api.recentPlaylistShortcuts([queue(12, 20), queue('67890', 10)], playlists);
  assert.deepEqual(entries, [
    { kind: 'playlist', id: '67890', title: '自己的歌单', image: 'cover' },
  ]);
});

test('saved resources survive history expiry, preserve mixed ordering and cannot collide with plugins or each other', () => {
  const artist = { kind: 'artist', id: '12', title: '艺人' },
    playlist = { kind: 'playlist', id: '12', title: '歌单' };
  const artistKey = api.resourceShortcutKey(artist),
    playlistKey = api.resourceShortcutKey(playlist);
  const pluginKey = JSON.stringify(['resource', 'artist']);
  assert.notEqual(artistKey, playlistKey);
  assert.notEqual(artistKey, pluginKey);
  const keys = ['home', artistKey, pluginKey, 'explore', playlistKey];
  const saved = api.selectedShortcutResources(keys, [artist], playlist);
  assert.deepEqual(saved, [artist, playlist]);
  const reordered = layout.reorderShortcutKeys(
    keys,
    ['home', artistKey, 'explore', playlistKey],
    [playlistKey, 'home', artistKey, 'explore'],
  );
  assert.deepEqual(api.selectedShortcutResources(reordered, saved), [playlist, artist]);
  assert.deepEqual(
    api.selectedShortcutResources(
      keys.filter((key) => key !== artistKey),
      saved,
    ),
    [playlist],
  );
  assert.deepEqual(api.selectedShortcutResources(layout.DEFAULT_SHORTCUT_KEYS, saved), []);
});

test('saved playlist cards resolve current metadata by aliases without reviving a cleared cover', () => {
  const playlists = [
    {
      id: 12,
      listid: 34,
      globalCollectionId: '56',
      listCreateGid: '78',
      source: 1,
      name: '新名称',
      pic: 'metadata',
    },
  ];
  for (const id of ['12', '34', '56', '78']) {
    const snapshot = { kind: 'playlist', id, title: '旧名称', image: 'old-snapshot' };
    assert.deepEqual(
      api.resolvePlaylistShortcut(snapshot, playlists, () => ''),
      {
        ...snapshot,
        title: '新名称',
        image: '',
      },
    );
    assert.equal(snapshot.image, 'old-snapshot');
  }
  const unknown = { kind: 'playlist', id: '99', title: '历史歌单', image: 'queue-cover' };
  assert.equal(
    api.resolvePlaylistShortcut(unknown, playlists, () => assert.fail()),
    unknown,
  );
  assert.equal(
    api.resolvePlaylistShortcut(unknown, [{ ...playlists[0], id: 99, source: 2 }], () =>
      assert.fail(),
    ),
    unknown,
  );
});

test('resetting lower menus preserves upper resource cards and their snapshots', () => {
  const artist = { kind: 'artist', id: '12', title: '艺人' };
  const value = {
    ...layout.emptySidebarLayout(),
    shortcutKeys: ['home', 'explore', api.resourceShortcutKey(artist)],
    shortcutResources: [artist],
    hiddenItems: { history: true },
  };
  const reset = layout.resetSidebarMenus(value);
  assert.deepEqual(reset.shortcutKeys, value.shortcutKeys);
  assert.deepEqual(reset.shortcutResources, [artist]);
  assert.deepEqual(reset.hiddenItems, {});
});
