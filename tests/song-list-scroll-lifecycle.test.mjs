import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const { descriptor } = parse(readFileSync('src/renderer/components/music/SongList.vue', 'utf8'));
const script = compileScript(descriptor, { id: 'song-list-scroll-test' });
const songCode = transformSync(script.content, { loader: 'ts', format: 'cjs' }).code;
const listCode = transformSync(readFileSync('src/renderer/composables/useVirtualList.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
}).code;
async function fixture() {
  const hooks = { mount: [], unmount: [], activate: [], deactivate: [] };
  const timers = new Map();
  let nextTimer = 0;
  const listeners = new Map();
  const events = (prefix) => ({
    addEventListener(type, fn) {
      const key = `${prefix}:${type}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(`${prefix}:${type}`)?.delete(fn);
    },
  });
  const player = vue.reactive({ isPlaying: false });
  const frames = new Map();
  let nextFrame = 0;
  const calls = [];
  let ownRow = null;
  let foreignRow = null;
  const scroll = {
    scrollTop: 0,
    clientHeight: 400,
    dataset: { echoStickyInset: '48' },
    style: { overflow: 'auto' },
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => foreignRow,
    scrollTo(options) {
      calls.push(options);
      this.scrollTop = options.top;
    },
  };
  const root = {
    getBoundingClientRect: () => ({ top: 100 - scroll.scrollTop }),
    querySelector: () => ownRow,
  };
  const scrollRef = vue.shallowRef(scroll);
  const deps = {
    vue: {
      ...vue,
      onMounted: (fn) => hooks.mount.push(fn),
      onBeforeUnmount: (fn) => hooks.unmount.push(fn),
      onActivated: (fn) => hooks.activate.push(fn),
      onDeactivated: (fn) => hooks.deactivate.push(fn),
    },
    '@vueuse/core': { useResizeObserver() {} },
    'vue-router': { useRouter: () => ({}) },
    '@/stores/player': { usePlayerStore: () => player },
    './songContextMenuExtensions': { songContextMenuExtensions: vue.ref([]) },
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/setting': { useSettingStore: () => ({}) },
    '@/stores/toast': { useToastStore: () => ({}) },
    '@/stores/user': { useUserStore: () => ({}) },
    '@/composables/usePageScroll': { useScrollContainer: () => scrollRef },
  };
  function load(code) {
    const mod = { exports: {} };
    new Function(
      'require',
      'module',
      'exports',
      'window',
      'document',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'clearTimeout',
      code,
    )(
      (name) => deps[name] ?? {},
      mod,
      mod.exports,
      {
        ...events('window'),
        innerWidth: 1200,
        innerHeight: 800,
        setTimeout(fn) {
          timers.set(++nextTimer, fn);
          return nextTimer;
        },
      },
      events('document'),
      (fn) => {
        frames.set(++nextFrame, fn);
        return nextFrame;
      },
      (id) => frames.delete(id),
      (id) => timers.delete(id),
    );
    return mod.exports;
  }
  deps['@/composables/useVirtualList'] = load(listCode);
  const component = load(songCode).default;
  const props = vue.shallowReactive({
    songs: Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
      title: `Song ${i + 1}`,
      artist: 'Artist',
    })),
    activeId: '50',
    active: true,
    loading: false,
    searchQuery: '',
    stickySelector: '',
  });
  const scope = vue.effectScope();
  const api = scope.run(() => component.setup(props, { expose() {} }));
  api.containerRef.value = root;
  hooks.mount.forEach((fn) => fn());
  const flush = async () => {
    for (let i = 0; i < 5; i++) await vue.nextTick();
  };
  const frame = () => {
    const jobs = [...frames.values()];
    frames.clear();
    jobs.forEach((fn) => fn());
  };
  await flush();
  frame();
  return {
    api,
    props,
    calls,
    scroll,
    scrollRef,
    root,
    frames,
    timers,
    player,
    listenerCount: () => [...listeners.values()].reduce((sum, values) => sum + values.size, 0),
    emit: (type, event = {}) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(event)),
    openMenu: () =>
      api.handleContextMenu({
        target: { closest: () => ({ dataset: { songId: '50' } }) },
        clientX: 100,
        clientY: 200,
        preventDefault() {},
      }),
    flush,
    frame,
    ownRow: (rect) => {
      ownRow = { getBoundingClientRect: () => rect };
    },
    foreignRow: (rect) => {
      foreignRow = { getBoundingClientRect: () => rect };
    },
    deactivate: () => hooks.deactivate.forEach((fn) => fn()),
    activate: () => hooks.activate.forEach((fn) => fn()),
    dispose: () => {
      hooks.unmount.forEach((fn) => fn());
      scope.stop();
    },
  };
}

test('song location stays instant through index, sticky offset and row correction', async () => {
  const s = await fixture();
  await s.api.scrollToActive();
  assert.deepEqual(
    s.calls.map((call) => call.top),
    [3040, 2984],
  );
  s.ownRow({ top: 380, bottom: 440 });
  s.foreignRow({ top: 380, bottom: 440 });
  s.frame();
  assert.equal(s.calls.at(-1).top, 3036);
  assert.ok(s.calls.every((call) => call.behavior === 'instant'));
  s.dispose();
});

test('a matching row in another list cannot suppress this list location', async () => {
  const s = await fixture();
  s.foreignRow({ top: 100, bottom: 160 });
  await s.api.scrollToActive();
  assert.equal(s.calls.length, 2);
  s.dispose();
});

for (const change of [
  'deactivate',
  'inactive',
  'loading',
  'song',
  'songs',
  'container',
  'unmount',
]) {
  test(`pending nextTick location is discarded after ${change}`, async () => {
    const s = await fixture();
    const pending = s.api.scrollToActive();
    assert.equal(s.calls.length, 1);
    if (change === 'deactivate') {
      s.deactivate();
      s.activate();
    }
    if (change === 'inactive') {
      s.props.active = false;
      s.props.active = true;
    }
    if (change === 'loading') s.props.loading = true;
    if (change === 'song') {
      s.props.activeId = '51';
      s.props.activeId = '50';
    }
    if (change === 'songs') s.props.songs = [...s.props.songs].reverse();
    if (change === 'container') s.scrollRef.value = null;
    if (change === 'unmount') s.dispose();
    await pending;
    await s.flush();
    s.frame();
    assert.equal(s.calls.length, 1);
    if (change !== 'unmount') s.dispose();
  });
}

test('queued row correction cannot scroll after cache entry or unmount', async () => {
  for (const teardown of ['deactivate', 'dispose']) {
    const s = await fixture();
    await s.api.scrollToActive();
    const count = s.calls.length;
    s.ownRow({ top: -300, bottom: -240 });
    s.foreignRow({ top: -300, bottom: -240 });
    s[teardown]();
    s.frame();
    assert.equal(s.calls.length, count);
    if (teardown !== 'dispose') s.dispose();
  }
});

test('newer location replaces pending work and already-visible requests cancel old correction', async () => {
  const s = await fixture();
  const first = s.api.scrollToActive();
  s.props.activeId = '60';
  const second = s.api.scrollToActive();
  await Promise.all([first, second]);
  assert.deepEqual(
    s.calls.map((call) => call.top),
    [3040, 3640, 3584],
  );
  s.ownRow({ top: 100, bottom: 160 });
  s.foreignRow({ top: 100, bottom: 160 });
  await s.api.scrollToActive();
  const count = s.calls.length;
  s.ownRow({ top: -300, bottom: -240 });
  s.foreignRow({ top: -300, bottom: -240 });
  s.frame();
  assert.equal(s.calls.length, count);
  s.dispose();
});

test('in-place reordering cannot reuse the captured song index', async () => {
  const s = await fixture();
  // Use a reactive array as the real parent stores do, without replacing its identity.
  s.props.songs = vue.reactive([...s.props.songs]);
  await s.flush();
  const pending = s.api.scrollToActive();
  s.props.songs.reverse();
  await pending;
  s.frame();
  assert.equal(s.calls.length, 1);
  s.dispose();
});

test('cached, inactive and loading lists ignore new location requests', async () => {
  const s = await fixture();
  s.deactivate();
  await s.api.scrollToActive();
  s.activate();
  s.props.active = false;
  await s.api.scrollToActive();
  s.props.active = true;
  s.props.loading = true;
  await s.api.scrollToActive();
  assert.equal(s.calls.length, 0);
  s.props.loading = false;
  await s.flush();
  await s.api.scrollToActive();
  assert.equal(s.calls.length, 2);
  s.dispose();
});

test('closed song menus have no global listeners and restore the original scroll style', async () => {
  const s = await fixture();
  assert.equal(s.listenerCount(), 0);
  s.openMenu();
  await s.flush();
  assert.equal(s.listenerCount(), 4);
  assert.equal(s.scroll.style.overflow, 'hidden');
  let prevented = false;
  s.emit('document:keydown', {
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
  });
  await s.flush();
  assert.equal(prevented, true);
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.api.contextMenuTarget.value.id, '50');
  assert.equal(s.scroll.style.overflow, 'auto');
  assert.equal(s.listenerCount(), 0);
  s.dispose();
});

test('cache entry closes teleported overlays, releases the lock and cancels pending positioning', async () => {
  const s = await fixture();
  s.openMenu();
  await s.flush();
  s.api.showPlaylistDialog.value = true;
  s.openMenu(); // queues another position update
  const position = s.api.contextMenuPosition.value;
  s.deactivate();
  await s.flush();
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.api.showPlaylistDialog.value, false);
  assert.equal(s.api.contextMenuPosition.value, position);
  assert.equal(s.scroll.style.overflow, 'auto');
  assert.equal(s.listenerCount(), 0);
  s.openMenu();
  assert.equal(s.api.contextMenuOpen.value, false);
  s.activate();
  await s.flush();
  assert.equal(s.listenerCount(), 0);
  s.openMenu();
  await s.flush();
  assert.equal(s.listenerCount(), 4);
  s.dispose();
  assert.equal(s.scroll.style.overflow, 'auto');
  assert.equal(s.listenerCount(), 0);
});

test('container replacement unlocks the original target without changing the new target', async () => {
  const s = await fixture();
  s.openMenu();
  await s.flush();
  const replacement = { ...s.scroll, style: { overflow: 'scroll' } };
  s.scrollRef.value = replacement;
  await s.flush();
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.scroll.style.overflow, 'auto');
  assert.equal(replacement.style.overflow, 'scroll');
  s.dispose();
});

test('closing a menu preserves a later external overflow change', async () => {
  const s = await fixture();
  s.openMenu();
  await s.flush();
  s.scroll.style.overflow = 'clip';
  s.api.closeContextMenu();
  await s.flush();
  assert.equal(s.scroll.style.overflow, 'clip');
  s.dispose();
});

test('inactive lists cancel UI timers and restore the latest playback state on return', async () => {
  const s = await fixture();
  s.player.isPlaying = true;
  await s.flush();
  assert.equal(s.timers.size, 1);
  s.openMenu();
  s.api.showPlaylistDialog.value = true;
  s.props.active = false;
  await s.flush();
  assert.equal(s.timers.size, 0);
  assert.equal(s.frames.size, 0);
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.api.showPlaylistDialog.value, false);
  s.player.isPlaying = false;
  await s.flush();
  s.player.isPlaying = true;
  await s.flush();
  assert.equal(s.timers.size, 0);
  s.props.active = true;
  await s.flush();
  assert.equal(s.api.isPlaying.value, true);
  s.dispose();
});

test('cached playback updates do not schedule timers and rapid menu toggles do not leak listeners', async () => {
  const s = await fixture();
  for (let i = 0; i < 3; i++) {
    s.openMenu();
    s.api.closeContextMenu();
  }
  await s.flush();
  assert.equal(s.listenerCount(), 0);
  assert.equal(s.scroll.style.overflow, 'auto');
  s.deactivate();
  s.player.isPlaying = true;
  await s.flush();
  assert.equal(s.timers.size, 0);
  assert.equal(s.frames.size, 0);
  s.activate();
  await s.flush();
  assert.equal(s.api.isPlaying.value, true);
  s.dispose();
});

test('scrolling a long context menu preserves it, while page scroll and resize dismiss it', async () => {
  const s = await fixture();
  const menuChild = {};
  s.api.contextMenuRef.value = { contains: (target) => target === menuChild };
  s.openMenu();
  await s.flush();
  s.emit('window:scroll', { type: 'scroll', target: menuChild });
  await s.flush();
  assert.equal(s.api.contextMenuOpen.value, true);
  assert.equal(s.scroll.style.overflow, 'hidden');
  s.emit('window:scroll', { type: 'scroll', target: s.scroll });
  await s.flush();
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.scroll.style.overflow, 'auto');
  s.openMenu();
  await s.flush();
  s.emit('window:resize', { type: 'resize', target: menuChild });
  await s.flush();
  assert.equal(s.api.contextMenuOpen.value, false);
  assert.equal(s.listenerCount(), 0);
  s.dispose();
});
