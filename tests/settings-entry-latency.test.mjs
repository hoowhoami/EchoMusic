import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as vue from 'vue';

function fixture(t, initialSection = 'interface') {
  const calls = [],
    pending = new Map(),
    errors = [];
  const open = vue.ref(false),
    section = vue.ref(initialSection);
  const slot = {
    inheritAttrs: false,
    setup(_, { slots, expose }) {
      expose({ setScrollTop() {} });
      return () => slots.default?.();
    },
  };
  const empty = { render: () => null };
  const dialog = {
    props: ['open'],
    setup:
      (props, { slots }) =>
      () =>
        props.open ? vue.h('div', slots.default?.()) : null,
  };
  const defaultSection = { render: () => vue.h('div', '默认界面设置') };
  const store = {
    // Leave IPC deliberately pending: it must not gate the opening frame.
    hydrateLogSettings: () => new Promise(() => {}),
    syncCloseBehavior() {},
    syncTheme() {},
    syncLogSettings() {},
    hydrateAppInfo() {},
  };
  const dependencies = {
    vue,
    '@/components/ui/Tooltip.vue': { default: empty },
    '@/components/ui/Dialog.vue': { default: dialog },
    '@/components/ui/Button.vue': { default: slot },
    '@/components/ui/Scrollbar.vue': { default: slot },
    '@/components/app/DisclaimerDialog.vue': { default: empty },
    '@/stores/setting': { useSettingStore: () => store },
    '@/stores/update': { useUpdateStore: () => ({ isChecking: false }) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({ hydrate() {} }) },
    '@/composables/useSettingsDialog': { settingsDialogOpen: open, settingsDialogSection: section },
    '@/icons': {},
    './settings/components/InterfaceSettingsSection.vue': { default: defaultSection },
    './settings/constants': {
      sectionTitles: {
        interface: { label: '界面与外观' },
        window: { label: '窗口与系统' },
        player: { label: '播放引擎' },
      },
      shortcutItems: [],
    },
  };
  function loadModule(path) {
    calls.push(path);
    return new Promise((resolve) => pending.set(path, resolve));
  }
  function loadSfc(path) {
    const { descriptor } = parse(readFileSync(path, 'utf8'));
    const script = compileScript(descriptor, { id: path, inlineTemplate: true });
    const source = script.content.replace(/import\(('.*?')\)/g, 'loadModule($1)');
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'window', 'document', 'loadModule', code)(
      (name) => {
        assert.ok(name in dependencies, `Unexpected eager dependency: ${name}`);
        const dep = dependencies[name];
        return 'default' in dep ? { __esModule: true, ...dep } : dep;
      },
      module,
      module.exports,
      { electron: { platform: 'darwin' }, setTimeout, clearTimeout },
      { addEventListener() {}, removeEventListener() {} },
      loadModule,
    );
    return module.exports.default;
  }
  dependencies['@/views/Settings.vue'] = {
    default: loadSfc('src/renderer/views/Settings.vue'),
  };
  const component = loadSfc('src/renderer/components/app/SettingsDialog.vue');
  const node = (type, text = '') => ({
    type,
    text,
    children: [],
    props: {},
    style: {},
    parent: null,
  });
  const root = node('root');
  const renderer = vue.createRenderer({
    createElement: node,
    createText: (text) => node('text', text),
    createComment: (text) => node('comment', text),
    setText: (n, text) => (n.text = text),
    setElementText: (n, text) => (n.text = text),
    patchProp: (n, key, _, value) => (n.props[key] = value),
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
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
  });
  const app = renderer.createApp(component);
  app.component('Icon', empty);
  app.config.errorHandler = (error) => errors.push(error);
  app.mount(root);
  t.after(() => {
    app.unmount();
    assert.deepEqual(errors, []);
  });
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  const text = () =>
    walk(root)
      .map((n) => n.text)
      .join(' ');
  const click = async (label) => {
    const button = walk(root).find(
      (n) =>
        n.type === 'button' &&
        (n.props['aria-label'] === label || walk(n).some((child) => child.text === label)),
    );
    assert.ok(button, `Missing button: ${label}`);
    button.props.onClick();
    await vue.nextTick();
  };
  const resolve = async (name) => {
    const path = `./settings/components/${name}SettingsSection.vue`;
    assert.ok(pending.has(path), `Missing request: ${path}`);
    pending.get(path)({
      __esModule: true,
      default: { render: () => vue.h('div', `${name}设置内容`) },
    });
    // Settle the async loader chain, then Vue's render queue, without timers.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await vue.nextTick();
  };
  return { open, section, calls, text, click, resolve };
}

test('the first settings frame renders navigation and default controls without loading other sections or waiting for IPC', async (t) => {
  const f = fixture(t);
  assert.doesNotMatch(f.text(), /偏好设置/);
  f.open.value = true;
  await vue.nextTick();
  assert.match(f.text(), /偏好设置/);
  assert.match(f.text(), /窗口与系统/);
  assert.match(f.text(), /默认界面设置/);
  assert.deepEqual(f.calls, []);
  await f.click('关闭设置');
  assert.equal(f.open.value, false);
  f.open.value = true;
  await vue.nextTick();
  assert.match(f.text(), /默认界面设置/);
  assert.deepEqual(f.calls, []);
});

test('slow section loads retain the shell and cannot overwrite a newer selection', async (t) => {
  const f = fixture(t);
  f.open.value = true;
  await vue.nextTick();
  await f.click('音效管理');
  assert.match(f.text(), /偏好设置/);
  assert.match(f.text(), /正在加载设置/);
  assert.deepEqual(f.calls, ['./settings/components/SpatialAudioSettingsSection.vue']);
  await f.click('字体设置');
  await f.resolve('SpatialAudio');
  assert.doesNotMatch(f.text(), /SpatialAudio设置内容/);
  assert.match(f.text(), /正在加载设置/);
  await f.resolve('Font');
  assert.match(f.text(), /Font设置内容/);
  assert.doesNotMatch(f.text(), /正在加载设置/);
  await f.click('音效管理');
  assert.match(f.text(), /SpatialAudio设置内容/);
  assert.equal(f.calls.length, 2, 'resolved modules are reused on later selections');
});

test('opening directly into a slow section renders the shell and closing during its load stays closed', async (t) => {
  const f = fixture(t, 'spatialAudio');
  f.open.value = true;
  await vue.nextTick();
  assert.match(f.text(), /偏好设置/);
  assert.match(f.text(), /正在加载设置/);
  await f.click('关闭设置');
  await f.resolve('SpatialAudio');
  assert.doesNotMatch(f.text(), /偏好设置|SpatialAudio设置内容/);
  f.open.value = true;
  await vue.nextTick();
  assert.match(f.text(), /SpatialAudio设置内容/);
  assert.equal(f.calls.length, 1);
});

test('opening taskbar lyric settings loads the lyric category', async (t) => {
  const f = fixture(t, 'taskbarLyric');
  f.open.value = true;
  await vue.nextTick();
  assert.deepEqual(f.calls, ['./settings/components/LyricSettingsSection.vue']);
  await f.resolve('Lyric');
  assert.match(f.text(), /Lyric设置内容/);
});
