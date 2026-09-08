import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/renderer/views/Search.vue', import.meta.url), 'utf8');
const snippet = source.slice(
  source.indexOf('let suggestionBlurTimer'),
  source.indexOf('const handleSongSort'),
);
function setup() {
  const timers = new Map();
  let next = 0;
  const input = {};
  const state = {
    showSuggestions: { value: false },
    isLoadingSuggestions: { value: false },
    searchInput: { value: 'love' },
    suggestionCategories: { value: ['cached'] },
    searchHeaderRef: { value: { inputRef: input } },
    isIgnoringChanges: { value: false },
    hasSearched: { value: false },
    showPinnedTabs: { value: false },
  };
  const pending = [];
  const bindings = {
    ...state,
    window: {
      setTimeout(fn) {
        timers.set(++next, fn);
        return next;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    document: { activeElement: input },
    getSearchSuggest: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    extractSuggestionCategories: (value) => value,
  };
  const { code } = transformSync(
    'let debounceTimer=null;\n' +
      snippet +
      '\nreturn {handleInputFocus,handleInputBlur,fetchSuggestions,handleSearchChanged};',
    { loader: 'ts' },
  );
  return {
    ...state,
    pending,
    timers,
    api: new Function(...Object.keys(bindings), code)(...Object.values(bindings)),
  };
}

test('refocusing cancels delayed dismissal and keeps suggestions visible', () => {
  const s = setup();
  s.api.handleInputFocus();
  s.api.handleInputBlur();
  assert.equal(s.timers.size, 1);
  s.api.handleInputFocus();
  assert.equal(s.timers.size, 0);
  assert.equal(s.showSuggestions.value, true);
});

test('an older failed request cannot clear newer suggestions', async () => {
  const s = setup();
  const old = s.api.fetchSuggestions('love');
  const latest = s.api.fetchSuggestions('love');
  s.pending[1].resolve(['new']);
  await latest;
  s.pending[0].reject(new Error('stale'));
  await old;
  assert.deepEqual(s.suggestionCategories.value, ['new']);
});

test('dismissed request cannot reopen suggestions and refocus can retry', async () => {
  const s = setup();
  s.suggestionCategories.value = [];
  const task = s.api.fetchSuggestions('love');
  s.api.handleInputBlur();
  for (const fn of s.timers.values()) fn();
  s.timers.clear();
  s.pending[0].resolve(['late']);
  await task;
  assert.equal(s.showSuggestions.value, false);
  assert.equal(s.isLoadingSuggestions.value, false);
  s.api.handleInputFocus();
  assert.equal(s.showSuggestions.value, true);
  assert.equal(s.pending.length, 2);
  s.pending[1].resolve(['retry']);
});
