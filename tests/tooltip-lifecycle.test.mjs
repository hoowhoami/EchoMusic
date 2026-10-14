import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const ownership = { exports: {} };
new Function(
  'module',
  'exports',
  transformSync(readFileSync('src/renderer/components/ui/tooltipOwnership.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
)(ownership, ownership.exports);

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mounts = [];
  const observers = new Set();
  let doc;
  class Element extends EventTarget {
    parentElement = null;
    children = [];
    attributes = new Map();
    dataset = {};
    scrollWidth = 100;
    clientWidth = 100;
    scrollHeight = 20;
    clientHeight = 20;
    ownerDocument;
    constructor() {
      super();
      this.ownerDocument = doc;
    }
    get isConnected() {
      return this === doc.documentElement || Boolean(this.parentElement?.isConnected);
    }
    appendChild(el) {
      el.parentElement = this;
      this.children.push(el);
    }
    remove() {
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    setAttribute(k, v) {
      this.attributes.set(k, v);
    }
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    contains(el) {
      return el === this || this.children.some((child) => child.contains(el));
    }
    querySelectorAll() {
      return [];
    }
    closest() {
      let el = this;
      while (el) {
        if (
          ['hidden', 'inert'].some((k) => el.attributes.has(k)) ||
          el.getAttribute('aria-hidden') === 'true' ||
          el.getAttribute('aria-expanded') === 'true'
        )
          return el;
        el = el.parentElement;
      }
      return null;
    }
  }
  doc = Object.assign(new EventTarget(), {
    createElement: () => new Element(),
    hidden: false,
    defaultView: Object.assign(new EventTarget(), {
      Element,
      Node: Element,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    }),
  });
  doc.documentElement = new Element();
  doc.body = new Element();
  doc.documentElement.appendChild(doc.body);
  const mod = { exports: {} };
  const code = transformSync(readFileSync('src/renderer/components/ui/tooltipRuntime.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', 'MutationObserver', code)(
    (id) =>
      id === './tooltipOwnership'
        ? ownership.exports
        : id === 'vue'
          ? {
              createVNode: (type, props) => ({ type, props }),
              render: (vnode) => {
                if (vnode) mounts.push(vnode.props);
              },
            }
          : { default: {} },
    mod,
    mod.exports,
    class {
      constructor(callback) {
        this.callback = callback;
        observers.add(this);
      }
      observe() {}
      disconnect() {
        observers.delete(this);
      }
    },
  );
  const runtime = mod.exports.createTooltipRuntime(doc);
  const element = () => {
    const el = new Element();
    doc.body.appendChild(el);
    return el;
  };
  const bindings = [];
  const bind = (el, value) => {
    const binding = runtime.bind(el, value);
    bindings.push(binding);
    return binding;
  };
  const dispatch = (type, target, extra = {}) => {
    const event = new Event(type);
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({ target, pointerType: 'mouse', ...extra }).map(([key, value]) => [
          key,
          { value },
        ]),
      ),
    );
    doc.dispatchEvent(event);
  };
  t.after(() => bindings.forEach((binding) => binding.dispose()));
  return {
    doc,
    element,
    bind,
    mounts,
    dispatch,
    mutate: () => [...observers].forEach((o) => o.callback()),
    tick: (ms = 351) => t.mock.timers.tick(ms),
  };
}

test('many idle bindings create no hosts; only one tooltip opens and aria descriptions are preserved', (t) => {
  const s = fixture(t),
    a = s.element(),
    b = s.element();
  a.setAttribute('aria-describedby', 'existing');
  s.bind(a, '播放');
  s.bind(b, '暂停');
  for (let i = 0; i < 1000; i++) s.bind(s.element(), '项目 ' + i);
  assert.equal(s.mounts.length, 0);
  const originalChildren = s.doc.body.children.length;
  s.dispatch('pointerover', a);
  s.tick(349);
  assert.equal(s.mounts.length, 0);
  s.tick(2);
  assert.equal(s.mounts.length, 1);
  assert.equal(s.doc.body.children.length, originalChildren + 1);
  assert.match(a.getAttribute('aria-describedby'), /^existing echo-tooltip-/);
  s.dispatch('pointerover', b);
  s.tick(1);
  assert.equal(s.doc.body.children.length, originalChildren + 1);
  assert.equal(a.getAttribute('aria-describedby'), 'existing');
  s.dispatch('keydown', b, { key: 'Escape' });
  assert.equal(s.doc.body.children.length, originalChildren);
  assert.equal(b.getAttribute('aria-describedby'), null);
});

test('overflow-only, disabled and expanded controls do not open; clipping is measured when hovered', (t) => {
  const s = fixture(t),
    el = s.element(),
    binding = s.bind(el, { content: '完整文本', overflowOnly: true });
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.length, 0);
  el.scrollWidth = 200;
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.length, 1);
  binding.update({ content: '完整文本', disabled: true });
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(
    s.doc.body.children.some((x) => x.dataset.tooltipHost !== undefined),
    false,
  );
  binding.update('完整文本');
  el.setAttribute('aria-expanded', 'true');
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.length, 1);
});

test('deactivation cancels pending open without replacing the original trigger, and fresh activation works', (t) => {
  const s = fixture(t),
    el = s.element(),
    binding = s.bind(el, '提示');
  s.dispatch('pointerover', el);
  binding.suspend(true);
  binding.suspend(false);
  s.tick();
  assert.equal(s.mounts.length, 0);
  assert.equal(el.isConnected, true);
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.length, 1);
  binding.suspend(true);
  assert.equal(el.getAttribute('aria-describedby'), null);
});

test('removal, hidden ancestors and disposal cancel delayed work', (t) => {
  const s = fixture(t),
    el = s.element(),
    binding = s.bind(el, '提示');
  s.dispatch('pointerover', el);
  el.remove();
  s.mutate();
  s.tick();
  assert.equal(s.mounts.length, 0);
  s.doc.body.appendChild(el);
  s.dispatch('pointerover', el);
  el.setAttribute('hidden', '');
  s.mutate();
  s.tick();
  assert.equal(s.mounts.length, 0);
  el.removeAttribute('hidden');
  s.dispatch('pointerover', el);
  binding.dispose();
  s.tick();
  assert.equal(s.mounts.length, 0);
});

test('keyboard focus opens immediately, pointer focus stays quiet and Escape/scroll/window blur dismiss', (t) => {
  const s = fixture(t),
    el = s.element();
  s.bind(el, '操作说明');
  s.dispatch('focusin', el);
  s.tick();
  assert.equal(s.mounts.length, 0);
  s.dispatch('keydown', el, { key: 'Tab' });
  s.dispatch('focusin', el);
  s.tick(1);
  assert.equal(s.mounts.length, 1);
  s.dispatch('scroll', s.doc.body);
  assert.equal(el.getAttribute('aria-describedby'), null);
  s.dispatch('focusin', el);
  s.tick(1);
  s.doc.defaultView.dispatchEvent(new Event('blur'));
  assert.equal(el.getAttribute('aria-describedby'), null);
});

test('switching nested targets does not leave an ancestor hint open or dismiss on unrelated movement', (t) => {
  const s = fixture(t),
    parent = s.element(),
    child = s.element(),
    other = s.element();
  child.remove();
  parent.appendChild(child);
  s.bind(parent, '容器说明');
  s.bind(child, '具体操作');
  s.dispatch('pointerover', child);
  s.tick();
  assert.equal(s.mounts.at(-1).entry.element, child);
  s.dispatch('pointerout', other, { relatedTarget: parent });
  assert.ok(child.getAttribute('aria-describedby'));
});

test('equivalent inline options do not dismiss a tooltip on every parent render', (t) => {
  const s = fixture(t),
    el = s.element();
  const binding = s.bind(el, { content: '保持显示', overflowOnly: false });
  s.dispatch('pointerover', el);
  s.tick();
  const id = el.getAttribute('aria-describedby');
  binding.update({ content: '保持显示', overflowOnly: false });
  assert.equal(el.getAttribute('aria-describedby'), id);
  binding.update({ content: '新提示' });
  assert.equal(el.getAttribute('aria-describedby'), null);
});

test('portalled tooltip ownership follows its trigger and is released on close', () => {
  const trigger = {},
    other = {},
    surface = {},
    child = { parentNode: surface };
  const release = ownership.exports.setTooltipOwner(surface, trigger);
  assert.equal(
    ownership.exports.isOwnedTooltipTarget(child, (node) => node === trigger),
    true,
  );
  assert.equal(
    ownership.exports.isOwnedTooltipTarget(child, (node) => node === other),
    false,
  );
  release();
  assert.equal(
    ownership.exports.isOwnedTooltipTarget(child, (node) => node === trigger),
    false,
  );
});

test('two APIs targeting the same control share one hint and restore the surviving binding', (t) => {
  const s = fixture(t),
    el = s.element();
  s.bind(el, '控件说明');
  const wrapper = s.bind(el, '外层说明');
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.at(-1).entry.options.content, '外层说明');
  wrapper.dispose();
  s.dispatch('pointerover', el);
  s.tick();
  assert.equal(s.mounts.at(-1).entry.options.content, '控件说明');
  assert.equal(
    s.doc.body.children.filter((node) => node.dataset.tooltipHost !== undefined).length,
    1,
  );
});
