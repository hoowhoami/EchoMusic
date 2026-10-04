import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { useVModel } from '@vueuse/core';
import { compileScript, parse } from 'vue/compiler-sfc';

function fixture(kind, initialOpen = false, controlled = true) {
  const hooks = { mount: [], unmount: [], beforeUnmount: [], activate: [], deactivate: [] };
  const listeners = new Set(),
    events = [];
  const props = vue.reactive({
    open: initialOpen,
    modal: true,
    closeOnEscape: true,
    closeOnInteractOutside: true,
  });
  const deps = {
    vue: {
      ...vue,
      useSlots: () => ({}),
      onMounted: (fn) => hooks.mount.push(fn),
      onUnmounted: (fn) => hooks.unmount.push(fn),
      onBeforeUnmount: (fn) => hooks.beforeUnmount.push(fn),
      onActivated: (fn) => hooks.activate.push(fn),
      onDeactivated: (fn) => hooks.deactivate.push(fn),
    },
    '@vueuse/core': { useVModel },
    './overlayEscape': { isTopmostDrawer: () => true },
  };
  function load(file) {
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('.vue'))
      source = compileScript(parse(source).descriptor, { id: 'cached-overlay' }).content;
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'window', code)(
      (name) => deps[name] ?? {},
      mod,
      mod.exports,
      {
        addEventListener: (_, fn) => listeners.add(fn),
        removeEventListener: (_, fn) => listeners.delete(fn),
      },
    );
    return mod.exports;
  }
  deps['@/composables/useCachedOverlayOpen'] = load(
    'src/renderer/composables/useCachedOverlayOpen.ts',
  );
  deps['@/components/ui/dialogStack'] = load('src/renderer/components/ui/dialogStack.ts');
  const component = load(`src/renderer/components/ui/${kind}.vue`).default;
  const scope = vue.effectScope();
  const api = scope.run(() =>
    component.setup(props, {
      expose() {},
      emit: (event, value) => {
        events.push([event, value]);
        if (controlled) props.open = value;
      },
    }),
  );
  hooks.mount.forEach((fn) => fn());
  return {
    api,
    props,
    events,
    listeners,
    deactivate: () => hooks.deactivate.forEach((fn) => fn()),
    activate: () => hooks.activate.forEach((fn) => fn()),
    dispose: () => {
      hooks.beforeUnmount.forEach((fn) => fn());
      scope.stop();
      hooks.unmount.forEach((fn) => fn());
    },
  };
}

for (const kind of ['Dialog', 'Drawer']) {
  test(`${kind} closes on cache entry and does not reopen on return`, async () => {
    const s = fixture(kind, true);
    s.deactivate();
    assert.equal(s.api.open.value, false);
    assert.equal(s.props.open, false);
    assert.deepEqual(s.events, [['update:open', false]]);
    s.api.open.value = true;
    assert.equal(s.props.open, false);
    s.activate();
    assert.equal(s.api.open.value, false);
    s.props.open = true;
    await vue.nextTick();
    assert.equal(s.api.open.value, true);
    s.dispose();
  });
  test(`${kind} stays hidden while cached even when its parent ignores the close request`, async () => {
    const s = fixture(kind, true, false);
    s.deactivate();
    assert.equal(s.props.open, true);
    assert.equal(s.api.open.value, false);
    s.api.open.value = true;
    assert.deepEqual(s.events, [['update:open', false]]);
    s.activate();
    assert.equal(s.api.open.value, true); // preserve the parent's explicit controlled value
    s.dispose();
    s.activate();
    s.api.open.value = true;
    assert.equal(s.api.open.value, false);
    assert.equal(s.events.length, 1);
  });
  test(`${kind} receives fresh parent state during cache without displaying it early`, async () => {
    const s = fixture(kind);
    s.deactivate();
    assert.equal(s.events.length, 0);
    s.props.open = true;
    await vue.nextTick();
    assert.equal(s.api.open.value, false);
    s.activate();
    assert.equal(s.api.open.value, true);
    s.dispose();
  });
}

test('Drawer subscribes to Escape only while open and honors handled key events', async () => {
  const s = fixture('Drawer');
  assert.equal(s.listeners.size, 0);
  s.props.open = true;
  await vue.nextTick();
  assert.equal(s.listeners.size, 1);
  let stopped = false;
  const event = {
    key: 'Escape',
    defaultPrevented: true,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  for (const fn of s.listeners) fn(event);
  assert.equal(s.api.open.value, true);
  assert.equal(stopped, false);
  event.defaultPrevented = false;
  for (const fn of [...s.listeners]) fn(event);
  assert.equal(s.api.open.value, false);
  assert.equal(s.listeners.size, 0);
  assert.equal(stopped, true);
  s.props.open = true;
  await vue.nextTick();
  s.deactivate();
  assert.equal(s.listeners.size, 0);
  s.activate();
  assert.equal(s.listeners.size, 0);
  s.props.open = true;
  await vue.nextTick();
  assert.equal(s.listeners.size, 1);
  s.dispose();
  assert.equal(s.listeners.size, 0);
});

test('Dialog becomes noninteractive on cache entry and releases its stack entry after Presence leaves', () => {
  const s = fixture('Dialog', true);
  s.api.presenceElement.value = {};
  assert.equal(s.api.isInteractive.value, true);
  s.deactivate();
  assert.equal(s.api.isInteractive.value, false);
  assert.equal(s.api.isTop.value, true); // retain the closing layer until its animation finishes
  s.api.finishClose();
  assert.equal(s.api.isTop.value, false);
  s.dispose();
});
