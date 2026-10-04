import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

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
  let popover;
  const buttons = [],
    events = [];
  const props = vue.reactive(initial);
  const Popover = vue.defineComponent({
    props: ['open'],
    emits: ['update:open'],
    setup(props, { emit, slots }) {
      popover = { props, emit };
      return () => vue.h('div', slots.default?.());
    },
  });
  const Button = vue.defineComponent({
    setup(_, { attrs, slots }) {
      buttons.push(attrs);
      return () => vue.h('button', attrs, slots.default?.());
    },
  });
  const { descriptor } = parse(readFileSync('src/renderer/components/ui/Popconfirm.vue', 'utf8'));
  const source = compileScript(descriptor, { id: 'popconfirm-test', inlineTemplate: true }).content;
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => (id === 'vue' ? vue : id === './Popover.vue' ? Popover : Button),
    mod,
    mod.exports,
  );
  const app = renderer.createApp({
    render: () =>
      vue.h(mod.exports.default, {
        ...props,
        'onUpdate:open': (value) => events.push(['open', value]),
        onConfirm: () => events.push(['confirm']),
        onCancel: () => events.push(['cancel']),
      }),
  });
  app.mount({ children: [] });
  t.after(() => app.unmount());
  return {
    props,
    events,
    popover,
    click: (index) => buttons[index].onClick({ stopPropagation() {} }),
  };
}

test('Popover trigger and dismissal synchronize Popconfirm parent state once', async (t) => {
  const s = fixture(t);
  s.popover.emit('update:open', true);
  await vue.nextTick();
  assert.equal(s.popover.props.open, true);
  assert.deepEqual(s.events, [['open', true]]);
  s.popover.emit('update:open', false);
  s.popover.emit('update:open', false);
  await vue.nextTick();
  assert.equal(s.popover.props.open, false);
  assert.deepEqual(s.events, [
    ['open', true],
    ['open', false],
  ]);
});

test('parent-driven opening and closing do not echo updates', async (t) => {
  const s = fixture(t, { open: false });
  s.props.open = true;
  await vue.nextTick();
  assert.equal(s.popover.props.open, true);
  s.props.open = false;
  await vue.nextTick();
  assert.equal(s.popover.props.open, false);
  assert.deepEqual(s.events, []);
});

test('confirmation closes once and ignores another callback after close', (t) => {
  const s = fixture(t, { open: true });
  s.click(1);
  s.click(1);
  assert.deepEqual(s.events, [['open', false], ['confirm']]);
});

test('disabled and loading confirmations cannot emit destructive actions', async (t) => {
  const s = fixture(t, { open: true, disabled: true });
  s.click(1);
  assert.deepEqual(s.events, []);
  s.props.disabled = false;
  s.props.confirmLoading = true;
  await vue.nextTick();
  s.click(1);
  assert.deepEqual(s.events, []);
  s.props.confirmLoading = false;
  s.props.confirmDisabled = true;
  await vue.nextTick();
  s.click(1);
  assert.deepEqual(s.events, []);
});

test('cancel emits once while passive dismissal does not masquerade as cancel', (t) => {
  const s = fixture(t, { open: true });
  s.click(0);
  s.click(0);
  assert.deepEqual(s.events, [['open', false], ['cancel']]);
});
