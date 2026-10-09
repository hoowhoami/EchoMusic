import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const cacheModule = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/components/app/RouteKeepAlive.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    define: { 'import.meta.env.DEV': 'true' },
    write: false,
  }).outputFiles[0].text,
)(require, cacheModule, cacheModule.exports);
const RouteKeepAlive = cacheModule.exports.default;
const mod = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  buildSync({
    entryPoints: ['src/renderer/utils/routeViewCache.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
  }).outputFiles[0].text,
)(require, mod, mod.exports);
const layout = readFileSync('src/renderer/layouts/MainLayout.vue', 'utf8');
const cacheSetup = transformSync(
  layout.slice(layout.indexOf('const keepAliveRef'), layout.indexOf('const pageTransitionAppear')),
  { loader: 'ts' },
).code;

// Use the real Vue renderer and cache component. The host preserves DOM sibling
// semantics, including throwing if Fragment removal walks beyond its anchor.
function fixture(max = 3) {
  const node = (type, text = '') => ({ type, text, parent: null, children: [] });
  const container = node('root'),
    target = node('teleport-target');
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('text', text),
    createComment: (text) => node('comment', text),
    setText: (n, text) => {
      n.text = text;
    },
    setElementText: (n, text) => {
      n.text = text;
    },
    patchProp() {},
    parentNode: (n) => n.parent,
    nextSibling: (n) => {
      if (!n) throw new TypeError("Cannot read properties of null (reading 'nextSibling')");
      const children = n.parent?.children;
      return children?.[children.indexOf(n) + 1] ?? null;
    },
    insert(n, parent, anchor = null) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, n);
      n.parent = parent;
    },
    remove(n) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = null;
    },
    querySelector: () => target,
  });
  const routeState = vue.shallowRef({ path: '/a', query: {}, hash: '', meta: {} });
  const route = Object.fromEntries(Object.keys(routeState.value).map((key) => [key, undefined]));
  for (const key of Object.keys(route)) {
    Object.defineProperty(route, key, { get: () => routeState.value[key] });
  }
  const router = { resolve: ({ path }) => ({ fullPath: path }) };
  const enabled = vue.ref(true),
    cacheMax = vue.ref(max),
    label = vue.ref(),
    slotText = vue.ref(),
    include = vue.ref(),
    exclude = vue.ref(),
    errors = [],
    mounts = [],
    unmounts = [],
    activated = [],
    deactivated = [];
  const Page = vue.defineComponent({
    name: 'refresh-fixture-page',
    props: { label: String },
    setup(props, { slots }) {
      const key = vue.getCurrentInstance().vnode.key;
      mounts.push(key);
      vue.onActivated(() => activated.push(key));
      vue.onDeactivated(() => deactivated.push(key));
      return () =>
        vue.h(vue.Fragment, [
          vue.h('div', props.label ?? key),
          ...(slots.default?.() ?? []),
          vue.h(vue.Teleport, { to: target }, [
            vue.h(vue.Fragment, [vue.h('div', `dialog:${key}`)]),
          ]),
        ]);
    },
  });
  let api;
  const Root = vue.defineComponent({
    setup() {
      const bindings = {
        computed: vue.computed,
        nextTick: vue.nextTick,
        ref: vue.ref,
        watch: vue.watch,
        ...mod.exports,
        route,
        router,
      };
      api = new Function(
        ...Object.keys(bindings),
        `${cacheSetup}\nreturn { keepAliveRef, routeViewKey };`,
      )(...Object.values(bindings));
      return () => {
        const page = () =>
          vue.h(
            Page,
            {
              key: api.routeViewKey.value,
              label: label.value,
              onVnodeBeforeUnmount: (vnode) => unmounts.push(vnode.key),
            },
            { default: () => (slotText.value ? vue.h('span', slotText.value) : []) },
          );
        return enabled.value
          ? vue.h(
              RouteKeepAlive,
              {
                ref: api.keepAliveRef,
                max: cacheMax.value,
                include: include.value,
                exclude: exclude.value,
              },
              { default: page },
            )
          : page();
      };
    },
  });
  const app = renderer.createApp(Root);
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(container);
  return {
    api,
    errors,
    mounts,
    unmounts,
    enabled,
    cacheMax,
    label,
    slotText,
    include,
    exclude,
    activated,
    deactivated,
    renderer,
    node,
    target,
    navigate(path, token = '') {
      routeState.value = { path, query: token ? { _t: token } : {}, hash: '', meta: {} };
    },
    refresh(token) {
      this.navigate(routeState.value.path, token);
    },
    visibleKeys: () => container.children.filter((n) => n.type === 'div').map((n) => n.text),
    visibleSlots: () => container.children.filter((n) => n.type === 'span').map((n) => n.text),
    cachedKeys: () => api.keepAliveRef.value?.getCachedKeys() ?? [],
    dispose: () => app.unmount(),
  };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await vue.nextTick();
};

test('refreshing a cached Fragment/Teleport page unmounts each old revision once', async () => {
  const f = fixture();
  try {
    await settle();
    for (const token of ['1', '2', '3']) {
      f.refresh(token);
      await settle();
      const key = `/a::refresh:${token}`;
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.visibleKeys(), [key]);
      assert.deepEqual(f.cachedKeys(), [key]);
    }
    assert.deepEqual(f.unmounts, ['/a', '/a::refresh:1', '/a::refresh:2']);
    f.navigate('/b');
    await settle();
    f.navigate('/a');
    await settle();
    assert.deepEqual(f.visibleKeys(), ['/a::refresh:3']);
    assert.equal(f.mounts.filter((key) => key === '/a::refresh:3').length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('clearing the displayed entry remains invalidated through a same-key rerender', async () => {
  const f = fixture();
  try {
    await settle();
    f.api.keepAliveRef.value.clearCacheByKey('/a');
    assert.deepEqual(f.visibleKeys(), ['/a']);
    f.cacheMax.value = 4;
    await settle();
    assert.deepEqual(f.cachedKeys(), []);
    f.navigate('/b');
    await settle();
    assert.deepEqual(f.unmounts, ['/a']);
    f.navigate('/a');
    await settle();
    assert.equal(f.mounts.filter((key) => key === '/a').length, 2);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('repeated invalidation followed by a same-tick refresh unmounts the old page once', async () => {
  const f = fixture();
  try {
    await settle();
    f.api.keepAliveRef.value.clearCacheByKey('/a');
    f.api.keepAliveRef.value.clearCacheByKey('/a');
    f.refresh('1');
    await settle();
    assert.deepEqual(f.unmounts, ['/a']);
    assert.deepEqual(f.cachedKeys(), ['/a::refresh:1']);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('reactivation updates props and slots while preserving the page instance', async () => {
  const f = fixture();
  try {
    await settle();
    f.navigate('/b');
    await settle();
    f.label.value = 'updated';
    f.slotText.value = 'new-slot';
    await settle();
    f.navigate('/a');
    await settle();
    assert.deepEqual(f.visibleKeys(), ['updated']);
    assert.deepEqual(f.visibleSlots(), ['new-slot']);
    assert.equal(f.mounts.filter((key) => key === '/a').length, 1);
    assert.deepEqual(f.activated, ['/a', '/b', '/a']);
    assert.deepEqual(f.deactivated, ['/a', '/b']);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('cache teardown destroys every instance of the same component with different keys', async () => {
  const f = fixture();
  await settle();
  for (const path of ['/b', '/c']) {
    f.navigate(path);
    await settle();
  }
  f.dispose();
  await settle();
  assert.deepEqual(f.unmounts.sort(), ['/a', '/b', '/c']);
  assert.deepEqual(f.errors, []);
  assert.equal(f.activated.length, 3);
});

test('clearing all pages then destroying the cache never destroys a pending page twice', async () => {
  const f = fixture();
  await settle();
  for (const path of ['/b', '/c']) {
    f.navigate(path);
    await settle();
  }
  f.api.keepAliveRef.value.clearCache();
  assert.deepEqual(f.cachedKeys(), []);
  f.dispose();
  await settle();
  assert.deepEqual(f.unmounts.sort(), ['/a', '/b', '/c']);
  assert.deepEqual(f.errors, []);
});

test('LRU eviction at max one safely invalidates the active page', async () => {
  const f = fixture(1);
  try {
    await settle();
    for (const path of ['/b', '/c', '/a']) {
      f.navigate(path);
      await settle();
      assert.deepEqual(f.cachedKeys(), [path]);
      assert.deepEqual(f.errors, []);
    }
    assert.deepEqual(f.unmounts, ['/a', '/b', '/c']);
    assert.equal(f.mounts.length, 4);
  } finally {
    f.dispose();
  }
});

test('reducing max prunes all excess inactive pages in LRU order', async () => {
  const f = fixture(3);
  try {
    await settle();
    for (const path of ['/b', '/c']) {
      f.navigate(path);
      await settle();
    }
    f.cacheMax.value = 1;
    await settle();
    assert.deepEqual(f.cachedKeys(), ['/c']);
    assert.deepEqual(f.unmounts, ['/a', '/b']);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('async pages in Suspense remain cached and can be invalidated after resolution', async () => {
  const f = fixture();
  f.dispose();
  const key = vue.ref('async-a'),
    controller = vue.ref();
  const container = f.node('async-root'),
    errors = [],
    unmounts = [];
  let resolves = 0;
  const AsyncPage = vue.defineAsyncComponent(async () => {
    resolves++;
    return vue.defineComponent({
      setup() {
        const identity = vue.getCurrentInstance().vnode.key;
        vue.onBeforeUnmount(() => unmounts.push(identity));
        return () =>
          vue.h(vue.Fragment, [
            vue.h('div', identity),
            vue.h(vue.Teleport, { to: f.target }, [vue.h('div', identity)]),
          ]);
      },
    });
  });
  const app = f.renderer.createApp({
    render: () =>
      vue.h(
        RouteKeepAlive,
        { ref: controller },
        {
          default: () =>
            vue.h(
              vue.Suspense,
              {},
              {
                default: () => vue.h(AsyncPage, { key: key.value }),
                fallback: () => vue.h('div', 'loading'),
              },
            ),
        },
      ),
  });
  app.config.errorHandler = (error) => errors.push(error);
  try {
    app.mount(container);
    // The loader and Suspense each have their own microtask continuation.
    for (let i = 0; i < 12; i++) await vue.nextTick();
    assert.equal(resolves, 1);
    assert.equal(controller.value.getCacheSize(), 1);
    controller.value.clearCache();
    key.value = 'async-b';
    for (let i = 0; i < 12; i++) await vue.nextTick();
    assert.deepEqual(unmounts, ['async-a']);
    assert.equal(controller.value.getCacheSize(), 1);
    assert.deepEqual(errors, []);
  } finally {
    app.unmount();
  }
  await settle();
  assert.deepEqual(unmounts, ['async-a', 'async-b']);
  assert.deepEqual(errors, []);
});

test('invalidating a Teleport page during a delayed leave keeps DOM removal owned by Vue', async () => {
  const f = fixture();
  f.dispose();
  const key = vue.ref('a'),
    controller = vue.ref(),
    leaves = [],
    unmounts = [],
    errors = [];
  const Page = vue.defineComponent({
    setup() {
      const identity = vue.getCurrentInstance().vnode.key;
      vue.onBeforeUnmount(() => unmounts.push(identity));
      return () =>
        vue.h('div', [
          vue.h(vue.Fragment, [vue.h('span', identity)]),
          vue.h(vue.Teleport, { to: f.target }, [vue.h(vue.Fragment, [vue.h('div', identity)])]),
        ]);
    },
  });
  const app = f.renderer.createApp({
    render: () =>
      vue.h(
        vue.BaseTransition,
        {
          onLeave: (_el, done) => leaves.push(done),
        },
        {
          default: () =>
            vue.h(
              RouteKeepAlive,
              { ref: controller },
              {
                default: () => vue.h(Page, { key: key.value }),
              },
            ),
        },
      ),
  });
  app.config.errorHandler = (error) => errors.push(error);
  try {
    app.mount(f.node('transition-root'));
    await settle();
    controller.value.clearCacheByKey('a');
    key.value = 'b';
    await settle();
    assert.equal(leaves.length, 1);
    assert.deepEqual(unmounts, ['a']);
    assert.deepEqual(errors, []);
    leaves.shift()();
    await settle();
    assert.deepEqual(errors, []);
    assert.deepEqual(controller.value.getCachedKeys(), ['b']);
  } finally {
    app.unmount();
    leaves.splice(0).forEach((done) => done());
  }
  await settle();
  assert.deepEqual(unmounts, ['a', 'b']);
  assert.deepEqual(errors, []);
});

test('changing exclude invalidates the active page without removing its DOM twice', async () => {
  const f = fixture();
  try {
    await settle();
    f.exclude.value = /refresh-fixture-page/g;
    await settle();
    assert.deepEqual(f.visibleKeys(), ['/a']);
    assert.deepEqual(f.cachedKeys(), []);
    f.navigate('/b');
    await settle();
    f.navigate('/a');
    await settle();
    assert.deepEqual(f.cachedKeys(), []);
    assert.deepEqual(f.unmounts, ['/a', '/b']);
    assert.equal(f.mounts.length, 3);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('rapid refreshes followed by navigation clear obsolete revisions and preserve the new page', async () => {
  const f = fixture();
  try {
    await settle();
    f.refresh('1');
    f.refresh('2');
    f.refresh('3');
    f.navigate('/b');
    await settle();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.visibleKeys(), ['/b']);
    assert.deepEqual(f.cachedKeys(), ['/b']);
    assert.deepEqual(f.unmounts, ['/a']);
    f.navigate('/a');
    await settle();
    assert.deepEqual(f.visibleKeys(), ['/a::refresh:3']);
    assert.deepEqual(f.errors, []);
  } finally {
    f.dispose();
  }
});

test('refresh at the cache limit prunes the old page once and retains the refreshed page', async () => {
  const f = fixture(3);
  try {
    await settle();
    for (const path of ['/b', '/c', '/a']) {
      f.navigate(path);
      await settle();
    }
    f.refresh('1');
    await settle();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.visibleKeys(), ['/a::refresh:1']);
    assert.deepEqual(f.cachedKeys(), ['/b', '/c', '/a::refresh:1']);
    assert.equal(f.unmounts.filter((key) => key === '/a').length, 1);
  } finally {
    f.dispose();
  }
});

test('disabling caching immediately after invalidation destroys the old page once', async () => {
  const f = fixture();
  try {
    await settle();
    const oldCache = f.api.keepAliveRef.value;
    let clears = 0;
    const clear = oldCache.clearCacheByKey;
    oldCache.clearCacheByKey = (key) => {
      clears++;
      clear(key);
    };
    f.refresh('1');
    f.enabled.value = false;
    await settle();
    assert.equal(clears, 1);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.visibleKeys(), ['/a::refresh:1']);
    f.refresh('2');
    await settle();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.visibleKeys(), ['/a::refresh:2']);
    f.enabled.value = true;
    await settle();
    f.refresh('3');
    await settle();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.cachedKeys(), ['/a::refresh:3']);
  } finally {
    f.dispose();
  }
});
