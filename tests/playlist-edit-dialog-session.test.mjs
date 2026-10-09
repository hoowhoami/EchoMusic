import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as tags from '../src/renderer/utils/playlistTags.ts';
import { userSessionWatch } from './helpers/user-session.mjs';

const { descriptor } = parse(
  readFileSync(
    new URL('../src/renderer/components/music/PlaylistEditDialog.vue', import.meta.url),
    'utf8',
  ),
);
const code = transformSync(compileScript(descriptor, { id: 'playlist-edit-session' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const playlist = { id: 12, listid: 12, type: 0, name: 'original', tags: '', intro: '' };
const snapshot = { listid: 12, type: 0, playlist };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, service = {}) {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 1,
    info: { userid: 7, token: 'one' },
  });
  const props = vue.reactive({ open: true, target: playlist });
  const events = [];
  const playlists = { userPlaylists: [playlist] };
  const dependencies = {
    vue: { ...vue, onBeforeUnmount() {} },
    '@/utils/watchUserSession': userSessionWatch,
    '@/utils/playlistTags': tags,
    '@/stores/user': { useUserStore: () => user },
    '@/stores/playlist': { usePlaylistStore: () => playlists },
    '@/stores/playlistCovers': { usePlaylistCoversStore: () => ({ coverFor: () => '' }) },
    '@/stores/toast': { useToastStore: () => ({ actionCompleted: () => events.push(['toast']) }) },
    '@/services/playlistEditing': {
      loadPlaylistEdit: async () => snapshot,
      savePlaylistEdit: async () => playlist,
      ...service,
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const view = scope.run(() =>
    module.exports.default.setup(props, { expose() {}, emit: (...args) => events.push(args) }),
  );
  return { user, view, events, playlists };
}

test('same-user token replacement synchronously closes the editor and discards its old load', async (t) => {
  let resolve;
  const f = fixture(t, { loadPlaylistEdit: () => new Promise((done) => (resolve = done)) });
  f.user.info.token = 'two';
  assert.deepEqual(f.events, [['update:open', false]]);
  resolve(snapshot);
  await flush();
  assert.equal(f.view.snapshot.value, null);
});

test('same-user new session retires an in-flight save without publishing rows or notifications', async (t) => {
  let resolve;
  const f = fixture(t, { savePlaylistEdit: () => new Promise((done) => (resolve = done)) });
  await flush();
  f.view.name.value = 'changed';
  const saving = f.view.save();
  f.user.accountRevision++;
  resolve({ ...playlist, name: 'changed' });
  await saving;
  assert.equal(f.playlists.userPlaylists[0].name, 'original');
  assert.deepEqual(f.events, [['update:open', false]]);
});

test('ordinary profile refresh keeps the editor and its unsaved draft', async (t) => {
  const f = fixture(t);
  await flush();
  f.view.name.value = 'unsaved';
  f.user.info = { ...f.user.info, nickname: 'updated' };
  await vue.nextTick();
  assert.equal(f.view.name.value, 'unsaved');
  assert.deepEqual(f.events, []);
});
