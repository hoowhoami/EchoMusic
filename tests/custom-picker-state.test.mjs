import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { useVModel } from '@vueuse/core';
import { compileScript, parse, registerTS } from 'vue/compiler-sfc';

registerTS(() => createRequire(import.meta.url)('typescript'));

const renderer = vue.createRenderer({
  createElement: (tag) => ({ tag, children: [] }),
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

function fixture(t, initial = {}) {
  let tabBar;
  const props = vue.reactive({
    open: true,
    title: '歌单分类',
    options: options('语种', '风格', '场景'),
    selectedId: '',
    ...initial,
  });
  const events = [];
  const wrapper = vue.defineComponent({
    setup(_, { slots }) {
      return () => vue.h('div', slots.default?.());
    },
  });
  const tabs = vue.defineComponent({
    props: ['tabs', 'modelValue'],
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      tabBar = { props, select: (index) => emit('update:modelValue', index) };
      return () => null;
    },
  });
  const Button = vue.defineComponent({
    setup(_, { attrs, slots }) {
      return () => vue.h('button', attrs, slots.default?.());
    },
  });
  const { descriptor } = parse(readFileSync('src/renderer/components/ui/CustomPicker.vue', 'utf8'));
  const { code } = transformSync(
    compileScript(descriptor, { id: 'custom-picker-state', inlineTemplate: true }).content,
    { loader: 'ts', format: 'cjs' },
  );
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id === 'vue') return vue;
      if (id === '@vueuse/core') return { useVModel };
      if (id === '@/components/ui/CustomTabBar.vue') return tabs;
      if (id === '@/components/ui/Button.vue') return Button;
      if (['@/components/ui/Dialog.vue', '@/components/ui/Scrollbar.vue'].includes(id))
        return wrapper;
      throw new Error(`Unexpected dependency ${id}`);
    },
    mod,
    mod.exports,
  );
  const root = { children: [] };
  const app = renderer.createApp({
    render: () =>
      vue.h(mod.exports.default, {
        ...props,
        onSelect: (option) => events.push(['select', option.id]),
        'onUpdate:open': (open) => {
          props.open = open;
          events.push(['open', open]);
        },
      }),
  });
  app.mount(root);
  t.after(() => app.unmount());
  const buttons = (node = root) => [
    ...(node.tag === 'button' ? [node] : []),
    ...(node.children?.flatMap(buttons) ?? []),
  ];
  const textContent = (node) => node.text ?? node.children?.map(textContent).join('') ?? '';
  return { props, events, tab: () => tabBar, buttons, names: () => buttons().map(textContent) };
}

function options(...groups) {
  return groups.map((group) => ({ id: group, name: group, group }));
}

test('initially open picker shows the selected group', (t) => {
  const s = fixture(t, { selectedId: '场景' });
  assert.equal(s.tab().props.modelValue, 2);
  assert.deepEqual(s.names(), ['场景']);
  assert.deepEqual(s.events, []);
});

test('group reordering preserves the group the user is browsing', async (t) => {
  const s = fixture(t);
  s.tab().select(1);
  await vue.nextTick();
  s.props.options = options('风格', '语种', '场景');
  await vue.nextTick();
  assert.equal(s.tab().props.modelValue, 0);
  assert.deepEqual(s.names(), ['风格']);
  assert.deepEqual(s.events, []);
});

test('removing the current group selects the first remaining tab rather than all options', async (t) => {
  const s = fixture(t);
  s.tab().select(2);
  await vue.nextTick();
  s.props.options = options('语种', '风格');
  await vue.nextTick();
  assert.equal(s.tab().props.modelValue, 0);
  assert.deepEqual(s.names(), ['语种']);
});

test('opening again without a grouped selection starts at the first tab', async (t) => {
  const s = fixture(t);
  s.tab().select(2);
  await vue.nextTick();
  s.props.open = false;
  await vue.nextTick();
  s.props.open = true;
  await vue.nextTick();
  assert.equal(s.tab().props.modelValue, 0);
  assert.deepEqual(s.names(), ['语种']);
});

test('options arriving after opening reveal the selected group', async (t) => {
  const s = fixture(t, { options: [], selectedId: '场景' });
  assert.deepEqual(s.names(), []);
  s.props.options = options('语种', '风格', '场景');
  await vue.nextTick();
  assert.equal(s.tab().props.modelValue, 2);
  assert.deepEqual(s.names(), ['场景']);
});

test('a single group becoming tabbed reveals the selected group', async (t) => {
  const s = fixture(t, { options: options('语种'), selectedId: '场景' });
  s.props.options = options('语种', '风格', '场景');
  await vue.nextTick();
  assert.equal(s.tab().props.modelValue, 2);
  assert.deepEqual(s.names(), ['场景']);
});

test('ungrouped options and selecting then closing retain existing behavior', (t) => {
  const s = fixture(t, {
    options: [
      { id: 'all', name: '全部' },
      { id: 'new', name: '最新' },
    ],
  });
  assert.deepEqual(s.names(), ['全部', '最新']);
  s.buttons()[1].onClick();
  assert.deepEqual(s.events, [
    ['select', 'new'],
    ['open', false],
  ]);
});
