import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
const require = createRequire(import.meta.url);
const { parse, compileScript } = require('vue/compiler-sfc');
const root = new URL('../../', import.meta.url);
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const flush = async () => {
  await vue.nextTick();
  await new Promise((r) => setImmediate(r));
};
export const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('comment operation did not settle')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const load = (path, deps = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, root), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};
const relations = load('src/renderer/utils/commentRelations.ts');
const session = load('src/renderer/utils/userSession.ts');
const limits = load('src/renderer/utils/commentLimits.ts');
const keyboard = load('src/renderer/utils/composerKeyboard.ts');
const object = load('src/shared/object.ts');
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
    if (node.parent) node.parent.children = node.parent.children.filter((n) => n !== node);
  },
  parentNode: (node) => node.parent,
  nextSibling: () => null,
});
export const row = (id, extra = {}) => ({
  id: String(id),
  content: `comment ${id}`,
  userId: '7',
  specialId: 'pool',
  ...extra,
});
export const page = (list, total = list.length) => ({
  status: 1,
  data: { list, comments_num: total },
});
const originalWindow = globalThis.window;
const windows = [];
export function fixture(t, kind, initialProps = {}, options = {}) {
  const user =
    options.user ??
    vue.reactive({ isLoggedIn: true, accountRevision: 0, info: { userid: 7, token: 'one' } });
  const props = vue.reactive(initialProps),
    calls = [],
    notices = [],
    emitted = [],
    timers = new Map();
  const api = {
    sendComment: async (...args) => {
      calls.push(['send', ...args]);
    },
    sendFloorComment: async (...args) => {
      calls.push(['reply', ...args]);
    },
    deleteComment: async (...args) => {
      calls.push(['delete', ...args]);
    },
    getFloorComments: async (...args) => {
      calls.push(['floor', ...args]);
      return page([]);
    },
  };
  let vip = async (rows) => rows;
  let serial = 0;
  const windowMock = {
    setTimeout: (fn, delay) => {
      timers.set(++serial, { fn, delay });
      return serial;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  windows.push(windowMock);
  globalThis.window = windowMock;
  const deps = {
    vue,
    '@/api/comment': api,
    '@/utils/userSession': session,
    '@/utils/commentLimits': limits,
    '@/utils/composerKeyboard': keyboard,

    '@/utils/commentRelations': relations,
    '@/utils/mappers': { mapCommentItem: (value) => value },
    '@/utils/commentVipCache': { enrichCommentsWithYoungVip: (rows) => vip(rows) },
    '@/stores/user': { useUserStore: () => user },
    '@/stores/toast': {
      useToastStore: () =>
        Object.fromEntries(
          ['show', 'loadFailed', 'actionCompleted', 'warning'].map((name) => [
            name,
            (...args) => notices.push([name, ...args]),
          ]),
        ),
    },
    '@/stores/setting': {
      useSettingStore: () => ({ lyricBarrageConfig: {}, mvBarrageConfig: {} }),
    },
    '@/utils/kugouVerification': { kugouVerificationState: vue.reactive({ open: false }) },
    '@/icons': {},
    '../../../shared/object': object,
  };
  deps['@/composables/useCommentSubmission'] = load(
    'src/renderer/composables/useCommentSubmission.ts',
    deps,
  );
  const sourceUrl = options.sourceUrl ?? new URL(`src/renderer/components/music/${kind}.vue`, root);
  const { descriptor } = parse(readFileSync(sourceUrl, 'utf8'));
  const code = transformSync(compileScript(descriptor, { id: kind }).content, {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name.endsWith('.vue')) return {};
      assert.ok(name in deps, name);
      return deps[name];
    },
    module,
    module.exports,
  );
  let view;
  const Component = {
    ...module.exports.default,
    setup(p, ctx) {
      view = module.exports.default.setup(p, ctx);
      return () => null;
    },
  };
  const listeners = Object.fromEntries(
    ['sent', 'deleted', 'close', 'update:open'].map((name) => [
      `on${name[0].toUpperCase()}${name.slice(1)}`,
      (...args) => emitted.push([name, ...args]),
    ]),
  );
  const app = renderer.createApp({
    setup: () => () => vue.h(Component, { ...props, ...listeners }),
  });
  app.mount({ children: [] });
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      app.unmount();
    }
  };
  t.after(() => {
    stop();
    windows.splice(windows.indexOf(windowMock), 1);
    globalThis.window = windows.at(-1) ?? originalWindow;
  });
  return {
    view,
    props,
    user,
    api,
    calls,
    notices,
    emitted,
    timers,
    stop,
    verification: deps['@/utils/kugouVerification'].kugouVerificationState,
    setVip: (fn) => {
      vip = fn;
    },
    runTimers: () => {
      for (const [id, task] of [...timers]) {
        timers.delete(id);
        task.fn();
      }
    },
  };
}
