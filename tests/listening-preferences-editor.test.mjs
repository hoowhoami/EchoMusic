import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as Vue from 'vue';
import * as preferences from '../src/shared/listeningPreferences.ts';

const code = transformSync(
  readFileSync(
    new URL('../src/renderer/components/profile/useListeningPreferences.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (name) => {
    if (name === 'vue') return Vue;
    if (name === '../../../shared/listeningPreferences') return preferences;
    throw new Error(`Unexpected dependency: ${name}`);
  },
  module,
  module.exports,
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(api) {
  const account = Vue.ref('account-a');
  const scope = Vue.effectScope();
  const state = scope.run(() => module.exports.useListeningPreferences(account, api));
  return { account, state, dispose: () => scope.stop() };
}

test('saves only changes; reopening immediately reads the server without a sync window', async () => {
  let remote = preferences.emptyPreferences();
  let reads = 0;
  const updates = [];
  const e = setup({
    read: async () => {
      reads++;
      return { ...remote };
    },
    update: async (patch) => {
      updates.push(patch);
      remote = { ...remote, ...patch };
    },
  });
  await e.state.load();
  e.state.draft.value.lang = '{"1":100}';
  assert.equal(await e.state.save(), true);
  assert.deepEqual(updates, [{ lang: '{"1":100}' }]);
  assert.equal(e.state.dirty.value, false);
  await e.state.load();
  assert.equal(reads, 2, 'reopening immediately reads the saved preferences');
  await e.state.load();
  assert.equal(e.state.draft.value.lang, '{"1":100}');
  remote = { ...remote, lang: '{"2":100}', age: '0' };
  await e.state.load();
  assert.equal(e.state.draft.value.age, '0');
  assert.equal(
    e.state.draft.value.lang,
    '{"2":100}',
    'later server changes are not masked by submitted values',
  );
  e.dispose();
});

test('failed saves preserve the draft and can be retried; dirty drafts block refresh', async () => {
  let fail = true;
  let reads = 0;
  const e = setup({
    read: async () => {
      reads++;
      return preferences.emptyPreferences();
    },
    update: async () => {
      if (fail) throw new Error('保存失败');
    },
  });
  await e.state.load();
  e.state.draft.value.age = '0';
  await e.state.load();
  assert.equal(reads, 1);
  assert.equal(await e.state.save(), false);
  assert.equal(e.state.draft.value.age, '0');
  assert.equal(e.state.dirty.value, true);
  fail = false;
  assert.equal(await e.state.save(), true);
  e.dispose();
});

test('account switches invalidate pending reads, including switching back before completion', async () => {
  const old = deferred();
  let calls = 0;
  const e = setup({
    read: () =>
      ++calls === 1
        ? old.promise
        : Promise.resolve({ ...preferences.emptyPreferences(), gender: '1' }),
    update: async () => {},
  });
  const request = e.state.load();
  e.account.value = 'account-b';
  e.account.value = 'account-a';
  await e.state.load();
  old.resolve({ ...preferences.emptyPreferences(), gender: '2' });
  await request;
  assert.equal(e.state.draft.value.gender, '1');
  assert.equal(e.state.loading.value, false);
  e.dispose();
});

test('account switch during save cannot populate the new account or report success', async () => {
  const write = deferred();
  let writes = 0;
  const e = setup({
    read: async () => preferences.emptyPreferences(),
    update: () => {
      writes++;
      return write.promise;
    },
  });
  await e.state.load();
  e.state.draft.value.gender = '2';
  const save = e.state.save();
  assert.equal(await e.state.save(), false, 'duplicate submit is blocked');
  e.account.value = 'account-b';
  write.resolve();
  assert.equal(await save, false);
  assert.equal(writes, 1);
  assert.equal(e.state.loaded.value, false);
  assert.equal(e.state.saving.value, false);
  e.dispose();
});

test('consecutive saves and clears are reflected by immediate refresh', async () => {
  let remote = { ...preferences.emptyPreferences(), lang: '{"1":100}', age: '0' };
  const updates = [];
  const e = setup({
    read: async () => ({ ...remote }),
    update: async (patch) => {
      updates.push(patch);
      remote = { ...remote, ...patch };
    },
  });
  await e.state.load();
  e.state.draft.value.lang = '';
  await e.state.save();
  e.state.draft.value.age = '2';
  await e.state.save();
  assert.deepEqual(updates, [{ lang: '' }, { age: '2' }]);
  await e.state.load();
  assert.equal(e.state.draft.value.lang, '');
  assert.equal(e.state.draft.value.age, '2');
  assert.equal(e.state.dirty.value, false);
  e.dispose();
});

test('read errors allow retry and disposing invalidates pending saves', async () => {
  let fail = true;
  const write = deferred();
  const e = setup({
    read: async () => {
      if (fail) throw new Error('离线');
      return preferences.emptyPreferences();
    },
    update: () => write.promise,
  });
  await e.state.load();
  assert.equal(e.state.loaded.value, false);
  assert.match(e.state.error.value, /离线/);
  fail = false;
  await e.state.load();
  assert.equal(e.state.loaded.value, true);
  e.state.draft.value.age = '2';
  const save = e.state.save();
  e.dispose();
  write.resolve();
  assert.equal(await save, false);
});

test('invalid recommendation combinations are retained for correction without writing', async () => {
  let writes = 0;
  const e = setup({
    read: async () => preferences.emptyPreferences(),
    update: async () => {
      writes++;
    },
  });
  await e.state.load();
  e.state.draft.value.song_lang = '{"S9":75,"T1":0}';
  assert.equal(await e.state.save(), false);
  assert.equal(writes, 0);
  assert.equal(e.state.dirty.value, true);
  assert.match(e.state.error.value, /翻唱/);
  e.state.draft.value.song_lang = '{"S9":75,"T1":50}';
  assert.equal(await e.state.save(), true);
  e.dispose();
});
