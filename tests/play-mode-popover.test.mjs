import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as vue from 'vue';

const controlsSource = transformSync(
  readFileSync('src/renderer/composables/usePlayerControls.ts', 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const controlsModule = { exports: {} };
new Function('require', 'module', 'exports', controlsSource)(
  (id) => (id === 'vue' ? vue : {}),
  controlsModule,
  controlsModule.exports,
);
const { playModeOptions } = controlsModule.exports;
const { descriptor } = parse(
  readFileSync('src/renderer/components/player/PlayModePopover.vue', 'utf8'),
);
const source = transformSync(compileScript(descriptor, { id: 'play-mode-popover' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;

function fixture(t, controlled = false) {
  const calls = [],
    events = [];
  const player = vue.reactive({
    playMode: 'list',
    setPlayMode(mode) {
      calls.push(mode);
      this.playMode = mode;
    },
  });
  const props = vue.reactive({ open: controlled ? true : undefined });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id) =>
      id === 'vue'
        ? vue
        : id === '@/composables/usePlayerControls'
          ? { playModeOptions, usePlayerControls: () => ({ player }) }
          : {},
    mod,
    mod.exports,
  );
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const api = scope.run(() =>
    mod.exports.default.setup(props, {
      expose() {},
      emit: (...args) => events.push(args),
    }),
  );
  return { api, player, props, calls, events };
}

test('opening the chooser preserves the mode; selecting each mode calls the store and closes', (t) => {
  const s = fixture(t);
  assert.deepEqual(
    playModeOptions.map((option) => option.value),
    ['sequential', 'list', 'random', 'single'],
  );
  for (const option of playModeOptions) {
    const previous = s.player.playMode;
    s.api.popoverOpen.value = true;
    assert.equal(s.player.playMode, previous);
    s.api.selectMode(option.value);
    assert.equal(s.player.playMode, option.value);
    assert.equal(s.calls.at(-1), option.value);
    assert.equal(s.api.popoverOpen.value, false);
    assert.deepEqual(s.events.at(-1), ['update:open', false]);
  }
});

test('reselecting the current random mode closes without resetting its queue', (t) => {
  const s = fixture(t);
  s.player.playMode = 'random';
  s.api.popoverOpen.value = true;
  s.api.selectMode('random');
  assert.deepEqual(s.calls, []);
  assert.equal(s.api.popoverOpen.value, false);
});

test('a chooser launched from More synchronizes selection and dismissal with its owner', (t) => {
  const s = fixture(t, true);
  assert.equal(s.api.popoverOpen.value, true);
  s.api.selectMode('single');
  assert.equal(s.player.playMode, 'single');
  assert.deepEqual(s.events.at(-1), ['update:open', false]);
  s.props.open = false;
  assert.equal(s.api.popoverOpen.value, false);
});
