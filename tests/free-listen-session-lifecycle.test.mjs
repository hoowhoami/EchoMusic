import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { userSession, userSessionWatch } from './helpers/user-session.mjs';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const object = compile('../src/shared/object.ts');
const shared = compile('../src/renderer/utils/mappers/shared.ts', {
  '../cover': { normalizeCoverUrl: (value) => value },
  '../../../shared/object': object,
});
const mappers = compile('../src/renderer/utils/mappers/song.ts', { './shared': shared });
const extractors = compile('../src/renderer/utils/extractors.ts', {
  '../../shared/object': object,
});
const { descriptor } = parse(
  readFileSync(new URL('../src/renderer/views/FreeListen.vue', import.meta.url), 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'free-listen-session' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
// Non-sensitive fields selected from the real /ai/recommend/song response.
const packet = (id = '920474385') => ({
  errcode: 0,
  data: {
    list: [
      {
        mixsongid: id,
        album_audio_id: id,
        songname: '甲乙丙丁 (你我怎么两清)',
        author_name: '李佳薇',
        audio_info: {
          hash: '213D580CA0BDCC28A5FDBA995FFDA106',
          timelength: '210000',
          privilege: '10',
          pay_type: 3,
        },
      },
    ],
  },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 1,
    info: { userid: 1, token: 'one' },
  });
  const calls = [];
  const dependencies = {
    vue: { ...vue, onMounted() {} },
    '@/api/music': {
      getFreeListenSongs: () =>
        new Promise((resolve, reject) =>
          calls.push({ resolve, reject, userId: user.info?.userid }),
        ),
    },
    '@/utils/extractors': extractors,
    '@/utils/mappers': mappers,
    '@/utils/userSession': userSession,
    '@/utils/watchUserSession': userSessionWatch,
    '@/stores/user': { useUserStore: () => user },
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/player': { usePlayerStore: () => ({}) },
    '@/stores/theme': { useThemeStore: () => ({ sourceColor: '#fff' }) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/utils/cover': { createThemedIconCoverUrl: () => '' },
    '@/utils/songList': { filterSongsByQuery: (songs) => songs },
    '@/utils/playback': {},
    '@/icons': {},
    '../../shared/logging': { stringifyForLog: JSON.stringify },
    '@/utils/logger': { default: { warn() {} } },
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
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { user, view, calls };
}

test('free listen maps real nested fields and keeps data during ordinary profile refresh', async (t) => {
  const f = fixture(t);
  const pending = f.view.loadSongs();
  f.calls[0].resolve(packet());
  await pending;
  const song = f.view.songs.value[0];
  assert.equal(song.duration, 210);
  assert.equal(song.privilege, 10);
  assert.equal(song.payType, 3);
  f.user.info = { ...f.user.info, nickname: 'updated profile' };
  await vue.nextTick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.songs.value[0].id, song.id);
});

test('logout clears cached rows and pre-logout responses cannot write them back', async (t) => {
  const f = fixture(t);
  const first = f.view.loadSongs();
  f.calls[0].resolve(packet());
  await first;
  const old = f.view.loadSongs();
  f.user.accountRevision++;
  f.user.info = null;
  f.user.isLoggedIn = false;
  assert.equal(f.view.songs.value.length, 0);
  f.calls.at(-1).resolve({ data: { list: [] } });
  for (const call of f.calls.slice(1, -1)) call.resolve(packet());
  await old;
  await flush();
  assert.equal(f.view.songs.value.length, 0);
  assert.equal(f.view.loading.value, false);
});

test('late previous-account success and failure cannot alter the new account or its loading state', async (t) => {
  const f = fixture(t);
  const old = f.view.loadSongs();
  f.user.accountRevision++;
  f.user.info = { userid: 2, token: 'two' };
  f.calls[0].reject(new Error('old failure'));
  await old;
  assert.equal(f.view.loading.value, true);
  f.calls.at(-1).resolve(packet('879490214'));
  for (const call of f.calls.slice(1, -1)) call.resolve(packet());
  await flush();
  assert.equal(f.view.songs.value[0].id, '879490214');
  assert.equal(f.view.loadError.value, false);
  assert.equal(f.view.loading.value, false);
});

test('A to B to A retains the latest A batch despite an original A response arriving last', async (t) => {
  const f = fixture(t);
  const old = f.view.loadSongs();
  f.user.accountRevision++;
  f.user.info = { userid: 2, token: 'two' };
  f.user.accountRevision++;
  f.user.info = { userid: 1, token: 'one' };
  f.calls.at(-1).resolve(packet('935764415'));
  await flush();
  for (const call of f.calls.slice(0, -1)) call.resolve(packet());
  await old;
  await flush();
  assert.equal(f.view.songs.value[0].id, '935764415');
});
