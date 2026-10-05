import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as reka from 'reka-ui';
import { compileScript, parse } from 'vue/compiler-sfc';

function loadComponent(file, deps = {}) {
  const { descriptor } = parse(readFileSync(file, 'utf8'));
  const { code } = transformSync(compileScript(descriptor, { id: 'tooltip-lifecycle' }).content, {
    loader: 'ts',
    format: 'cjs',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => deps[id] ?? (id === 'vue' ? vue : id === 'reka-ui' ? reka : {}),
    mod,
    mod.exports,
  );
  return mod.exports.default;
}
const Bridge = loadComponent('src/renderer/components/ui/TooltipLifecycle.vue');
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
function rootFixture(t, withBridge = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldDocument = globalThis.document;
  globalThis.document = new EventTarget();
  const active = vue.ref(true),
    open = vue.ref(false),
    input = vue.ref(null);
  let context,
    mounts = 0,
    inputState;
  const Probe = vue.defineComponent({
    setup() {
      context = reka.injectTooltipRootContext();
      inputState = vue.ref('原输入');
      vue.onMounted(() => mounts++);
      return () => vue.h('input', { ref: input, value: inputState.value });
    },
  });
  const Page = vue.defineComponent({
    setup: () => () =>
      vue.h(
        reka.TooltipRoot,
        { open: open.value, 'onUpdate:open': (value) => (open.value = value) },
        () => [withBridge ? vue.h(Bridge) : null, vue.h(Probe)],
      ),
  });
  const app = renderer.createApp({
    render: () =>
      vue.h(reka.TooltipProvider, { delayDuration: 350 }, () =>
        vue.h(vue.KeepAlive, {}, () => (active.value ? vue.h(Page) : null)),
      ),
  });
  app.mount({ children: [] });
  t.after(() => {
    app.unmount();
    globalThis.document = oldDocument;
  });
  return {
    active,
    open,
    input,
    get context() {
      return context;
    },
    get mounts() {
      return mounts;
    },
    get inputState() {
      return inputState;
    },
  };
}

test('control: Reka delayed open survives a cached round trip without lifecycle cancellation', async (t) => {
  const s = rootFixture(t, false);
  s.context.onTriggerEnter();
  s.active.value = false;
  await vue.nextTick();
  s.active.value = true;
  await vue.nextTick();
  t.mock.timers.tick(351);
  await vue.nextTick();
  assert.equal(s.open.value, true);
});

test('cached round trip cancels the real Reka timer without remounting the trigger', async (t) => {
  const s = rootFixture(t);
  const input = s.input.value;
  s.inputState.value = '保留的输入';
  s.context.onTriggerEnter();
  s.active.value = false;
  await vue.nextTick();
  s.active.value = true;
  await vue.nextTick();
  t.mock.timers.tick(351);
  await vue.nextTick();
  assert.equal(s.open.value, false);
  assert.equal(s.mounts, 1);
  assert.equal(s.input.value, input);
  assert.equal(s.input.value.value, '保留的输入');
  s.context.onTriggerEnter();
  t.mock.timers.tick(351);
  await vue.nextTick();
  assert.equal(s.open.value, true);
});

test('an already-open tooltip closes on cache entry and accepts fresh focus after return', async (t) => {
  const s = rootFixture(t);
  s.context.onOpen();
  await vue.nextTick();
  assert.equal(s.open.value, true);
  s.active.value = false;
  await vue.nextTick();
  assert.equal(s.open.value, false);
  s.active.value = true;
  await vue.nextTick();
  assert.equal(s.open.value, false);
  s.context.onOpen();
  await vue.nextTick();
  assert.equal(s.open.value, true);
});

function wrapperFixture(registerBranch = null) {
  const hooks = {};
  const trigger = vue.ref({
    closest: () => null,
    querySelectorAll: () => [],
    scrollWidth: 200,
    clientWidth: 100,
    scrollHeight: 20,
    clientHeight: 20,
  });
  const component = loadComponent('src/renderer/components/ui/Tooltip.vue', {
    vue: {
      ...vue,
      useSlots: () => ({}),
      inject: () => registerBranch,
      onActivated: (fn) => (hooks.activate = fn),
      onDeactivated: (fn) => (hooks.deactivate = fn),
      onBeforeUnmount: (fn) => (hooks.unmount = fn),
    },
    'reka-ui': { useForwardExpose: () => ({ forwardRef() {}, currentElement: trigger }) },
  });
  const props = vue.reactive({ content: '播放', disabled: false, overflowOnly: false });
  const scope = vue.effectScope();
  const api = scope.run(() => component.setup(props, { expose() {} }));
  return {
    props,
    api,
    trigger,
    deactivate: () => hooks.deactivate?.(),
    activate: () => hooks.activate?.(),
    dispose() {
      hooks.unmount?.();
      scope.stop();
    },
  };
}

test('hidden and disposed wrappers reject delayed open events; fresh activation allows them', () => {
  const s = wrapperFixture();
  s.api.updateOpen(true);
  s.deactivate();
  assert.equal(s.api.open.value, false);
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, false);
  s.activate();
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, true);
  s.dispose();
  s.activate();
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, false);
});

test('only visible owned tooltip content is inside its parent branch, including the arrow', () => {
  let contains;
  let removed = 0;
  const s = wrapperFixture((branch) => {
    contains = branch;
    return () => removed++;
  });
  const body = {},
    arrow = {},
    unrelated = {};
  s.api.contentWrapRef.value = {
    parentElement: { contains: (target) => target === body || target === arrow },
  };
  assert.equal(contains(body), false);
  s.api.updateOpen(true);
  assert.equal(contains(body), true);
  assert.equal(contains(arrow), true);
  assert.equal(contains(unrelated), false);
  s.api.updateOpen(false);
  assert.equal(contains(body), false);
  s.api.updateOpen(true);
  s.deactivate();
  assert.equal(contains(body), false);
  assert.equal(removed, 0);
  s.activate();
  s.api.updateOpen(true);
  assert.equal(contains(body), true);
  s.dispose();
  assert.equal(contains(body), false);
  assert.equal(removed, 1);
});

test('disabled, overflow-only and expanded-popover suppression remain intact', async () => {
  const s = wrapperFixture();
  s.props.disabled = true;
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, false);
  s.props.disabled = false;
  s.props.overflowOnly = true;
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, true);
  s.trigger.value.clientWidth = 200;
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, false);
  s.props.overflowOnly = false;
  s.trigger.value.closest = () => ({});
  s.api.updateOpen(true);
  assert.equal(s.api.open.value, false);
  s.trigger.value.closest = () => null;
  s.api.updateOpen(true);
  s.props.content = '暂停';
  await vue.nextTick();
  assert.equal(s.api.open.value, false);
  s.dispose();
});
