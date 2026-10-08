import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const { descriptor } = parse(readFileSync('src/renderer/components/ui/Popover.vue', 'utf8'));
const { code } = transformSync(compileScript(descriptor, { id: 'popover-lifecycle' }).content, {
  loader: 'ts',
  format: 'cjs',
});
function fixture(overrides = {}) {
  const hooks = {},
    timers = new Map(),
    listeners = new Set(),
    pointerListeners = new Set(),
    events = [];
  let nextTimer = 0,
    exposed,
    removedBranches = 0;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'document', 'setTimeout', 'clearTimeout', code)(
    (id) =>
      id === 'vue'
        ? {
            ...vue,
            onMounted: (fn) => (hooks.mount = fn),
            onUnmounted: (fn) => (hooks.unmount = fn),
            onActivated: (fn) => (hooks.activate = fn),
            onDeactivated: (fn) => (hooks.deactivate = fn),
            provide() {},
            inject: () => () => () => removedBranches++,
          }
        : {},
    mod,
    mod.exports,
    {
      addEventListener: (type, fn) =>
        (type === 'pointermove' ? pointerListeners : listeners).add(fn),
      removeEventListener: (type, fn) =>
        (type === 'pointermove' ? pointerListeners : listeners).delete(fn),
    },
    (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    (id) => timers.delete(id),
  );
  const props = vue.reactive({
    trigger: 'hover',
    open: undefined,
    disabled: false,
    holdOpen: false,
    delay: 100,
    duration: 100,
    ...overrides,
  });
  const scope = vue.effectScope();
  const api = scope.run(() =>
    mod.exports.default.setup(props, {
      expose: (value) => (exposed = value),
      emit: (...args) => events.push(args),
    }),
  );
  hooks.mount?.();
  return {
    api,
    props,
    exposed,
    timers,
    listeners,
    pointerListeners,
    events,
    get removedBranches() {
      return removedBranches;
    },
    tick: () => {
      const jobs = [...timers.values()];
      timers.clear();
      jobs.forEach((fn) => fn());
    },
    deactivate: () => hooks.deactivate?.(),
    activate: () => hooks.activate?.(),
    dispose: () => {
      hooks.unmount?.();
      scope.stop();
    },
  };
}

test('explicit close cancels delayed hover opening; explicit open cancels delayed closing', () => {
  const s = fixture();
  s.api.handleTriggerEnter();
  s.exposed.close();
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.exposed.open();
  s.api.handleTriggerLeave();
  s.exposed.open();
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.dispose();
});

test('hovering a portalled descendant cancels parent closing, leaving the whole region closes it', () => {
  const s = fixture();
  const nestedPanel = {};
  s.api.registerPopoverBranch((target) => target === nestedPanel);
  s.exposed.open();
  s.api.handleContentLeave();
  s.api.handleDocumentPointerMove({ target: nestedPanel });
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.api.handleDocumentPointerMove({ target: {} });
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('direct movement from parent content into a nested popover does not schedule closing', () => {
  const s = fixture();
  const nestedPanel = {};
  s.api.registerPopoverBranch((target) => target === nestedPanel);
  s.exposed.open();
  s.api.handleContentLeave({ relatedTarget: nestedPanel });
  assert.equal(s.timers.size, 0);
  assert.equal(s.api.isOpen.value, true);
  s.dispose();
});

test('unrelated or unregistered popover branches cannot keep a hover panel open', () => {
  const s = fixture();
  const nestedPanel = {};
  const unregister = s.api.registerPopoverBranch((target) => target === nestedPanel);
  s.exposed.open();
  s.api.handleDocumentPointerMove({ target: {} });
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.exposed.open();
  unregister();
  s.api.handleDocumentPointerMove({ target: nestedPanel });
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('clicking a nested popover keeps its click panel open, outside clicks still close it', () => {
  const s = fixture({ trigger: 'click' });
  const nestedPanel = {};
  s.api.registerPopoverBranch((target) => target === nestedPanel);
  s.exposed.open();
  s.api.handleDocumentMousedown({ target: nestedPanel });
  assert.equal(s.api.isOpen.value, true);
  s.api.handleDocumentMousedown({ target: {} });
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('pointer tracking exists only while a hover panel is open and active', () => {
  const s = fixture();
  assert.equal(s.pointerListeners.size, 0);
  s.exposed.open();
  assert.equal(s.pointerListeners.size, 1);
  s.props.trigger = 'click';
  assert.equal(s.pointerListeners.size, 0);
  assert.equal(s.listeners.size, 1);
  s.props.trigger = 'hover';
  assert.equal(s.pointerListeners.size, 1);
  s.deactivate();
  assert.equal(s.pointerListeners.size, 0);
  s.activate();
  assert.equal(s.pointerListeners.size, 0);
  s.exposed.open();
  assert.equal(s.pointerListeners.size, 1);
  s.dispose();
  assert.equal(s.pointerListeners.size, 0);
});

test('parent open changes win over already queued hover work', async () => {
  const s = fixture({ open: true });
  s.api.handleTriggerEnter();
  s.props.open = false;
  await vue.nextTick();
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.api.handleTriggerLeave();
  s.props.open = true;
  await vue.nextTick();
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.dispose();
});

test('holdOpen cancels an earlier mouseleave timer while explicit close still works', async () => {
  const s = fixture();
  s.exposed.open();
  s.api.handleContentLeave();
  s.props.holdOpen = true;
  await vue.nextTick();
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.api.handleContentLeave();
  assert.equal(s.timers.size, 0);
  s.exposed.close();
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('cached popovers discard pending timers and cannot reopen from hidden triggers', async () => {
  const s = fixture();
  s.api.handleTriggerEnter();
  s.deactivate();
  assert.equal(s.timers.size, 0);
  s.tick();
  s.api.handleTriggerEnter();
  s.exposed.open();
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.activate();
  s.api.handleTriggerEnter();
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.deactivate();
  assert.equal(s.api.isOpen.value, false);
  assert.deepEqual(s.events.at(-1), ['update:open', false]);
  s.activate();
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('outside-click listener exists only for an open active click popover', async () => {
  const s = fixture({ trigger: 'click' });
  await vue.nextTick();
  assert.equal(s.listeners.size, 0);
  s.api.handleTriggerClick();
  await vue.nextTick();
  assert.equal(s.listeners.size, 1);
  s.api.handleTriggerClick();
  await vue.nextTick();
  assert.equal(s.listeners.size, 0);
  s.exposed.open();
  s.props.trigger = 'hover';
  await vue.nextTick();
  assert.equal(s.listeners.size, 0);
  s.props.trigger = 'click';
  await vue.nextTick();
  assert.equal(s.listeners.size, 1);
  s.deactivate();
  await vue.nextTick();
  assert.equal(s.listeners.size, 0);
  s.dispose();
});

test('manual mode follows parent state but stays hidden while cached or disabled', async () => {
  const s = fixture({ trigger: 'manual', open: true });
  assert.equal(s.api.isOpen.value, true);
  s.deactivate();
  assert.equal(s.api.isOpen.value, false);
  s.activate();
  assert.equal(s.api.isOpen.value, true); // parent still explicitly requests open
  s.props.disabled = true;
  await vue.nextTick();
  assert.equal(s.api.isOpen.value, false);
  s.exposed.open();
  assert.equal(s.api.isOpen.value, false);
  s.dispose();
});

test('unmount clears pending work and unregisters its parent branch', async () => {
  const s = fixture({ trigger: 'click' });
  s.exposed.open();
  await vue.nextTick();
  s.dispose();
  assert.equal(s.removedBranches, 1);
  assert.equal(s.listeners.size, 0);
  s.exposed.open();
  s.activate();
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  assert.equal(s.listeners.size, 0);
});

test('Escape closes the highest popover immediately and consumes the key', () => {
  const s = fixture();
  s.exposed.open();
  s.api.handleTriggerLeave();
  let prevented = false,
    stopped = false;
  s.api.handleEscapeKeyDown({
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(s.api.isOpen.value, false);
  assert.equal(s.timers.size, 0);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  s.dispose();
});

test('held-open and exiting popovers still consume Escape without closing a lower layer', () => {
  const s = fixture({ holdOpen: true });
  s.exposed.open();
  let prevented = 0;
  const event = {
    preventDefault() {
      prevented++;
    },
    stopPropagation() {},
  };
  s.api.handleEscapeKeyDown(event);
  assert.equal(s.api.isOpen.value, true);
  s.exposed.close();
  const count = s.events.length;
  s.api.handleEscapeKeyDown(event);
  assert.equal(s.events.length, count);
  assert.equal(prevented, 2);
  s.dispose();
});

test('click panels ignore hover events, preserve nested popovers, and close on another click', () => {
  const s = fixture({ trigger: 'click' });
  const nestedPanel = {};
  s.api.registerPopoverBranch((target) => target === nestedPanel);
  s.api.handleTriggerEnter();
  s.tick();
  assert.equal(s.api.isOpen.value, false);
  s.api.handleTriggerClick();
  assert.equal(s.api.isOpen.value, true);
  s.api.handleContentLeave({ relatedTarget: {} });
  s.api.handleTriggerLeave();
  s.api.handleDocumentPointerMove({ target: {} });
  s.tick();
  assert.equal(s.api.isOpen.value, true);
  s.api.handleDocumentMousedown({ target: nestedPanel });
  assert.equal(s.api.isOpen.value, true);
  s.api.handleTriggerClick();
  assert.equal(s.api.isOpen.value, false);
  s.exposed.open();
  s.api.handleDocumentMousedown({ target: {} });
  assert.equal(
    s.api.isOpen.value,
    false,
    'nested popover does not prevent explicit outside dismissal',
  );
  s.dispose();
});
