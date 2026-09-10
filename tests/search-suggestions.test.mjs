import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(
  new URL('../src/renderer/layouts/TitleBar.vue', import.meta.url),
  'utf8',
);
const snippet = source.slice(
  source.indexOf('const cancelSuggestionBlur'),
  source.indexOf('\nwatch(', source.indexOf('const handleSearchKeydown')),
);
function setup() {
  const timers = new Map();
  let next = 0;
  let blurred = false;
  const navigations = [];
  const replacements = [];
  const route = { name: 'home', query: {} };
  const historyActions = [];
  let inputFocused = false;
  let nativeTarget = null;
  const input = {
    focus() {
      inputFocused = true;
    },
    blur() {
      blurred = true;
    },
  };
  const state = {
    showSuggestions: { value: false },
    activeSuggestionIndex: { value: -1 },
    isLoadingSuggestions: { value: false },
    searchQuery: { value: 'love' },
    suggestions: { value: ['cached'] },
    searchInputRef: { value: input },
    searchContainerRef: { value: { contains: () => false } },
    searchPanelRef: { value: null },
    isSearchFocused: { value: true },
    defaultKeyword: { value: '' },
    isIgnoringChanges: { value: false },
    hasSearched: { value: false },
    showPinnedTabs: { value: false },
  };
  const pending = [];
  const bindings = {
    logger: { info() {} },
    ...state,
    flatSuggestions: {
      get value() {
        return state.suggestions.value.flatMap((group) => group.records ?? []);
      },
    },
    nextTick: (fn) => Promise.resolve(fn()),
    loadHotSearches: () => {},
    settingStore: {
      clearSearchHistory() {
        historyActions.push({ action: 'clear', inputFocused });
      },
      removeFromSearchHistory(keyword) {
        historyActions.push({ action: 'remove', keyword, inputFocused });
      },
    },
    route,
    router: {
      push: (target) => navigations.push(target),
      replace: (target) => replacements.push(target),
    },
    window: {
      setTimeout(fn) {
        timers.set(++next, fn);
        return next;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    document: { activeElement: input, elementFromPoint: () => nativeTarget },
    getSearchSuggest: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    extractSuggestions: (value) => value,
  };
  const { code } = transformSync(
    'let suggestTimer=null; let suggestionRequest=0; let suggestionBlurTimer=null;\n' +
      snippet +
      '\nreturn {handleSearchKeydown,handleSearchFocus,handleSearchBlur,fetchSuggestions,handleSearchInput,submitSearch,clearSearchHistory,removeSearchHistory,handleSearchInteractOutside,handleGlobalPointerDown,handleNativePointerDown};',
    { loader: 'ts' },
  );
  return {
    ...state,
    pending,
    timers,
    navigations,
    replacements,
    route,
    historyActions,
    wasBlurred: () => blurred,
    setNativeTarget: (target) => {
      nativeTarget = target;
    },
    api: new Function(...Object.keys(bindings), code)(...Object.values(bindings)),
  };
}

test('refocusing cancels delayed dismissal and keeps suggestions visible', () => {
  const s = setup();
  s.api.handleSearchFocus();
  s.api.handleSearchBlur();
  assert.equal(s.timers.size, 1);
  s.api.handleSearchFocus();
  assert.equal(s.timers.size, 0);
  assert.equal(s.showSuggestions.value, true);
});

test('native titlebar click dismisses search without changing drag regions', () => {
  const s = setup();
  s.api.handleSearchFocus();
  s.setNativeTarget({ closest: (selector) => selector.includes('.native-titlebar .drag-region') });
  s.api.handleNativePointerDown({ x: 500, y: 20 });
  assert.equal(s.isSearchFocused.value, false);
  assert.equal(s.wasBlurred(), true);
});

test('native click on the central titlebar spacer dismisses search', () => {
  const s = setup();
  s.api.handleSearchFocus();
  s.setNativeTarget({ closest: (selector) => selector.includes('.titlebar-drag-space') });
  s.api.handleNativePointerDown({ x: 500, y: 20 });
  assert.equal(s.isSearchFocused.value, false);
  assert.equal(s.wasBlurred(), true);
});

test('delayed native notification after history removal does not dismiss search', () => {
  const s = setup();
  s.api.handleSearchFocus();
  s.api.clearSearchHistory();
  s.setNativeTarget({ closest: () => null });
  s.api.handleNativePointerDown({ x: 200, y: 100 });
  assert.equal(s.isSearchFocused.value, true);
  assert.equal(s.wasBlurred(), false);
});

test('native window move or loss of focus dismisses pending suggestions', async () => {
  const s = setup();
  const pending = s.api.fetchSuggestions('love');
  s.api.handleNativePointerDown();
  s.pending[0].resolve(['late']);
  await pending;
  assert.equal(s.isSearchFocused.value, false);
  assert.equal(s.showSuggestions.value, false);
});

test('an older failed request cannot clear newer suggestions', async () => {
  const s = setup();
  const old = s.api.fetchSuggestions('love');
  const latest = s.api.fetchSuggestions('love');
  s.pending[1].resolve(['new']);
  await latest;
  s.pending[0].reject(new Error('stale'));
  await old;
  assert.deepEqual(s.suggestions.value, ['new']);
});

test('dismissed request cannot reopen suggestions and refocus can retry', async () => {
  const s = setup();
  s.suggestions.value = [];
  const task = s.api.fetchSuggestions('love');
  s.api.handleSearchBlur();
  for (const fn of s.timers.values()) fn();
  s.timers.clear();
  s.pending[0].resolve(['late']);
  await task;
  assert.equal(s.showSuggestions.value, false);
  assert.equal(s.isLoadingSuggestions.value, false);
  s.api.handleSearchFocus();
  assert.equal(s.isSearchFocused.value, true);
  assert.equal(s.pending.length, 2);
  s.pending[1].resolve(['retry']);
});

test('selecting a suggestion updates the shared input and submits the same route keyword', () => {
  const s = setup();
  s.api.submitSearch('  new song  ');
  assert.equal(s.searchQuery.value, 'new song');
  assert.deepEqual(s.navigations, [{ name: 'search', query: { q: 'new song' } }]);
  assert.equal(s.isSearchFocused.value, false);
  assert.equal(s.wasBlurred(), true);
});

test('empty input uses the default keyword and leaves the submitted term visible', () => {
  const s = setup();
  s.searchQuery.value = ' ';
  s.defaultKeyword.value = 'default song';
  s.api.submitSearch();
  assert.equal(s.searchQuery.value, 'default song');
  assert.equal(s.navigations[0].query.q, 'default song');
});

test('clearing history restores focus before removing the focused button and cancels dismissal', () => {
  const s = setup();
  s.api.handleSearchBlur();
  s.api.clearSearchHistory();
  assert.deepEqual(s.historyActions, [{ action: 'clear', inputFocused: true }]);
  assert.equal(s.timers.size, 0);
  assert.equal(s.isSearchFocused.value, true);
});

test('removing the last history item also preserves the open panel', () => {
  const s = setup();
  s.api.handleSearchBlur();
  s.api.removeSearchHistory('love');
  assert.deepEqual(s.historyActions, [{ action: 'remove', keyword: 'love', inputFocused: true }]);
  assert.equal(s.timers.size, 0);
  assert.equal(s.isSearchFocused.value, true);
});

for (const action of ['clearSearchHistory', 'removeSearchHistory']) {
  test(`${action}: delayed library focus-outside from a removed node cannot dismiss the panel`, () => {
    const s = setup();
    s.api.handleSearchBlur();
    s.api[action]('love');
    // Reka dispatches the old focus event after the history DOM has disappeared.
    // Its default action is to emit dismiss even though input focus was restored.
    const staleFocusOutside = new Event('dismissableLayer.focusOutside', { cancelable: true });
    s.api.handleSearchInteractOutside(staleFocusOutside);
    assert.equal(staleFocusOutside.defaultPrevented, true);
    assert.equal(s.timers.size, 0);
    assert.equal(s.isSearchFocused.value, true);
  });
}

test('an actual outside pointerdown still closes the panel through the owner handler', () => {
  const s = setup();
  s.api.handleGlobalPointerDown({ target: {} });
  assert.equal(s.isSearchFocused.value, false);
});

test('leaving both input and panel still closes after the blur delay', () => {
  const s = setup();
  s.api.handleSearchBlur();
  for (const callback of s.timers.values()) callback();
  assert.equal(s.isSearchFocused.value, false);
});

test('submitting the same keyword refreshes results instead of a no-op router push', () => {
  const s = setup();
  s.route.name = 'search';
  s.route.query = { q: 'love', _t: '9999999999999' };
  s.api.submitSearch('love');
  assert.equal(s.navigations.length, 0);
  assert.deepEqual(s.replacements, [
    { name: 'search', query: { q: 'love', _t: '10000000000000' } },
  ]);
});

test('submitting a different keyword keeps normal search navigation', () => {
  const s = setup();
  s.route.name = 'search';
  s.route.query = { q: 'old' };
  s.api.submitSearch('new');
  assert.equal(s.replacements.length, 0);
  assert.deepEqual(s.navigations, [{ name: 'search', query: { q: 'new' } }]);
});

const keyEvent = (key, extra = {}) => ({
  key,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
});
function withSuggestions() {
  const s = setup();
  s.suggestions.value = [
    { label: '歌曲', records: [{ text: 'first' }, { text: 'second' }] },
    { label: '歌手', records: [{ text: 'third' }] },
  ];
  s.showSuggestions.value = true;
  return s;
}

test('arrow keys traverse categories, wrap and scroll the active option into view', () => {
  const s = withSuggestions();
  let scrolls = 0;
  s.searchPanelRef.value = { querySelector: () => ({ scrollIntoView: () => scrolls++ }) };
  s.api.handleSearchKeydown(keyEvent('ArrowUp'));
  assert.equal(s.activeSuggestionIndex.value, 2);
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  assert.equal(s.activeSuggestionIndex.value, 0);
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  assert.equal(s.activeSuggestionIndex.value, 2);
  assert.equal(scrolls, 4);
  assert.equal(s.searchQuery.value, 'love');
});

test('Enter submits the active suggestion, while no selection submits the input', () => {
  const s = withSuggestions();
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  s.api.handleSearchKeydown(keyEvent('Enter'));
  assert.equal(s.navigations[0].query.q, 'first');
  const raw = withSuggestions();
  raw.api.handleSearchKeydown(keyEvent('Enter'));
  assert.equal(raw.navigations[0].query.q, 'love');
});

test('IME confirmation and navigation are not intercepted', () => {
  const s = withSuggestions();
  for (const key of ['Enter', 'ArrowDown', 'Escape']) {
    s.api.handleSearchKeydown(
      keyEvent(key, {
        isComposing: true,
        preventDefault() {
          assert.fail('IME intercepted');
        },
      }),
    );
  }
  s.api.handleSearchKeydown(keyEvent('Enter', { keyCode: 229 }));
  assert.equal(s.navigations.length, 0);
  assert.equal(s.activeSuggestionIndex.value, -1);
  assert.equal(s.isSearchFocused.value, true);
});

test('editing and closing reset selection; loading and empty results cannot select stale options', () => {
  const s = withSuggestions();
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  s.api.handleSearchInput('new');
  assert.equal(s.activeSuggestionIndex.value, -1);
  s.api.handleSearchKeydown(keyEvent('ArrowDown'));
  assert.equal(s.activeSuggestionIndex.value, -1);
  s.api.handleSearchKeydown(keyEvent('Escape'));
  assert.equal(s.isSearchFocused.value, false);
  assert.equal(s.searchQuery.value, 'love');
});
