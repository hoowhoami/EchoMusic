import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { useVModel } from '@vueuse/core';
import { compileScript, parse, registerTS } from 'vue/compiler-sfc';

registerTS(() => createRequire(import.meta.url)('typescript'));

// The renderer exercises the compiled button and real useVModel. Native text
// editing/composition is validated in the browser, outside this DOM-free fixture.
const renderer = vue.createRenderer({
  createElement: (tag) => ({
    tag,
    children: [],
    focusCalls: [],
    focus(options) {
      this.focusCalls.push(options);
    },
    matches() {
      return this.inheritedDisabled ?? false;
    },
  }),
  createText: (text) => ({ text }),
  createComment: (text) => ({ text }),
  setText: (node, text) => (node.text = text),
  setElementText: (node, text) => (node.text = text),
  patchProp: (node, key, _, value) => (node[key] = value),
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});
const filename = resolve('src/renderer/components/ui/Input.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const { code } = transformSync(
  compileScript(descriptor, { id: 'input-clear-test', inlineTemplate: true }).content,
  { loader: 'ts', format: 'cjs' },
);
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (id) =>
    id === 'vue' ? { ...vue, vModelDynamic: {} } : id === '@vueuse/core' ? { useVModel } : {},
  mod,
  mod.exports,
);

function fixture(t, initial = {}) {
  const props = vue.reactive({ modelValue: 'EchoMusic', ...initial });
  const events = [];
  const root = { children: [] };
  const app = renderer.createApp({
    render: () =>
      vue.h(mod.exports.default, {
        ...props,
        'onUpdate:modelValue': (value) => {
          events.push(['update', value]);
          props.modelValue = value;
        },
        onClear: () => events.push(['clear']),
      }),
  });
  app.component('Icon', { render: () => null });
  app.mount(root);
  t.after(() => app.unmount());
  const find = (tag, node = root) =>
    node.tag === tag ? node : node.children?.map((child) => find(tag, child)).find(Boolean);
  return { props, events, input: () => find('input'), button: () => find('button') };
}

test('clear is named, does not submit, emits once and returns focus without scrolling', async (t) => {
  const s = fixture(t);
  const button = s.button();
  assert.equal(button['aria-label'], '清空输入');
  assert.equal(button.type, 'button');
  button.onClick();
  await vue.nextTick();
  button.onClick();
  await vue.nextTick();
  assert.equal(s.props.modelValue, '');
  assert.deepEqual(s.events, [['update', ''], ['clear']]);
  assert.deepEqual(s.input().focusCalls, [{ preventScroll: true }]);
  assert.ok(!s.button());
});

for (const flag of ['disabled', 'readonly']) {
  test(`${flag} protects both the native input and a late clear callback`, async (t) => {
    const s = fixture(t);
    const clear = s.button().onClick;
    s.props[flag] = true;
    await vue.nextTick();
    assert.equal(s.input()[flag], true);
    assert.ok(!s.button());
    clear();
    assert.deepEqual(s.events, []);
    assert.equal(s.props.modelValue, 'EchoMusic');
    assert.equal(s.input().focusCalls.length, 0);
    s.props[flag] = false;
    await vue.nextTick();
    s.button().onClick();
    assert.deepEqual(s.events, [['update', ''], ['clear']]);
  });
}

test('numeric zero is clearable and empty or missing values are not', async (t) => {
  const s = fixture(t, { modelValue: 0 });
  assert.ok(s.button());
  s.button().onClick();
  assert.equal(s.props.modelValue, '');
  await vue.nextTick();
  assert.ok(!s.button());
  s.props.modelValue = undefined;
  await vue.nextTick();
  assert.ok(!s.button());
});

test('showClear false also rejects a retained callback', async (t) => {
  const s = fixture(t);
  const clear = s.button().onClick;
  s.props.showClear = false;
  await vue.nextTick();
  assert.ok(!s.button());
  clear();
  assert.deepEqual(s.events, []);
});

test('a disabled ancestor fieldset prevents programmatic clearing', (t) => {
  const s = fixture(t);
  s.input().inheritedDisabled = true;
  s.button().onClick();
  assert.deepEqual(s.events, []);
  assert.equal(s.input().focusCalls.length, 0);
});

test('ids, accessible names, input classes and keyboard listeners still reach the input', (t) => {
  const onKeydown = () => {};
  const s = fixture(t, {
    id: 'nickname',
    'aria-label': '昵称',
    inputClass: 'test-input',
    onKeydown,
  });
  assert.equal(s.input().id, 'nickname');
  assert.equal(s.input()['aria-label'], '昵称');
  assert.match(s.input().class, /test-input/);
  assert.equal(s.input().onKeydown, onKeydown);
});
