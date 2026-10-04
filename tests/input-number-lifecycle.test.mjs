import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

function fixture() {
  const hooks = { deactivate: [], activate: [], unmount: [] };
  const timeouts = new Map(),
    intervals = new Map(),
    listeners = new Map();
  const events = [];
  let id = 0;
  const props = vue.reactive({ modelValue: '5', min: 0, max: 100, step: 1, disabled: false });
  const window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  };
  const { descriptor } = parse(readFileSync('src/renderer/components/ui/InputNumber.vue', 'utf8'));
  const { code } = transformSync(compileScript(descriptor, { id: 'input-number' }).content, {
    loader: 'ts',
    format: 'cjs',
  });
  const mod = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    code,
  )(
    (name) =>
      name === 'vue'
        ? {
            ...vue,
            onDeactivated: (fn) => hooks.deactivate.push(fn),
            onActivated: (fn) => hooks.activate.push(fn),
            onBeforeUnmount: (fn) => hooks.unmount.push(fn),
          }
        : {},
    mod,
    mod.exports,
    window,
    (fn) => {
      timeouts.set(++id, fn);
      return id;
    },
    (id) => timeouts.delete(id),
    (fn) => {
      intervals.set(++id, fn);
      return id;
    },
    (id) => intervals.delete(id),
  );
  const scope = vue.effectScope();
  const api = scope.run(() =>
    mod.exports.default.setup(props, {
      expose() {},
      emit: (_, value) => {
        events.push(value);
        props.modelValue = value;
      },
    }),
  );
  return {
    api,
    props,
    events,
    timeouts,
    intervals,
    listeners,
    delay: () => {
      const pending = [...timeouts.values()];
      timeouts.clear();
      pending.forEach((fn) => fn());
    },
    repeat: () => [...intervals.values()].forEach((fn) => fn()),
    deactivate: () => hooks.deactivate.forEach((fn) => fn()),
    activate: () => hooks.activate.forEach((fn) => fn()),
    dispatch: (type) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    dispose: () => {
      hooks.unmount.forEach((fn) => fn());
      scope.stop();
    },
  };
}

test('normal press repeats and release stops it', () => {
  const s = fixture();
  s.api.startPress(s.api.increment);
  assert.equal(s.props.modelValue, '6');
  s.delay();
  s.repeat();
  assert.equal(s.props.modelValue, '7');
  s.api.stopPress();
  s.repeat();
  assert.equal(s.props.modelValue, '7');
  assert.equal(s.intervals.size + s.timeouts.size, 0);
  s.dispose();
});

for (const repeating of [false, true]) {
  test(`cache entry cancels ${repeating ? 'active repetition' : 'pending delay'} and return does not resume`, () => {
    const s = fixture();
    s.api.startPress(s.api.increment);
    if (repeating) s.delay();
    s.deactivate();
    s.delay();
    s.repeat();
    assert.equal(s.props.modelValue, '6');
    assert.equal(s.intervals.size + s.timeouts.size, 0);
    s.api.increment();
    assert.equal(s.props.modelValue, '6');
    s.activate();
    s.repeat();
    assert.equal(s.props.modelValue, '6');
    s.api.startPress(s.api.decrement);
    assert.equal(s.props.modelValue, '5');
    s.dispose();
  });
}

test('disabling stops the hold and reenabling cannot resume it', () => {
  const s = fixture();
  s.api.startPress(s.api.increment);
  s.delay();
  s.props.disabled = true;
  assert.equal(s.intervals.size + s.timeouts.size, 0);
  s.props.disabled = false;
  s.repeat();
  assert.equal(s.props.modelValue, '6');
  s.dispose();
});

for (const event of ['mouseup', 'blur']) {
  test(`window ${event} stops repeating and removes temporary listeners`, () => {
    const s = fixture();
    s.api.startPress(s.api.increment);
    s.delay();
    s.dispatch(event);
    s.repeat();
    assert.equal(s.props.modelValue, '6');
    assert.ok([...s.listeners.values()].every((set) => set.size === 0));
    s.dispose();
  });
}

test('a second press replaces pending work and stale callbacks cannot restart it', () => {
  const s = fixture();
  s.api.startPress(s.api.increment);
  const stale = [...s.timeouts.values()][0];
  s.api.startPress(s.api.decrement);
  assert.equal(s.timeouts.size, 1);
  stale();
  assert.equal(s.intervals.size, 0);
  s.delay();
  s.repeat();
  assert.equal(s.props.modelValue, '4');
  s.dispose();
  stale();
  assert.equal(s.intervals.size + s.timeouts.size, 0);
});

test('blur after stepping cannot overwrite the stepped value with the old draft', () => {
  const s = fixture();
  s.api.handleFocus();
  s.api.increment();
  s.api.handleBlur();
  assert.deepEqual(s.events, ['6']);
  s.api.handleFocus();
  s.api.handleInput({ target: { value: '19' } });
  s.api.handleBlur();
  assert.equal(s.props.modelValue, '19');
  s.dispose();
});

test('disabling or caching discards the draft before a late blur', () => {
  for (const stop of ['disable', 'cache']) {
    const s = fixture();
    s.api.handleFocus();
    s.api.handleInput({ target: { value: '19' } });
    if (stop === 'disable') s.props.disabled = true;
    else s.deactivate();
    s.api.handleBlur();
    assert.deepEqual(s.events, []);
    s.dispose();
  }
});

test('reaching a bound ends the hold even when the native button becomes disabled', () => {
  const s = fixture();
  s.props.modelValue = '99';
  s.api.startPress(s.api.increment);
  assert.equal(s.props.modelValue, '100');
  assert.equal(s.intervals.size + s.timeouts.size, 0);
  assert.ok([...s.listeners.values()].every((set) => set.size === 0));
  s.props.modelValue = '98';
  s.delay();
  s.repeat();
  assert.equal(s.props.modelValue, '98');
  s.dispose();
});

test('decimal steps remain stable in both directions and preserve finer input precision', () => {
  const s = fixture();
  Object.assign(s.props, { modelValue: '0.2', step: 0.1, min: -20, max: 20 });
  s.api.increment();
  assert.equal(s.props.modelValue, '0.3');
  for (let i = 0; i < 7; i++) s.api.increment();
  assert.equal(s.props.modelValue, '1');
  s.api.decrement();
  assert.equal(s.props.modelValue, '0.9');
  s.props.modelValue = '0.25';
  s.api.increment();
  assert.equal(s.props.modelValue, '0.35');
  s.props.modelValue = '-0.2';
  s.api.decrement();
  assert.equal(s.props.modelValue, '-0.3');
  s.dispose();
});

test('scientific-notation step works without rounding small values to zero', () => {
  const s = fixture();
  Object.assign(s.props, { modelValue: '0.0000002', step: 1e-7 });
  s.api.increment();
  assert.equal(Number(s.props.modelValue), 3e-7);
  Object.assign(s.props, { modelValue: '2e-120', step: 1e-120 });
  s.api.increment();
  assert.equal(Number(s.props.modelValue), 3e-120);
  s.dispose();
});

test('missing and nonfinite values never turn unlimited bounds into emitted Infinity', () => {
  const s = fixture();
  Object.assign(s.props, { min: -Infinity, max: Infinity });
  for (const value of [undefined, 'invalid', Infinity, -Infinity]) {
    s.props.modelValue = value;
    s.api.increment();
    assert.equal(s.props.modelValue, '1');
    s.props.modelValue = value;
    s.api.decrement();
    assert.equal(s.props.modelValue, '-1');
  }
  s.dispose();
});

test('overflowing draft and invalid steps cannot emit a nonfinite value', () => {
  const s = fixture();
  Object.assign(s.props, { min: -Infinity, max: Infinity });
  s.api.handleFocus();
  s.api.handleInput({ target: { value: '9'.repeat(400) } });
  s.api.handleBlur();
  assert.deepEqual(s.events, []);
  for (const step of [NaN, Infinity, -1, 0]) {
    s.props.step = step;
    s.api.increment();
    s.api.decrement();
  }
  assert.deepEqual(s.events, []);
  s.dispose();
});

test('Enter commits synchronously before the parent handles its submit shortcut', () => {
  const s = fixture();
  s.api.handleFocus();
  s.api.handleInput({ target: { value: '19' } });
  s.api.handleKeydown({
    key: 'Enter',
    preventDefault() {
      throw new Error('parent submit must remain available');
    },
  });
  assert.equal(s.props.modelValue, '19');
  s.api.handleBlur();
  assert.deepEqual(s.events, ['19']);
  s.dispose();
});

test('IME composition Enter does not submit an unfinished draft', () => {
  const s = fixture();
  s.api.handleFocus();
  s.api.handleInput({ target: { value: '19' } });
  s.api.handleKeydown({ key: 'Enter', isComposing: true });
  assert.deepEqual(s.events, []);
  s.dispose();
});

test('range clamping and empty-input restoration retain their behavior', () => {
  const s = fixture();
  s.props.modelValue = '99';
  s.props.step = 3;
  s.api.increment();
  assert.equal(s.props.modelValue, '100');
  s.props.modelValue = '1';
  s.api.decrement();
  assert.equal(s.props.modelValue, '0');
  s.api.handleFocus();
  s.api.handleInput({ target: { value: '' } });
  s.api.handleBlur();
  assert.equal(s.props.modelValue, '0');
  s.dispose();
});
