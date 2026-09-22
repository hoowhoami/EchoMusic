import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const require = createRequire(import.meta.url);
const { computed, createRenderer, h, KeepAlive, nextTick, watch } = require('vue');
const { createRouter, createMemoryHistory, RouterView } = require('vue-router');
const load = (path) => {
  const source = buildSync({
    entryPoints: [new URL(path, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['vue', 'vue-router'],
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, mod, mod.exports);
  return mod.exports;
};
const { useRouteTabs } = load('../src/renderer/composables/useRouteTabs.ts');
// Navigation scenarios; pages own their allowed values rather than importing this fixture.
const ROUTE_TABS = Object.fromEntries(
  [
    ['search', ['song', 'special', 'album', 'author', 'lyric', 'mv']],
    ['explore', ['playlists', 'ranks', 'albums', 'songs', 'artists']],
    ['favorites', ['songs', 'singers', 'users', 'albums', 'videos']],
    ['purchased', ['songs', 'albums']],
    ['history', ['songs', 'stats']],
    ['artist-detail', ['songs', 'albums', 'mvs']],
    ['playlist-detail', ['songs', 'comments']],
    ['album-detail', ['songs', 'comments']],
    ['song-detail', ['detail', 'comment'], 'tab', 'mainTab'],
    ['song-comments', ['all', 'classify', 'hotword'], 'commentTab'],
    ['plugin-management', ['installed', 'marketplace'], 'view'],
  ].map(([id, values, key = 'tab', alias]) => [
    id,
    {
      routeName: id === 'song-comments' ? 'song-detail' : id,
      key,
      values,
      alias,
    },
  ]),
);
const { getRouteViewCacheQuery } = load('../src/renderer/utils/routeViewCache.ts');
const node = (type) => ({ type, children: [], parent: null });
const detach = (child) => {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
};
const renderer = createRenderer({
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  patchProp() {},
  insert(child, parent, anchor = null) {
    detach(child);
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
  },
  remove(child) {
    detach(child);
    child.parent = null;
  },
  parentNode: (child) => child.parent,
  nextSibling: (child) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
});
const flush = async () => {
  await nextTick();
  await nextTick();
};
const travel = (router, offset) =>
  new Promise((resolve) => {
    const off = router.afterEach(() => {
      off();
      resolve();
    });
    router.go(offset);
  });
const setup = async (id, { keepAlive = false, query = {}, extra = [] } = {}) => {
  const definition = ROUTE_TABS[id];
  const definitions = [id, ...extra].map((key) => [key, ROUTE_TABS[key]]);
  const instances = [];
  const changes = [];
  const component = {
    setup() {
      const page = useRouteTabs(
        Object.fromEntries(definitions.map(([, def]) => [def.key, def.values])),
        Object.fromEntries(
          definitions.filter(([, def]) => def.alias).map(([, def]) => [def.key, def.alias]),
        ),
      );
      const tabs = Object.fromEntries(
        definitions.map(([id, def]) => [
          id,
          {
            tab: page.state[def.key],
            index: computed(() => def.values.indexOf(page.state[def.key].value)),
            select: (value) => page.select({ [def.key]: value }),
            isActive: page.isActive,
          },
        ]),
      );
      tabs.select = page.select;
      instances.push(tabs);
      watch(tabs[id].tab, (value) => changes.push(value));
      return () => h('div');
    },
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { name: 'home', path: '/', component: { render: () => h('div') } },
      {
        name: definition.routeName,
        path: '/page/:id',
        component,
        meta: {
          tabQueryKeys: definitions.flatMap(([, def]) => [
            def.key,
            ...(def.alias ? [def.alias] : []),
          ]),
        },
      },
      { name: 'away', path: '/away', component: { render: () => h('div') } },
    ],
  });
  await router.push('/');
  await router.push({ name: definition.routeName, params: { id: 'a' }, query });
  const key = () =>
    router.resolve({
      path: router.currentRoute.value.path,
      query: getRouteViewCacheQuery(router.currentRoute.value),
      hash: router.currentRoute.value.hash,
    }).fullPath;
  const app = renderer.createApp({
    render: () =>
      h(
        RouterView,
        {},
        {
          default: ({ Component }) => {
            const page = Component ? h(Component, { key: key() }) : null;
            return keepAlive ? h(KeepAlive, { max: 5 }, () => page) : page;
          },
        },
      ),
  });
  app.use(router);
  app.mount(node('root'));
  await flush();
  return { router, instances, changes, app, key, current: () => instances.at(-1)[id] };
};

for (const [id, definition] of Object.entries(ROUTE_TABS)) {
  test(`${id}: every tab survives unmount, back and forward, without adding history or recreating on switch`, async () => {
    const s = await setup(id, { query: { marker: 'keep', _t: '123' } });
    try {
      const initialKey = s.key();
      for (const value of definition.values) {
        const initial = s.current();
        const count = s.instances.length;
        await initial.select(value);
        await flush();
        assert.equal(initial.tab.value, value);
        assert.equal(s.key(), initialKey);
        assert.equal(s.instances.length, count);
        assert.equal(s.router.currentRoute.value.query.marker, 'keep');
        assert.equal(s.router.currentRoute.value.query._t, '123');
        await s.router.push('/away');
        await travel(s.router, -1);
        await flush();
        assert.equal(s.current().tab.value, value);
      }
      const current = s.current();
      for (const value of definition.values) await current.select(value);
      await flush();
      await travel(s.router, -1);
      assert.equal(s.router.currentRoute.value.name, 'home');
      await travel(s.router, 1);
      await flush();
      assert.equal(s.current().tab.value, definition.values.at(-1));
    } finally {
      s.app.unmount();
    }
  });
  for (const value of definition.values) {
    test(`${id}: direct route ${value} initializes the matching value and index`, async () => {
      const s = await setup(id, { query: { [definition.key]: value } });
      try {
        assert.equal(s.current().tab.value, value);
        assert.equal(s.current().index.value, definition.values.indexOf(value));
      } finally {
        s.app.unmount();
      }
    });
  }
}

test('cached pages freeze their state and cannot overwrite another resource history', async () => {
  const s = await setup('artist-detail', { keepAlive: true });
  try {
    const a = s.current();
    await a.select('mvs');
    await s.router.push({ name: 'artist-detail', params: { id: 'b' }, query: { tab: 'albums' } });
    await flush();
    const b = s.current();
    assert.notEqual(a, b);
    assert.equal(a.tab.value, 'mvs');
    assert.equal(b.tab.value, 'albums');
    assert.equal(a.isActive.value, false);
    const before = s.router.currentRoute.value.fullPath;
    await a.select('songs');
    assert.equal(s.router.currentRoute.value.fullPath, before);
    await travel(s.router, -1);
    await flush();
    assert.equal(a.isActive.value, true);
    assert.equal(a.tab.value, 'mvs');
    assert.equal(b.tab.value, 'albums');
    assert.deepEqual(s.changes, ['mvs']);
  } finally {
    s.app.unmount();
  }
});

test('one explicit update changes main and child tabs atomically and normalizes aliases', async () => {
  const s = await setup('song-detail', { query: { mainTab: 'comment' }, extra: ['song-comments'] });
  try {
    const tabs = s.instances[0];
    assert.equal(tabs['song-detail'].tab.value, 'comment');
    await tabs.select({ tab: 'detail', commentTab: 'hotword' });
    await flush();
    assert.deepEqual(s.router.currentRoute.value.query, { tab: 'detail', commentTab: 'hotword' });
    assert.equal(tabs['song-comments'].tab.value, 'hotword');
    await s.router.push('/away');
    await travel(s.router, -1);
    await flush();
    assert.equal(s.instances.at(-1)['song-comments'].tab.value, 'hotword');
  } finally {
    s.app.unmount();
  }
});

test('invalid or repeated route values fall back; invalid writes leave the route unchanged', async () => {
  for (const [id, def] of Object.entries(ROUTE_TABS)) {
    for (const value of ['invalid', [def.values.at(-1), def.values[0]], null]) {
      const invalid = await setup(id, { query: { [def.key]: value } });
      try {
        assert.equal(invalid.current().tab.value, def.values[0]);
      } finally {
        invalid.app.unmount();
      }
    }
  }
  const s = await setup('favorites');
  try {
    const before = s.router.currentRoute.value.fullPath;
    await s.current().select('invalid');
    assert.equal(s.router.currentRoute.value.fullPath, before);
    s.current().tab.value = 'videos';
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.current().tab.value, 'videos');
  } finally {
    s.app.unmount();
  }
});

test('a fast switch back to the current tab cancels the pending selection', async () => {
  const s = await setup('favorites', { query: { tab: 'songs' } });
  try {
    await Promise.all([s.current().select('albums'), s.current().select('songs')]);
    await flush();
    assert.equal(s.current().tab.value, 'songs');
    assert.equal(s.router.currentRoute.value.query.tab, 'songs');
  } finally {
    s.app.unmount();
  }
});

test('aborted navigation does not commit tab state or leak the pending query', async () => {
  const s = await setup('favorites');
  try {
    const remove = s.router.beforeEach((to) => (to.query.tab === 'albums' ? false : undefined));
    await s.current().select('albums');
    assert.equal(s.current().tab.value, 'songs');
    remove();
    await s.current().select('videos');
    assert.equal(s.current().tab.value, 'videos');
    assert.deepEqual(s.router.currentRoute.value.query, { tab: 'videos' });
  } finally {
    s.app.unmount();
  }
});
