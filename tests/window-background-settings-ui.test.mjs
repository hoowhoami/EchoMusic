import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

function loadModule(source, imports) {
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => imports[id] ?? {},
    module,
    module.exports,
  );
  return module.exports;
}

const constants = loadModule(
  readFileSync(new URL('../src/renderer/views/settings/constants.ts', import.meta.url), 'utf8'),
  {},
);
const { descriptor } = parse(
  readFileSync(
    new URL('../src/renderer/views/settings/components/WindowSettingsSection.vue', import.meta.url),
    'utf8',
  ),
);
const script = compileScript(descriptor, { id: 'window-background-settings-test' });
const compiled = compileTemplate({
  source: descriptor.template.content,
  filename: descriptor.filename,
  id: 'window-background-settings-test',
  compilerOptions: { bindingMetadata: script.bindings },
});
assert.deepEqual(compiled.errors, []);
const { render } = loadModule(compiled.code, { vue });

function setup(platform = 'darwin', closeBehavior = 'tray') {
  const synced = [];
  const store = {
    closeBehavior,
    hideDockInBackground: false,
    hideMenuBarInBackground: false,
    syncCloseBehavior() {
      synced.push({
        closeBehavior: this.closeBehavior,
        hideDockInBackground: this.hideDockInBackground,
        hideMenuBarInBackground: this.hideMenuBarInBackground,
      });
    },
  };
  const bindings = {
    ...constants,
    settingStore: store,
    platform,
    isMac: platform === 'darwin',
    isWindows: platform === 'win32',
    supportsCustomWindowControls: platform === 'win32' || platform === 'linux',
    SettingsSectionShell: { name: 'SettingsSectionShell' },
    Select: { name: 'Select' },
    Switch: { name: 'Switch' },
    Icon: { name: 'Icon' },
  };
  function nodes() {
    const result = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      result.push(node);
      if (Array.isArray(node.children)) visit(node.children);
      else if (node.children?.default) visit(node.children.default());
    }
    visit(render({}, [], {}, bindings, {}, {}));
    return result;
  }
  return {
    store,
    synced,
    nodes,
    control(label) {
      return nodes().find((node) => node.props?.['aria-label'] === label);
    },
    hasRecoveryHint() {
      return nodes().some(
        (node) => typeof node.children === 'string' && node.children.includes('Spotlight'),
      );
    },
  };
}

const dockLabel = '后台运行时在 Dock 栏中隐藏';
const menuBarLabel = '后台运行时在菜单栏中隐藏';

test('close behavior offers tray and exit on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const ui = setup(platform);
    assert.deepEqual(
      ui.control('关闭行为').props.options.map((option) => option.value),
      ['tray', 'exit'],
    );
  }
});

test('background icon switches appear only for macOS tray behavior', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const closeBehavior of ['tray', 'exit']) {
      const ui = setup(platform, closeBehavior);
      const expected = platform === 'darwin' && closeBehavior === 'tray';
      assert.equal(Boolean(ui.control(dockLabel)), expected);
      assert.equal(Boolean(ui.control(menuBarLabel)), expected);
    }
  }
});

test('each icon switch syncs independently and selecting exit preserves both preferences', () => {
  const ui = setup();
  ui.control(dockLabel).props['onUpdate:modelValue'](true);
  assert.equal(ui.control(dockLabel).props['model-value'], true);
  assert.equal(ui.control(menuBarLabel).props['model-value'], false);
  assert.deepEqual(ui.synced.at(-1), {
    closeBehavior: 'tray',
    hideDockInBackground: true,
    hideMenuBarInBackground: false,
  });

  ui.control(menuBarLabel).props['onUpdate:modelValue'](true);
  ui.control(dockLabel).props['onUpdate:modelValue'](false);
  assert.equal(ui.control(menuBarLabel).props['model-value'], true);
  assert.deepEqual(ui.synced.at(-1), {
    closeBehavior: 'tray',
    hideDockInBackground: false,
    hideMenuBarInBackground: true,
  });

  ui.control('关闭行为').props['onUpdate:modelValue']('exit');
  assert.equal(ui.control(dockLabel), undefined);
  assert.equal(ui.control(menuBarLabel), undefined);
  assert.equal(ui.store.hideDockInBackground, false);
  assert.equal(ui.store.hideMenuBarInBackground, true);
  assert.equal(ui.synced.at(-1).closeBehavior, 'exit');

  ui.control('关闭行为').props['onUpdate:modelValue']('tray');
  assert.equal(ui.control(dockLabel).props['model-value'], false);
  assert.equal(ui.control(menuBarLabel).props['model-value'], true);
  assert.equal(ui.synced.length, 5);
});

test('alternate recovery hint appears only when both background icon switches are enabled', () => {
  const ui = setup();
  for (const hideDock of [false, true]) {
    for (const hideMenuBar of [false, true]) {
      ui.store.hideDockInBackground = hideDock;
      ui.store.hideMenuBarInBackground = hideMenuBar;
      assert.equal(ui.hasRecoveryHint(), hideDock && hideMenuBar);
    }
  }
  ui.store.closeBehavior = 'exit';
  assert.equal(ui.hasRecoveryHint(), false);
});
