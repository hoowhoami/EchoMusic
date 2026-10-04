import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const reka = Object.fromEntries(
  ['AvatarRoot', 'AvatarImage', 'AvatarFallback'].map((name) => [name, { name }]),
);
const Skeleton = { name: 'Skeleton' };
const { descriptor } = parse(readFileSync('src/renderer/components/ui/Avatar.vue', 'utf8'));
const script = compileScript(descriptor, { id: 'avatar-state-test', inlineTemplate: true });
const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (id) => {
    if (id === 'vue') return { ...vue, resolveComponent: () => 'icon' };
    if (id === 'reka-ui') return reka;
    if (id === './Skeleton.vue') return { __esModule: true, default: Skeleton };
    if (id === '@/icons') return { iconUser: 'user' };
    throw new Error(`Unexpected dependency ${id}`);
  },
  module,
  module.exports,
);
function fixture(t, overrides = {}) {
  const props = vue.reactive({
    src: '',
    alt: 'avatar',
    class: '',
    skeletonClass: '',
    errorClass: '',
    showSkeleton: true,
    delayMs: 0,
    ...overrides,
  });
  const scope = vue.effectScope();
  const render = scope.run(() => module.exports.default.setup(props, { expose() {} }));
  t.after(() => scope.stop());
  const nodes = () => {
    const result = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      result.push(node);
      if (Array.isArray(node.children)) visit(node.children);
      else if (node.children?.default) visit(node.children.default());
    }
    visit(render({}, []));
    return result;
  };
  const find = (type) => nodes().find((node) => node.type === type);
  return {
    props,
    find,
    hasSkeleton: () => Boolean(find(Skeleton)),
    status: (status) => find(reka.AvatarImage).props.onLoadingStatusChange(status),
  };
}

test('empty avatar renders a static fallback without an image request or skeleton', (t) => {
  const f = fixture(t);
  assert.equal(f.find(reka.AvatarImage), undefined);
  assert.ok(f.find(reka.AvatarFallback));
  assert.equal(f.hasSkeleton(), false);
});

test('avatar skeleton only exists while a nonempty resource is loading', (t) => {
  const f = fixture(t, { src: 'first.png' });
  assert.equal(f.hasSkeleton(), true);
  f.status('idle');
  assert.equal(f.hasSkeleton(), true);
  f.status('loading');
  assert.equal(f.hasSkeleton(), true);
  f.status('error');
  assert.equal(f.hasSkeleton(), false);
  f.props.src = 'second.png';
  assert.equal(f.hasSkeleton(), true);
  f.status('loaded');
  assert.equal(f.hasSkeleton(), false);
});

test('clearing a loaded image gives the fallback a fresh Reka loading context', (t) => {
  const f = fixture(t, { src: 'loaded.png' });
  f.status('loaded');
  const loadedContextKey = f.find(reka.AvatarRoot).key;
  f.props.src = '';
  assert.notEqual(f.find(reka.AvatarRoot).key, loadedContextKey);
  assert.equal(f.find(reka.AvatarImage), undefined);
  assert.ok(f.find(reka.AvatarFallback));
  assert.equal(f.hasSkeleton(), false);
  f.props.src = 'loaded.png';
  assert.equal(f.hasSkeleton(), true);
});

test('disabling skeleton preserves the fallback and ignores loading animation state', (t) => {
  const f = fixture(t, { src: 'pending.png', showSkeleton: false });
  assert.equal(f.hasSkeleton(), false);
  f.status('error');
  assert.equal(f.hasSkeleton(), false);
  assert.ok(f.find(reka.AvatarFallback));
});

test('resource changes preserve avatar size, alt and configured fallback delay', (t) => {
  const f = fixture(t, { src: 'first.png', size: 48, delayMs: 120 });
  for (const src of ['first.png', 'second.png', '']) {
    f.props.src = src;
    assert.deepEqual(f.find(reka.AvatarRoot).props.style, { width: '48px', height: '48px' });
    assert.equal(f.find(reka.AvatarFallback).props['delay-ms'], 120);
    if (src) assert.equal(f.find(reka.AvatarImage).props.alt, 'avatar');
  }
});
