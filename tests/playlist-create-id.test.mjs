import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const loadUserActions = (addPlaylist, warnings) => {
  const source = readFileSync(
    new URL('../src/renderer/stores/playlist/userActions.ts', import.meta.url),
    'utf8',
  );
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' });
  const module = { exports: {} };
  const logger = { warn: (...args) => warnings.push(args), error() {} };
  const modules = {
    '@/api/playlist': { addPlaylist, deletePlaylist() {}, getUserPlaylists() {} },
    '@/utils/logger': { __esModule: true, default: logger },
    '@/utils/mappers': { mapPlaylistMeta: (value) => value },
    './helpers': {
      includesPlaylistIdentity: () => false,
      getPlaylistIdentityValues: (playlist) =>
        [playlist.id, playlist.listid]
          .filter((value) => value !== undefined && value !== null && String(value) !== '')
          .map(String),
    },
  };
  new Function('require', 'module', 'exports', code)(
    (id) => modules[id] ?? {},
    module,
    module.exports,
  );
  return module.exports.userActions;
};

const playlist = (id, name = '重复名称') => ({
  id,
  listid: id,
  name,
  source: 1,
  listCreateUserid: 7,
});

test('playlist creation fallback selects only the newly added same-name playlist', async () => {
  const warnings = [];
  const actions = loadUserActions(async () => ({ status: 1, data: {} }), warnings);
  const oldPlaylist = { ...playlist(10), listid: undefined, createTime: 999 };
  const refreshedOldPlaylist = { ...playlist(1_000), listid: 10, createTime: 999 };
  const newPlaylist = { ...playlist(11), createTime: 0 };
  const store = {
    userPlaylists: [oldPlaylist],
    async fetchUserPlaylists() {
      this.userPlaylists = [refreshedOldPlaylist, newPlaylist];
    },
  };

  const id = await actions.createPlaylistAndReturnId.call(store, '重复名称', false, 7);

  assert.equal(id, 11);
  assert.deepEqual(warnings, []);
});

test('playlist creation fallback fails closed when a new playlist is not uniquely identifiable', async () => {
  const warnings = [];
  const actions = loadUserActions(async () => ({ status: 1, data: {} }), warnings);
  const oldPlaylist = playlist(10);
  const store = {
    userPlaylists: [oldPlaylist],
    async fetchUserPlaylists() {
      this.userPlaylists = [oldPlaylist, playlist(11), playlist(12)];
    },
  };

  const id = await actions.createPlaylistAndReturnId.call(store, '重复名称', false, 7);

  assert.equal(id, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][2].candidateCount, 2);
});
