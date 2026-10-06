import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as vue from 'vue';
import { useVModel } from '@vueuse/core';

const root = new URL('../', import.meta.url);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await vue.nextTick();
  await new Promise((resolve) => setImmediate(resolve));
};
const result = (id) => ({
  status: 1,
  data: { list: id ? [{ id, content: id }] : [], count: id ? 1 : 0 },
});
const renderer = vue.createRenderer({
  createElement: (tag) => ({ tag, children: [] }),
  createText: (text) => ({ text }),
  createComment: (text) => ({ text }),
  setText() {},
  setElementText() {},
  patchProp() {},
  insert(node, parent) {
    node.parent = parent;
    parent.children.push(node);
  },
  remove(node) {
    if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
  },
  parentNode: (node) => node.parent,
  nextSibling: () => null,
});
function load(code, deps) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    transformSync(code, { loader: 'ts', format: 'cjs' }).code,
  )(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const composableCode = readFileSync(
  new URL('src/renderer/composables/useComments.ts', root),
  'utf8',
);
const { descriptor } = parse(
  readFileSync(new URL('src/renderer/components/music/CommentDrawer.vue', root), 'utf8'),
);
const componentCode = compileScript(descriptor, { id: 'comment-drawer-regression' }).content;
function fixture(t, overrides = {}) {
  const props = vue.reactive({
    open: true,
    resourceId: 'a',
    mixSongId: 'mix-a',
    resourceType: 'music',
    mounted: true,
    ...overrides,
  });
  const calls = [],
    notices = [];
  const api = Object.fromEntries(
    [
      'getMusicComments',
      'getPlaylistComments',
      'getAlbumComments',
      'getMusicClassifyComments',
      'getMusicHotwordComments',
      'getFloorComments',
    ].map((method) => [
      method,
      (...args) => {
        const task = deferred();
        calls.push({ method, args, ...task });
        return task.promise;
      },
    ]),
  );
  const deps = {
    vue,
    '@vueuse/core': { useVModel },
    '@/icons': {},
    '@/api/comment': api,
    '@/utils/mappers': { mapCommentItem: (item) => item },
    '@/utils/commentVipCache': { enrichCommentsWithYoungVip: async (items) => items },
    '@/stores/toast': { useToastStore: () => ({ loadFailed: (type) => notices.push(type) }) },
  };
  deps['@/composables/useComments'] = load(composableCode, deps);
  const compiled = load(componentCode, deps).default;
  let view;
  const Component = {
    ...compiled,
    setup(p, context) {
      view = compiled.setup(p, context);
      return () => null;
    },
  };
  const app = renderer.createApp({
    setup: () => () =>
      props.mounted
        ? vue.h(Component, {
            ...props,
            'onUpdate:open': (value) => {
              props.open = value;
            },
          })
        : null,
  });
  app.mount({ children: [] });
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      app.unmount();
    }
  };
  t.after(stop);
  return {
    props,
    calls,
    notices,
    get view() {
      return view;
    },
    stop,
  };
}

test('lazy first mount while already open requests comments immediately and shows loading until response', async (t) => {
  const s = fixture(t, { open: false, mounted: false });
  assert.equal(s.calls.length, 0);
  s.props.open = true;
  s.props.mounted = true;
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].args[0], 'mix-a');
  assert.equal(s.view.isLoadingComments.value, true);
  s.calls[0].resolve(result('first-open'));
  await flush();
  assert.equal(s.view.comments.value[0].id, 'first-open');
  assert.equal(s.view.isLoadingComments.value, false);
});

test('closed mount stays idle; resource and open changing together request the new song exactly once', async (t) => {
  const s = fixture(t, { open: false });
  assert.equal(s.calls.length, 0);
  s.props.resourceId = 'b';
  s.props.mixSongId = 'mix-b';
  s.props.open = true;
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].args[0], 'mix-b');
  s.calls[0].resolve(result('b'));
  await flush();
  assert.equal(s.view.comments.value[0].id, 'b');
});

test('changing resources while open rejects a stale completion without clearing the new loading state', async (t) => {
  const s = fixture(t);
  assert.equal(s.calls.length, 1);
  s.props.resourceId = 'b';
  s.props.mixSongId = 'mix-b';
  await flush();
  assert.equal(s.calls.length, 2);
  s.calls[0].resolve(result('stale'));
  await flush();
  assert.equal(s.view.comments.value.length, 0);
  assert.equal(s.view.isLoadingComments.value, true);
  s.calls[1].resolve(result('b'));
  await flush();
  assert.equal(s.view.comments.value[0].id, 'b');
});

test('closing before response then reopening retries and discards the old request', async (t) => {
  const s = fixture(t);
  assert.equal(s.calls.length, 1);
  s.props.open = false;
  await flush();
  s.props.open = true;
  await flush();
  assert.equal(s.calls.length, 2);
  s.calls[0].resolve(result('stale'));
  await flush();
  assert.equal(s.view.isLoadingComments.value, true);
  assert.equal(s.view.comments.value.length, 0);
  s.calls[1].resolve(result('fresh'));
  await flush();
  assert.equal(s.view.comments.value[0].id, 'fresh');
});

test('successfully loaded comments remain cached when reopening the same resource', async (t) => {
  const s = fixture(t);
  assert.equal(s.calls.length, 1);
  s.calls[0].resolve(result('cached'));
  await flush();
  s.props.open = false;
  await flush();
  s.props.open = true;
  await flush();
  assert.equal(s.calls.length, 1);
  assert.equal(s.view.comments.value[0].id, 'cached');
});

test('empty successful results settle loading; a failed first request can retry on reopen', async (t) => {
  const s = fixture(t);
  assert.equal(s.calls.length, 1);
  s.calls[0].reject(new Error('offline'));
  await flush();
  assert.deepEqual(s.notices, ['评论']);
  assert.equal(s.view.isLoadingComments.value, false);
  s.props.open = false;
  await flush();
  s.props.open = true;
  await flush();
  assert.equal(s.calls.length, 2);
  s.calls[1].resolve(result(null));
  await flush();
  assert.equal(s.view.comments.value.length, 0);
  assert.equal(s.view.hasMore.value, false);
  assert.equal(s.view.isLoadingComments.value, false);
});

test('unmount invalidates outstanding responses', async (t) => {
  const s = fixture(t);
  assert.equal(s.calls.length, 1);
  s.stop();
  s.calls[0].resolve(result('unmounted'));
  await flush();
  assert.equal(s.view.comments.value.length, 0);
  assert.equal(s.view.isLoadingComments.value, false);
});
