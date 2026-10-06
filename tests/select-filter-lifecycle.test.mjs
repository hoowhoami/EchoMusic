import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

function fixture(t) {
  const props = vue.reactive({
    options: Array.from({ length: 200 }, (_, i) => ({
      value: i,
      label: `${i < 60 ? '匹配' : '其他'} ${i}`,
    })),
    disabled: false,
    filterable: true,
    multiple: false,
    virtualThreshold: 50,
    maxTagCount: 1,
  });
  const pending = [],
    scrolls = [],
    events = [];
  let focuses = 0,
    measurements = 0;
  const { descriptor } = parse(readFileSync('src/renderer/components/ui/Select.vue', 'utf8'));
  const { code } = transformSync(compileScript(descriptor, { id: 'select-filter' }).content, {
    loader: 'ts',
    format: 'cjs',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'document', 'getComputedStyle', code)(
    (id) => (id === 'vue' ? { ...vue, nextTick: (fn) => pending.push(fn) } : {}),
    mod,
    mod.exports,
    { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 40 }) }) }) },
    () => {
      measurements++;
      return { fontFamily: 'sans-serif' };
    },
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const api = scope.run(() =>
    mod.exports.default.setup(props, { expose() {}, emit: (...args) => events.push(args) }),
  );
  api.inputRef.value = { focus: () => focuses++ };
  api.triggerRef.value = { getBoundingClientRect: () => ({ width: 200 }) };
  const list = { clientHeight: 320, scrollTo: (options) => scrolls.push(options) };
  if (api.listRef) api.listRef.value = list;
  return {
    api,
    props,
    pending,
    scrolls,
    events,
    list,
    get focuses() {
      return focuses;
    },
    get measurements() {
      return measurements;
    },
    flush: () => pending.splice(0).forEach((fn) => fn()),
  };
}

test('filtering a scrolled virtual menu immediately returns to its first match', async (t) => {
  const s = fixture(t);
  s.api.scrollTop.value = 6000;
  assert.ok(s.api.visibleItems.value.length);
  s.api.searchTerm.value = '匹配';
  await vue.nextTick();
  assert.equal(s.api.useVirtual.value, true);
  assert.equal(s.api.scrollTop.value, 0);
  assert.equal(s.api.visibleItems.value[0]?.value, 0);
  assert.deepEqual(s.scrolls.at(-1), { top: 0, behavior: 'instant' });
});

test('shrinking options cannot leave the virtual range outside the data', async (t) => {
  const s = fixture(t);
  s.api.scrollTop.value = 6000;
  s.props.options = s.props.options.slice(0, 60);
  await vue.nextTick();
  assert.ok(s.api.visibleItems.value.length);
  assert.ok(s.api.scrollTop.value <= 60 * 38 - 2 - s.list.clientHeight);
  assert.equal(s.scrolls.at(-1)?.behavior, 'instant');
});

test('empty search results and clearing search recover all options at the top', async (t) => {
  const s = fixture(t);
  s.api.scrollTop.value = 6000;
  s.api.searchTerm.value = '不存在';
  await vue.nextTick();
  assert.equal(s.api.visibleItems.value.length, 0);
  s.api.searchTerm.value = '';
  await vue.nextTick();
  assert.equal(s.api.visibleItems.value[0]?.value, 0);
});

test('Escape in the search input closes the menu without changing selection', (t) => {
  const s = fixture(t);
  s.api.open.value = true;
  let prevented = false;
  s.api.handleSearchKeydown({ key: 'Escape', preventDefault: () => (prevented = true) });
  assert.equal(s.api.open.value, false);
  assert.equal(prevented, true);
  assert.deepEqual(s.events, []);
});

test('composition Escape leaves the search session intact', (t) => {
  const s = fixture(t);
  s.api.open.value = true;
  s.api.handleSearchKeydown({ key: 'Escape', isComposing: true });
  assert.equal(s.api.open.value, true);
});

for (const exit of ['close', 'disable']) {
  test(`${exit} before nextTick cancels deferred search focus and measurement`, async (t) => {
    const s = fixture(t);
    s.api.open.value = true;
    await vue.nextTick();
    if (exit === 'close') s.api.open.value = false;
    else s.props.disabled = true;
    await vue.nextTick();
    s.flush();
    assert.equal(s.focuses, 0);
    assert.equal(s.measurements, 0);
  });
}

test('closing search restores the selected label instead of displaying an abandoned query', async (t) => {
  const s = fixture(t);
  s.props.modelValue = 5;
  s.api.open.value = true;
  await vue.nextTick();
  s.api.searchTerm.value = '其他';
  s.api.open.value = false;
  await vue.nextTick();
  assert.equal(s.api.searchTerm.value, '');
  assert.equal(s.api.selectedLabel.value, '匹配 5');
  assert.deepEqual(s.events, []);
});

test('virtual rows include the option gap without adding a trailing gap', (t) => {
  const s = fixture(t);
  assert.equal(s.api.totalHeight.value, 200 * 38 - 2);
  s.api.scrollTop.value = 10 * 38;
  assert.equal(s.api.startIndex.value, 8);
  assert.equal(s.api.offsetY.value, 8 * 38);
  assert.equal(s.api.visibleItems.value[0]?.value, 8);
  s.props.options = [];
  assert.equal(s.api.totalHeight.value, 0);
});
