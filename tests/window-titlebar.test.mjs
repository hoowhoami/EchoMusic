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
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', code)(
    (id) =>
      id === 'vue'
        ? vue
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
      },
    },
  );
  const render = module.exports.default.setup(props, { expose() {} });
  const buttons = [];
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
  visit(render({}, []));
  return {
    calls,
    buttons,
    control: (label) => buttons.find((node) => node.props['aria-label'] === label),
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

test('renderer traffic lights are absent on macOS and invoke window actions on Windows/Linux', () => {
  assert.equal(setupComponent('TrafficLights.vue', 'darwin').buttons.length, 0);
  for (const platform of ['win32', 'linux']) {
    const ui = setupComponent('TrafficLights.vue', platform);
    assert.deepEqual(
      ui.buttons.map((node) => node.props['aria-label']),
      ['窗口控制', '关闭窗口', '最小化窗口', '最大化或还原窗口'],
    );
    ui.control('关闭窗口').props.onClick();
    ui.control('最小化窗口').props.onClick();
    ui.control('最大化或还原窗口').props.onClick();
    ui.control('最大化或还原窗口').props.onClick();
    assert.deepEqual(ui.calls, ['close', 'minimize', 'maximize', 'maximize']);
  }
});

test('right-hand tools keep mini/fullscreen behavior without duplicate close/minimize/maximize controls', () => {
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
    for (const label of ['关闭窗口', '最小化窗口', '最大化或还原窗口'])
      assert.equal(ui.control(label), undefined);
    const hidden = setupComponent(
      'WindowControls.vue',
      platform,
      { showMiniPlayer: false },
      { showFullscreenButton: false },
    );
    assert.equal(hidden.buttons.length, 0);
  }
});
