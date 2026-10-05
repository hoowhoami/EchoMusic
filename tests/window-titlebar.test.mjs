import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync, transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const chromeModule = { exports: {} };
new Function(
  'module',
  buildSync({
    entryPoints: ['src/main/window/chrome.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text,
)(chromeModule);
const { getMainWindowChrome } = chromeModule.exports;

function setupComponent(filename, platform, props = {}, settings = {}) {
  const { descriptor } = parse(
    readFileSync(new URL(`../src/renderer/layouts/${filename}`, import.meta.url), 'utf8'),
  );
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true });
  const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });
  const calls = [];
  const mounted = [],
    unmounted = [],
    listeners = new Map();
  const documentListeners = new Map();
  const document = {
    fullscreenElement: null,
    addEventListener: (name, fn) => documentListeners.set(name, fn),
    removeEventListener: (name) => documentListeners.delete(name),
  };
  let resolveFrame;
  const frameQuery = new Promise((resolve) => {
    resolveFrame = resolve;
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', code)(
    (id) =>
      id === 'vue'
        ? { ...vue, onMounted: (fn) => mounted.push(fn), onUnmounted: (fn) => unmounted.push(fn) }
        : id === '@/stores/setting'
          ? { useSettingStore: () => settings }
          : { default: { name: 'Stub' }, Icon: { name: 'Icon' } },
    module,
    module.exports,
    {
      electron: {
        platform,
        windowControl: (action) => calls.push(action),
        miniPlayer: { show: () => calls.push('mini') },
        ipcRenderer: {
          on: (channel, fn) => listeners.set(channel, fn),
          off: (channel, fn) => {
            if (listeners.get(channel) === fn) listeners.delete(channel);
          },
          invoke: () => frameQuery,
        },
      },
    },
    document,
  );
  const render = module.exports.default.setup(props, { expose() {} });
  let buttons = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.props?.['aria-label']) buttons.push(node);
    if (Array.isArray(node.children)) visit(node.children);
    else {
      if (node.children?.default) visit(node.children.default());
      if (node.children?.trigger) visit(node.children.trigger());
    }
  }
  const collect = () => {
    buttons = [];
    visit(render({}, []));
    return buttons;
  };
  return {
    calls,
    get buttons() {
      return collect();
    },
    control: (label) => collect().find((node) => node.props['aria-label'] === label),
    mount: () => mounted.forEach((fn) => fn()),
    unmount: () => unmounted.forEach((fn) => fn()),
    resolveFrame: (state) => resolveFrame(state),
    emitFrame: (state) => listeners.get('window:frame-state-changed')?.(state),
    emitFullscreen: (value) => listeners.get('window:fullscreen-changed')?.(value),
    htmlFullscreen: (value) => {
      document.fullscreenElement = value ? {} : null;
      documentListeners.get('fullscreenchange')?.();
    },
    listeners,
    documentListeners,
  };
}

test('macOS retains native traffic lights while Windows/Linux have no native caption overlay', () => {
  const mac = getMainWindowChrome('darwin');
  assert.equal(mac.frame, true);
  assert.equal(mac.titleBarOverlay, true);
  assert.deepEqual(mac.trafficLightPosition, { x: 14, y: 14 });
  for (const platform of ['win32', 'linux']) {
    const options = getMainWindowChrome(platform);
    assert.equal(options.frame, false);
    assert.equal(options.titleBarStyle, 'hidden');
    assert.equal(options.titleBarOverlay, undefined);
    assert.equal(options.trafficLightPosition, undefined);
  }
});

test('caption controls are absent on macOS and invoke window actions on Windows/Linux', () => {
  assert.equal(setupComponent('WindowControls.vue', 'darwin').buttons.length, 0);
  for (const platform of ['win32', 'linux']) {
    const ui = setupComponent('WindowControls.vue', platform);
    assert.deepEqual(
      ui.buttons.map((node) => node.props['aria-label']),
      ['窗口控制', '最小化窗口', '最大化窗口', '关闭窗口'],
    );
    ui.control('关闭窗口').props.onClick();
    ui.control('最小化窗口').props.onClick();
    ui.control('最大化窗口').props.onClick();
    ui.control('最大化窗口').props.onClick();
    assert.deepEqual(ui.calls, ['close', 'minimize', 'maximize', 'maximize']);
  }
});

test('right-hand tools keep mini/fullscreen behavior independently of caption controls', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const ui = setupComponent(
      'WindowControls.vue',
      platform,
      { showMiniPlayer: true },
      { showFullscreenButton: true },
    );
    ui.control('打开 mini 播放器').props.onClick();
    assert.deepEqual(ui.calls, ['mini']);
    assert.equal(Boolean(ui.control('切换全屏')), platform !== 'darwin');
    if (platform !== 'darwin') {
      ui.control('切换全屏').props.onClick();
      assert.deepEqual(ui.calls, ['mini', 'fullscreen']);
    }
    for (const label of ['关闭窗口', '最小化窗口', '最大化窗口'])
      assert.equal(Boolean(ui.control(label)), platform !== 'darwin');
    const hidden = setupComponent(
      'WindowControls.vue',
      platform,
      { showMiniPlayer: false },
      { showFullscreenButton: false },
    );
    assert.equal(hidden.buttons.length, platform === 'darwin' ? 0 : 4);
  }
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: caption controls follow native maximize/restore and ignore stale initial state`, async () => {
    const ui = setupComponent('WindowControls.vue', platform);
    ui.mount();
    ui.emitFrame({ maximized: true });
    ui.resolveFrame({ maximized: false });
    await Promise.resolve();
    assert.ok(ui.control('还原窗口'));
    ui.control('还原窗口').props.onClick();
    assert.deepEqual(ui.calls, ['maximize']);
    ui.emitFrame({ maximized: false });
    assert.ok(ui.control('最大化窗口'));
    ui.unmount();
    assert.equal(ui.listeners.size, 0);
  });
  test(`${platform}: fullscreen hides all caption controls, rejects a stale query, and restores native maximize state`, async () => {
    const ui = setupComponent('WindowControls.vue', platform, {}, { showFullscreenButton: true });
    ui.mount();
    ui.emitFullscreen(true);
    ui.resolveFrame({ maximized: true, fullscreen: false });
    await Promise.resolve();
    for (const label of ['关闭窗口', '最小化窗口', '最大化窗口', '还原窗口'])
      assert.equal(ui.control(label), undefined);
    assert.ok(ui.control('切换全屏'));
    ui.emitFrame({ maximized: true, fullscreen: false });
    assert.equal(ui.control('关闭窗口'), undefined);
    ui.emitFullscreen(false);
    assert.ok(ui.control('还原窗口'));
    assert.ok(ui.control('关闭窗口'));
    ui.htmlFullscreen(true);
    assert.equal(ui.control('关闭窗口'), undefined);
    ui.htmlFullscreen(false);
    assert.ok(ui.control('关闭窗口'));
    ui.unmount();
    assert.equal(ui.listeners.size, 0);
    assert.equal(ui.documentListeners.size, 0);
  });
  test(`${platform}: mounting in fullscreen initializes hidden caption controls`, async () => {
    const ui = setupComponent('WindowControls.vue', platform);
    ui.mount();
    ui.resolveFrame({ maximized: false, fullscreen: true });
    await Promise.resolve();
    assert.equal(ui.control('关闭窗口'), undefined);
    ui.emitFullscreen(false);
    assert.ok(ui.control('关闭窗口'));
    ui.unmount();
  });
}
