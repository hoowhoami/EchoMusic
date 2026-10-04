import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as date from '@internationalized/date';
import { compileScript, parse } from 'vue/compiler-sfc';

function fixture() {
  const hooks = { beforeUnmount: [], activate: [], deactivate: [] };
  const events = [];
  const props = vue.reactive({
    modelValue: '2026-10-04',
    disabled: false,
  });
  const deps = {
    vue: {
      ...vue,
      onBeforeUnmount: (fn) => hooks.beforeUnmount.push(fn),
      onActivated: (fn) => hooks.activate.push(fn),
      onDeactivated: (fn) => hooks.deactivate.push(fn),
    },
    '@internationalized/date': date,
  };
  function load(file) {
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('.vue'))
      source = compileScript(parse(source).descriptor, { id: 'cached-overlay' }).content;
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', code)(
      (name) => deps[name] ?? {},
      mod,
      mod.exports,
    );
    return mod.exports;
  }
  deps['@/composables/useCachedOverlayOpen'] = load(
    'src/renderer/composables/useCachedOverlayOpen.ts',
  );
  const component = load('src/renderer/components/ui/DatePicker.vue').default;
  const scope = vue.effectScope();
  const api = scope.run(() =>
    component.setup(props, {
      expose() {},
      emit: (event, value) => {
        events.push([event, value]);
      },
    }),
  );
  return {
    api,
    props,
    events,
    deactivate: () => hooks.deactivate.forEach((fn) => fn()),
    activate: () => hooks.activate.forEach((fn) => fn()),
    dispose: () => {
      hooks.beforeUnmount.forEach((fn) => fn());
      scope.stop();
    },
  };
}

test('DatePicker does not change a disabled value, but resumes normal selection', () => {
  const s = fixture();
  s.props.disabled = true;
  s.api.selectedDate.value = undefined;
  assert.equal(s.events.length, 0);
  s.props.disabled = false;
  s.api.selectedDate.value = date.parseDate('2026-10-05');
  assert.deepEqual(s.events, [['update:modelValue', '2026-10-05']]);
  s.api.selectedDate.value = undefined;
  assert.deepEqual(s.events.at(-1), ['update:modelValue', '']);
  s.dispose();
});

test('DatePicker closes for cache entry and rejects stale open events', () => {
  const s = fixture();
  s.api.handleOpenChange(true);
  assert.equal(s.api.open.value, true);
  s.deactivate();
  s.api.handleOpenChange(true);
  assert.equal(s.api.open.value, false);
  s.activate();
  assert.equal(s.api.open.value, false);
  s.api.handleOpenChange(true);
  assert.equal(s.api.open.value, true);
  s.dispose();
  s.api.handleOpenChange(true);
  assert.equal(s.api.open.value, false);
});

test('disabling DatePicker closes its calendar without reopening on enable', () => {
  const s = fixture();
  s.api.handleOpenChange(true);
  s.props.disabled = true;
  assert.equal(s.api.open.value, false);
  s.api.handleOpenChange(true);
  assert.equal(s.api.open.value, false);
  s.props.disabled = false;
  assert.equal(s.api.open.value, false);
  s.dispose();
});

test('DatePicker consumes Escape while closing its own calendar', () => {
  const s = fixture();
  s.api.handleOpenChange(true);
  let prevented = 0,
    stopped = 0;
  s.api.handleEscapeKeyDown({
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  });
  assert.equal(s.api.open.value, false);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(s.events.length, 0);
  s.dispose();
});
