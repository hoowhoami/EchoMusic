import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const code = transformSync(readFileSync('src/renderer/stores/output.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fixture(t, enabled = false) {
  const settings = vue.reactive({ networkPlaybackEnabled: enabled });
  const calls = [],
    enabledResponses = [],
    refreshResponses = [];
  const api = {
    onEvent(callback) {
      api.event = callback;
    },
    setEnabled(value) {
      calls.push(['enabled', value]);
      const gate = deferred();
      enabledResponses.push(gate);
      return gate.promise;
    },
    async setBrowsing(value) {
      calls.push(['browsing', value]);
    },
    refresh() {
      calls.push(['refresh']);
      const gate = deferred();
      refreshResponses.push(gate);
      return gate.promise;
    },
    async getSession() {
      return { searching: false, diagnostics: '最新状态' };
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (id) =>
      ({
        vue,
        pinia: { defineStore: (_id, setup) => setup },
        './setting': { useSettingStore: () => settings },
      })[id],
    module,
    module.exports,
    { electron: { output: api } },
  );
  const scope = vue.effectScope();
  const store = scope.run(() => module.exports.useOutputStore());
  t.after(() => scope.stop());
  return { settings, store, api, calls, enabledResponses, refreshResponses };
}

test('disabled casting does not refresh when its panel opens', async (t) => {
  const f = fixture(t);
  await f.store.bind();
  await f.store.setBrowsing(true);
  assert.deepEqual(f.calls, [
    ['enabled', false],
    ['browsing', true],
  ]);
  assert.equal(f.store.searching.value, false);
});

test('turning off casting immediately hides searching and discards stale refresh and switch responses', async (t) => {
  const f = fixture(t, true);
  await f.store.bind();
  const refresh = f.store.refresh();
  assert.equal(f.store.searching.value, true);
  f.settings.networkPlaybackEnabled = false;
  assert.equal(f.store.searching.value, false);
  f.enabledResponses[1].resolve({ searching: false, diagnostics: '网络播放未开启' });
  await tick();
  f.enabledResponses[0].resolve({ searching: true, diagnostics: '旧开关响应' });
  f.refreshResponses[0].resolve([{ targetId: 'stale' }]);
  await refresh;
  await tick();
  assert.deepEqual(f.store.targets.value, []);
  assert.equal(f.store.diagnostics.value, '网络播放未开启');
  assert.equal(f.store.searching.value, false);
});

test('enabling casting while its panel is already open refreshes devices', async (t) => {
  const f = fixture(t);
  await f.store.bind();
  await f.store.setBrowsing(true);
  f.settings.networkPlaybackEnabled = true;
  f.enabledResponses[1].resolve({ searching: false });
  await tick();
  assert.equal(f.refreshResponses.length, 1);
  f.refreshResponses[0].resolve([{ targetId: 'fresh' }]);
  await tick();
  assert.equal(f.store.targets.value[0].targetId, 'fresh');
});
