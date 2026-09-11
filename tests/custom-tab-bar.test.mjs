import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as Vue from 'vue';

const { descriptor } = parse(
  readFileSync(new URL('../src/renderer/components/ui/CustomTabBar.vue', import.meta.url), 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'custom-tab-bar-test' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (name) => {
    if (name === 'vue') return Vue;
    if (name === '@/components/ui/Button.vue') return {};
    throw new Error(`Unexpected dependency ${name}`);
  },
  module,
  module.exports,
);

function setup(overrides = {}) {
  const props = Vue.reactive({
    tabs: ['熟悉', '默认', '尝鲜'],
    modelValue: 1,
    disabled: false,
    role: 'tablist',
    ...overrides,
  });
  const events = [];
  const scope = Vue.effectScope();
  const state = scope.run(() =>
    module.exports.default.setup(props, {
      expose() {},
      emit(name, index) {
        events.push([name, index]);
        props.modelValue = index;
      },
    }),
  );
  return { props, state, events, dispose: () => scope.stop() };
}

function key(key, count = 3) {
  const focused = [];
  let prevented = false;
  const event = {
    key,
    preventDefault() {
      prevented = true;
    },
    currentTarget: {
      closest() {
        return {
          querySelectorAll: () =>
            Array.from({ length: count }, (_, index) => ({
              focus() {
                focused.push(index);
              },
            })),
        };
      },
    },
  };
  return { event, focused, prevented: () => prevented };
}

test('existing tabs retain horizontal navigation, wraparound and focus movement', () => {
  const e = setup();
  const right = key('ArrowRight');
  e.state.handleKeydown(right.event, 1);
  assert.deepEqual(e.events, [['update:modelValue', 2]]);
  assert.deepEqual(right.focused, [2]);
  assert.equal(right.prevented(), true);
  const wrap = key('ArrowRight');
  e.state.handleKeydown(wrap.event, 2);
  assert.equal(e.props.modelValue, 0);
  assert.deepEqual(wrap.focused, [0]);
  const end = key('End');
  e.state.handleKeydown(end.event, 0);
  assert.equal(e.props.modelValue, 2);
  e.dispose();
});

test('single-value selection supports radio arrow keys; disabled controls cannot change values', () => {
  const e = setup({ role: 'radiogroup' });
  const down = key('ArrowDown');
  e.state.handleKeydown(down.event, 1);
  assert.equal(e.props.modelValue, 2);
  assert.deepEqual(down.focused, [2]);
  e.props.disabled = true;
  e.state.handleSelect(0);
  const home = key('Home');
  e.state.handleKeydown(home.event, 2);
  assert.equal(e.props.modelValue, 2);
  assert.equal(e.events.length, 1);
  assert.deepEqual(home.focused, []);
  e.dispose();
});

test('unknown values show no false selection, and invalid indices do not emit', () => {
  const e = setup({ modelValue: -1 });
  assert.equal(e.state.hasSelection.value, false);
  assert.equal(e.state.sliderStyle.value.visibility, 'hidden');
  for (const index of [-1, 3, NaN, 0.5]) e.state.handleSelect(index);
  assert.equal(e.events.length, 0);
  e.state.handleSelect(0);
  assert.equal(e.state.hasSelection.value, true);
  assert.equal(e.state.sliderStyle.value.visibility, 'visible');
  e.dispose();
});
