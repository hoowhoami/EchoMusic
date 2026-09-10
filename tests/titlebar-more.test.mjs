import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { ref, computed } from 'vue';
const source = readFileSync(
  new URL('../src/renderer/layouts/TitleBarMoreMenu.vue', import.meta.url),
  'utf8',
);
const snippet = source.slice(source.indexOf('const props ='), source.indexOf('</script>'));
const { code } = transformSync(
  snippet + '\nreturn { open, togglePin, activate, handleNativePointerDown };',
  {
    loader: 'ts',
  },
);
function setup(target = null) {
  const settings = { titlebarLayout: { placements: {}, order: ['a'] } };
  const api = new Function(
    'defineProps',
    'ref',
    'computed',
    'useSettingStore',
    'useTitlebarSort',
    'onMounted',
    'onUnmounted',
    'document',
    code,
  )(
    () => ({ items: [] }),
    ref,
    computed,
    () => settings,
    () => {},
    () => {},
    () => {},
    { elementFromPoint: () => target },
  );
  api.open.value = true;
  return { settings, ...api };
}
test('pin and unpin persist without closing the popover or executing the action', () => {
  const s = setup();
  let calls = 0;
  const item = { key: 'a', placement: 'more', onClick: () => calls++ };
  s.togglePin(item);
  assert.equal(s.settings.titlebarLayout.placements.a, 'toolbar');
  assert.equal(s.open.value, true);
  s.togglePin({ ...item, placement: 'toolbar' });
  assert.equal(s.settings.titlebarLayout.placements.a, 'more');
  assert.deepEqual(s.settings.titlebarLayout.order, ['a']);
  assert.equal(s.open.value, true);
  assert.equal(calls, 0);
});
test('activation closes the popover; disabled actions do not execute or close it', () => {
  const s = setup();
  let calls = 0;
  s.activate({ isDisabled: true, onClick: () => calls++ });
  assert.equal(s.open.value, true);
  assert.equal(calls, 0);
  s.activate({ isDisabled: false, onClick: () => calls++ });
  assert.equal(s.open.value, false);
  assert.equal(calls, 1);
});

test('native titlebar click closes More; delayed pin and trigger notifications do not', () => {
  const s = setup({ closest: () => true });
  s.handleNativePointerDown({ x: 500, y: 20 });
  assert.equal(s.open.value, false);
  const buttonClick = setup({ closest: () => null });
  buttonClick.handleNativePointerDown({ x: 500, y: 20 });
  assert.equal(buttonClick.open.value, true);
});

test('native window movement/blur dismisses More and invalid payloads are ignored', () => {
  const s = setup();
  for (const point of [null, {}, { x: NaN, y: 0 }, { x: 1, y: '2' }])
    s.handleNativePointerDown(point);
  assert.equal(s.open.value, true);
  s.handleNativePointerDown();
  assert.equal(s.open.value, false);
});
