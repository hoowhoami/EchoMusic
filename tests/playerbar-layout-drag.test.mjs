import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';

const evaluate = (source, dependencies, globals = {}) => {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    ...Object.keys(globals),
    transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  )((id) => dependencies[id] ?? {}, module, module.exports, ...Object.values(globals));
  return module.exports;
};
const actions = evaluate(readFileSync('src/renderer/layouts/playerBarActions.ts', 'utf8'), {});
const { descriptor } = parse(readFileSync('src/renderer/layouts/PlayerBarMoreMenu.vue', 'utf8'));
const source = compileScript(descriptor, { id: 'playerbar-layout-drag' }).content;
const node = (key) =>
  vue.markRaw({
    dataset: key ? { playerbarKey: key } : {},
    parentNode: null,
    get nextSibling() {
      const nodes = this.parentNode?.nodes ?? [];
      return nodes[nodes.indexOf(this) + 1] ?? null;
    },
  });
const list = (placement) =>
  vue.markRaw({
    dataset: { playerbarPlacementList: placement },
    nodes: [],
    insertBefore(item, anchor) {
      if (item.parentNode) item.parentNode.nodes.splice(item.parentNode.nodes.indexOf(item), 1);
      const index = anchor ? this.nodes.indexOf(anchor) : this.nodes.length;
      assert.ok(index >= 0, 'anchor belongs to this list');
      this.nodes.splice(index, 0, item);
      item.parentNode = this;
    },
  });
function fixture(t, slots = {}) {
  const scope = vue.effectScope(),
    hooks = {},
    timers = [],
    instances = [],
    writes = [];
  const zones = Object.fromEntries(
    ['center', 'left', 'right', 'more'].map((zone) => [zone, list(zone)]),
  );
  const initial = [
    ['comments', 'left'],
    ['play', 'center'],
    ['queue', 'right'],
    ['speed', 'more'],
    ['plugin:speed', 'more'],
    ['volume', 'more'],
  ];
  const items = initial.map(([key, placement], index) => ({
    id: key === 'plugin:speed' ? 'speed' : key,
    key,
    defaultPlacement: placement,
    title: key,
    visible: true,
    order: index,
    icon: {},
    onClick() {},
  }));
  const chips = new Map(),
    anchors = new Map();
  for (const [key, placement] of initial) {
    const chip = node(key),
      start = node(),
      end = node();
    for (const item of [start, chip, end]) zones[placement].insertBefore(item, null);
    chips.set(key, chip);
    anchors.set(key, end);
  }
  const board = vue.markRaw({
    querySelectorAll: (selector) =>
      selector === '[data-playerbar-placement-list]'
        ? Object.values(zones)
        : Object.values(zones).flatMap((zone) =>
            zone.nodes.filter((item) => item.dataset.playerbarKey),
          ),
  });
  const layout = vue.ref({ placements: { hidden: 'left' }, order: [], badges: { speed: true } });
  const settings = {
    get playerBarLayout() {
      return layout.value;
    },
    set playerBarLayout(value) {
      writes.push({
        value,
        speedParent: chips.get('speed').parentNode,
        speedNext: chips.get('speed').nextSibling,
      });
      layout.value = value;
    },
  };
  class Sortable {
    constructor(element, options) {
      this.element = element;
      this.options = options;
      instances.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const component = evaluate(
    source,
    {
      vue: {
        ...vue,
        useSlots: () => slots,
        onMounted: (fn) => {
          hooks.mount = fn;
        },
        onBeforeUnmount: (fn) => {
          hooks.unmount = fn;
        },
      },
      sortablejs: Sortable,
      './playerBarActions': actions,
      '@/stores/setting': { useSettingStore: () => settings },
    },
    {
      Element: class {},
      document: { addEventListener() {}, removeEventListener() {} },
      window: { setTimeout: (fn) => timers.push(fn) },
    },
  ).default;
  const props = vue.reactive({
    get items() {
      return actions.resolvePlayerBarActions(items, layout.value);
    },
    menuItems: [],
    badges: [],
  });
  const view = scope.run(() => component.setup(props, { expose() {} }));
  view.boardRef.value = board;
  t.after(() => {
    hooks.unmount?.();
    scope.stop();
  });
  return {
    view,
    zones,
    chips,
    anchors,
    instances,
    writes,
    settings,
    timers,
    begin(key) {
      const chip = chips.get(key),
        from = chip.parentNode;
      const sortable = instances.find(
        (instance) => instance.element === from && !instance.destroyed,
      );
      sortable.options.onStart({ item: chip, from });
      return { chip, from, sortable };
    },
    drop(drag, zone, anchor = null) {
      zones[zone].insertBefore(drag.chip, anchor);
      drag.sortable.options.onEnd({ item: drag.chip, from: drag.from, to: zones[zone] });
    },
  };
}

for (const placement of ['left', 'center', 'right']) {
  test(`more to ${placement} restores the Tooltip fragment before saving the new placement`, async (t) => {
    const f = fixture(t);
    await f.view.setupSortables();
    f.drop(f.begin('speed'), placement);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].speedParent, f.zones.more);
    assert.equal(f.writes[0].speedNext, f.anchors.get('speed'));
    assert.equal(f.settings.playerBarLayout.placements.speed, placement);
    assert.equal(f.settings.playerBarLayout.placements.hidden, 'left');
    assert.equal(f.settings.playerBarLayout.badges.speed, true);
    assert.equal(new Set(f.settings.playerBarLayout.order).size, 6);
  });
}

test('same-zone sorting saves moved order while restoring the original fragment anchors', async (t) => {
  const f = fixture(t);
  await f.view.setupSortables();
  f.drop(f.begin('speed'), 'more', null);
  assert.deepEqual(
    f.settings.playerBarLayout.order.filter((key) =>
      ['speed', 'volume', 'plugin:speed'].includes(key),
    ),
    ['plugin:speed', 'volume', 'speed'],
  );
  assert.equal(f.chips.get('speed').nextSibling, f.anchors.get('speed'));
});

test('a plugin key remains distinct from the builtin action with the same business ID', async (t) => {
  const f = fixture(t);
  await f.view.setupSortables();
  f.drop(f.begin('plugin:speed'), 'right');
  assert.equal(f.settings.playerBarLayout.placements['plugin:speed'], 'right');
  assert.equal(f.settings.playerBarLayout.placements.speed, undefined);
  assert.equal(f.chips.get('plugin:speed').nextSibling, f.anchors.get('plugin:speed'));
});

test('destroying the editor during a drag restores ownership without writing a new layout', async (t) => {
  const f = fixture(t);
  await f.view.setupSortables();
  const drag = f.begin('speed');
  f.zones.right.insertBefore(drag.chip, null);
  f.view.destroySortables();
  assert.equal(drag.chip.parentNode, f.zones.more);
  assert.equal(drag.chip.nextSibling, f.anchors.get('speed'));
  assert.equal(f.writes.length, 0);
  assert.ok(f.instances.every((instance) => instance.destroyed));
});

test('dropping back in the original position keeps order and completes sorting state', async (t) => {
  const f = fixture(t);
  await f.view.setupSortables();
  const drag = f.begin('speed');
  f.drop(drag, 'more', f.anchors.get('speed'));
  assert.deepEqual(
    f.settings.playerBarLayout.order.filter((key) =>
      ['speed', 'volume', 'plugin:speed'].includes(key),
    ),
    ['speed', 'plugin:speed', 'volume'],
  );
  assert.equal(f.view.isSorting.value, true);
  f.timers.forEach((fn) => fn());
  assert.equal(f.view.isSorting.value, false);
});

test('custom floating panels own dismissal while their verification UI is open', (t) => {
  const f = fixture(t, { 'floating-action': () => null });
  f.view.activate(
    {
      component: 'barrage',
      onClick() {
        assert.fail('must open the panel');
      },
    },
    {},
  );
  assert.equal(f.view.floatingAction.value.component, 'barrage');
  f.view.handleDocumentMousedown({ target: {} });
  assert.equal(f.view.floatingAction.value.component, 'barrage');
  f.view.closeFloatingPanels();
  assert.equal(f.view.floatingAction.value, null);
});

test('builtin floating panels keep their existing outside-dismiss behavior', (t) => {
  const f = fixture(t, { 'floating-action': () => null });
  f.view.activate(
    {
      component: 'speed',
      onClick() {
        assert.fail('must open the panel');
      },
    },
    {},
  );
  assert.equal(f.view.floatingAction.value.component, 'speed');
  f.view.handleDocumentMousedown({ target: {} });
  assert.equal(f.view.floatingAction.value, null);
});
