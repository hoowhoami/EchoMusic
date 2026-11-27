import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const compile = (path) =>
  transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
const compiled = {
  settings: compile('../src/renderer/stores/setting.ts'),
  shortcuts: compile('../src/renderer/utils/shortcuts.ts'),
  guard: compile('../src/renderer/utils/inputBehaviorGuard.ts'),
};

class Element {
  constructor(tag = 'div', attributes = {}, parent = null) {
    this.tag = tag;
    this.attributes = attributes;
    this.parent = parent;
    this.isContentEditable = false;
  }

  closest(selector) {
    const matches = selector.split(',').some((part) => {
      const attribute = part.match(/^\[([^=]+)="([^"]*)"\]$/);
      return attribute ? this.attributes[attribute[1]] === attribute[2] : this.tag === part;
    });
    return matches ? this : (this.parent?.closest(selector) ?? null);
  }
}

function fixture(platform = 'win32', bindings = {}) {
  const listeners = [];
  const window = {
    electron: { platform },
    addEventListener: (name, listener, capture) => listeners.push({ name, listener, capture }),
    removeEventListener: (name, listener) => {
      const index = listeners.findIndex((item) => item.name === name && item.listener === listener);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const evaluate = (code, dependencies = {}) => {
    const module = { exports: {} };
    new Function('require', 'module', 'window', 'HTMLElement', code)(
      (id) => dependencies[id] ?? {},
      module,
      window,
      Element,
    );
    return module.exports;
  };
  const settings = evaluate(compiled.settings, {
    pinia: { defineStore: (_id, options) => options },
    '../plugins/titlebar': { emptyTitlebarLayout: () => ({}) },
    '../layouts/playerBarActions': { emptyPlayerBarLayout: () => ({}) },
    '../layouts/sidebarLayout': { emptySidebarLayout: () => ({}) },
    '../../shared/miniPlayer': { DEFAULT_MINI_LYRIC_STYLE: {} },
    '../../shared/network': { DEFAULT_NETWORK_SETTINGS: {} },
  });
  const store = { ...settings.useSettingStore.state(), shortcutBindings: bindings };
  const guard = evaluate(compiled.guard);
  const player = { isPlaying: false, togglePlay: () => (player.isPlaying = !player.isPlaying) };
  const shortcuts = evaluate(compiled.shortcuts, {
    '@/stores/setting': { useSettingStore: () => store },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => ({}) },
    '@/stores/lyric': { useLyricStore: () => ({}) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => ({}) },
    '@/utils/inputBehaviorGuard': guard,
  });
  const removeGuard = guard.installInputBehaviorGuard({
    isEnabled: () => store.suppressDefaultKeyBehaviors,
  });
  const removeShortcuts = shortcuts.registerLocalShortcuts();
  const press = (patch = {}) => {
    const event = {
      key: ' ',
      code: 'Space',
      target: new Element(),
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...patch,
    };
    // 捕获阶段监听器先于冒泡阶段；capture 缺省视为 false
    for (const { listener } of listeners.toSorted(
      (a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0),
    )) {
      listener(event);
    }
    return event;
  };
  return { store, player, shortcuts, settings, press, removeGuard, removeShortcuts };
}

test('Windows defaults Space to play/pause and each press toggles once despite the input guard', () => {
  const f = fixture();
  assert.equal(f.store.defaultShortcutLabels.togglePlayback, 'Space');
  assert.equal(f.shortcuts.resolveShortcutMap('local').togglePlayback, 'Space');
  assert.equal(f.shortcuts.resolveShortcutMap('global').togglePlayback, 'CmdOrCtrl+Shift+Space');
  assert.equal(f.press().defaultPrevented, true);
  assert.equal(f.player.isPlaying, true);
  f.press();
  assert.equal(f.player.isPlaying, false);
  f.removeShortcuts();
  f.press();
  assert.equal(f.player.isPlaying, false);
});

test('default shortcut labels resolve per platform', () => {
  const f = fixture();
  assert.equal(f.settings.resolveDefaultShortcutLabels('win32').togglePlayback, 'Space');
  assert.equal(f.settings.resolveDefaultShortcutLabels('darwin').togglePlayback, '⌘Space');
  assert.equal(f.settings.resolveDefaultShortcutLabels(undefined).togglePlayback, '⌘Space');
});

test('restored defaults and resets use Space without overwriting custom or disabled bindings', () => {
  for (const binding of [undefined, 'Ctrl+P', '']) {
    const f = fixture('win32', binding === undefined ? {} : { togglePlayback: binding });
    f.store.defaultShortcutLabels.togglePlayback = '⌘Space';
    f.settings.useSettingStore.actions.ensureShortcutDefaults.call(f.store);
    assert.equal(f.store.defaultShortcutLabels.togglePlayback, 'Space');
    assert.equal(f.shortcuts.resolveShortcutMap('local').togglePlayback, binding ?? 'Space');
    f.settings.useSettingStore.actions.resetShortcutDefaults.call(f.store);
    assert.equal(f.store.defaultShortcutLabels.togglePlayback, 'Space');
    assert.deepEqual(
      f.store.shortcutBindings,
      binding === undefined ? {} : { togglePlayback: binding },
    );
  }
});

test('custom assignments, disabled shortcuts and changed bindings remain effective', () => {
  const f = fixture('win32', { togglePlayback: 'Ctrl+P' });
  f.press();
  assert.equal(f.player.isPlaying, false);
  f.press({ key: 'p', code: 'KeyP', ctrlKey: true });
  assert.equal(f.player.isPlaying, true);
  f.store.shortcutBindings.togglePlayback = '';
  f.press();
  assert.equal(f.player.isPlaying, true);
  delete f.store.shortcutBindings.togglePlayback;
  f.store.shortcutEnabled = false;
  f.press();
  assert.equal(f.player.isPlaying, true);
  f.store.shortcutEnabled = true;
  f.press();
  assert.equal(f.player.isPlaying, false);
});

test('Ctrl+Space still toggles playback on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const f = fixture(platform);
    const event = f.press({ ctrlKey: true });
    assert.equal(event.defaultPrevented, true, platform);
    assert.equal(f.player.isPlaying, true, platform);
  }
});

test('Space over activatable elements is left to the element itself', () => {
  const f = fixture();
  f.removeGuard();
  for (const target of [
    new Element('button'),
    new Element('a'),
    new Element('div', { role: 'button', tabindex: '0' }),
    new Element('div', { role: 'checkbox' }),
    new Element('div', { role: 'switch' }),
    new Element('span', {}, new Element('button')),
  ]) {
    const event = f.press({ target });
    assert.equal(event.defaultPrevented, false, JSON.stringify(target.attributes));
    assert.equal(f.player.isPlaying, false, JSON.stringify(target.attributes));
  }
});

test('disabling default-behavior suppression keeps shortcuts working without preventDefault', () => {
  const f = fixture();
  f.store.suppressDefaultKeyBehaviors = false;
  const event = f.press();
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.player.isPlaying, true);
  f.store.suppressDefaultKeyBehaviors = true;
  assert.equal(f.press().defaultPrevented, true);
  assert.equal(f.player.isPlaying, false);

  // 带修饰键的组合与浏览器默认行为无冲突，屏蔽开关关闭时仍始终阻止
  const modified = fixture('win32', { togglePlayback: 'Ctrl+P' });
  modified.store.suppressDefaultKeyBehaviors = false;
  const modifiedEvent = modified.press({ key: 'p', code: 'KeyP', ctrlKey: true });
  assert.equal(modifiedEvent.defaultPrevented, true);
  assert.equal(modified.player.isPlaying, true);
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} keeps its existing local and global defaults`, () => {
    const f = fixture(platform);
    assert.equal(f.store.defaultShortcutLabels.togglePlayback, '⌘Space');
    assert.equal(f.store.defaultGlobalShortcutLabels.togglePlayback, '⌘⇧Space');
    f.press();
    assert.equal(f.player.isPlaying, false);
  });
}

for (const target of [
  new Element('input'),
  new Element('textarea'),
  new Element('select'),
  new Element('span', {}, new Element('div', { contenteditable: 'true' })),
  new Element('div', { contenteditable: 'plaintext-only' }),
  new Element('div', { role: 'textbox' }),
  new Element('video'),
  new Element('audio'),
]) {
  test(`Space remains available in ${target.tag} ${JSON.stringify(target.attributes)}`, () => {
    const f = fixture();
    assert.equal(f.press({ target }).defaultPrevented, false);
    assert.equal(f.player.isPlaying, false);
  });
}

test('held keys, IME composition and modified Space never trigger the default playback shortcut', () => {
  const f = fixture();
  for (const patch of [
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
  ]) {
    f.press(patch);
    assert.equal(f.player.isPlaying, false, JSON.stringify(patch));
  }
  f.press();
  f.press({ repeat: true });
  assert.equal(f.player.isPlaying, true);
});
