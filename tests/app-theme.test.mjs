import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';
const require = createRequire(import.meta.url);
const output = await build({
  stdin: {
    contents: `export {default as ThemeContent} from './src/renderer/theme/ThemeContent.vue';export * from './src/renderer/theme/model';export { DEFAULT_NOW_PLAYING_APPEARANCE } from './src/shared/nowPlaying';export { DEFAULT_THEME_ACCENT } from './src/shared/themePalette';export * from './src/renderer/theme/colors';export * from './src/renderer/theme/registry';export * from './src/renderer/stores/theme';export * from './src/renderer/layouts/sidebarLayout';export {createThemeApi,legacySurfaceVariables,legacyAccentGradientVariables} from './src/renderer/plugins/runtime/theme';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  alias: { '@': './src/renderer' },
  plugins: [
    {
      name: 'theme-component',
      setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', external: true }));
        builder.onLoad({ filter: /\.vue$/ }, (args) => {
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return {
            contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
            loader: 'ts',
            resolveDir: dirname(args.path),
          };
        });
        builder.onResolve({ filter: /^@vueuse\/core$/ }, (args) => ({
          path: args.path,
          namespace: 'visibility',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'visibility' }, () => ({
          contents:
            "import {ref} from 'vue';export const useDocumentVisibility=()=>ref('visible');export const usePreferredReducedMotion=()=>ref('reduce');",
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const api = module.exports;
function style() {
  const values = new Map();
  return {
    setProperty: (k, v) => values.set(k, v),
    removeProperty: (k) => values.delete(k),
    getPropertyValue: (k) => values.get(k) ?? '',
    [Symbol.iterator]: () => values.keys(),
  };
}
globalThis.window = {
  matchMedia: (q) => ({ matches: q.includes('reduced-motion') }),
  electron: { ipcRenderer: { send() {} } },
};
globalThis.document = {
  documentElement: { style: style(), classList: { toggle() {} } },
  body: { style: style(), classList: { toggle() {} } },
};
const disposers = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
});
function store() {
  return api.useThemeStore(require('pinia').createPinia());
}
function register(id = 'test', options = {}) {
  const errors = [];
  const registry = api.createAppThemeApi(
    id,
    (d) => disposers.push(d),
    (source, error) => errors.push(error),
    true,
  );
  const entry = {
    id: 'one',
    title: 'Test',
    variants: {
      light: { tokens: api.neutralTokens(false), accent: '#008877' },
      dark: { tokens: api.neutralTokens(true), accent: '#339977' },
    },
    ...options,
  };
  const dispose = registry.register(entry);
  return { registry, entry, dispose, key: JSON.stringify([id, 'one']), errors };
}

test('immersive player foreground uses its own dark surface while retaining the current accent', () => {
  const s = store();
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode, accent: { source: 'cover', color: '#0071e3' } });
    for (const cover of ['#ff2222', '#00ff88', '#2244ff', '#ffcc22']) {
      s.coverColor = cover;
      for (const background of ['#171718', '#000000', '#203d49', '#402d31']) {
        const vars = api.lyricPageColorVariables(s.accentColor, background);
        assert.equal(vars['--text-main'], '#ffffff');
        for (const surface of [background, api.mixColor(background, '#ffffff', 0.1)]) {
          assert.ok(api.contrast(vars['--text-secondary'], surface) >= 4.5);
          assert.ok(api.contrast(vars['--color-primary-text'], surface) >= 4.5);
        }
        assert.equal(vars['--floating-text-main'], undefined);
        assert.equal(vars['--floating-accent-text'], undefined);
      }
    }
  }
});

test('neutral skin uses clear mode-specific foregrounds on the composited shell and panels', () => {
  const s = store();
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode });
    assert.equal(s.accentColor, '#00cc65');
    assert.equal(s.appearance.tokens.text, mode === 'dark' ? '#ffffff' : '#000000');
    assert.equal(s.appearance.tokens.shell, mode === 'dark' ? '#171718' : '#f6f6f6');
    for (const surface of s.accentSurfaces) {
      assert.ok(api.contrast(s.cssTokens['--text-main'], surface) >= 7);
      assert.ok(api.contrast(s.cssTokens['--text-secondary'], surface) >= 4.5);
      assert.ok(api.contrast(s.accentTextColor, surface) >= 4.5);
    }
  }
});

test('cover colors retain distinct accents and readable text across neutral panels and atmosphere strengths', () => {
  const s = store();
  const covers = ['#dd3322', '#3377dd', '#55aa22', '#ddcc11', '#cc22cc', '#ffffff', '#000000'];
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode, accent: { source: 'cover', color: '#0071e3' } });
    const accents = new Set();
    for (const cover of covers) {
      s.coverColor = cover;
      for (const strength of [20, 100, 200]) {
        s.updateGeneralPreferences({ atmosphere: { source: 'cover', height: 100, strength } });
        accents.add(s.accentColor);
        assert.equal(
          document.documentElement.style.getPropertyValue('--color-primary'),
          s.accentColor,
        );
        assert.equal(
          document.documentElement.style.getPropertyValue('--color-primary-text'),
          s.accentTextColor,
        );
        for (const surface of s.accentSurfaces) {
          assert.ok(
            api.contrast(s.accentTextColor, surface) >= 4.5,
            `${mode} ${cover} ${strength} accent`,
          );
          assert.ok(
            api.contrast(s.cssTokens['--text-secondary'], surface) >= 4.5,
            `${mode} ${cover} ${strength} secondary`,
          );
        }
        const floating = s.resolvedColors.floating;
        assert.ok(api.contrast(s.cssTokens['--floating-accent-text'], floating.background) >= 4.5);
        assert.ok(api.contrast(floating.secondary, floating.card) >= 4.5);
      }
    }
    assert.ok(accents.size >= 5, 'cover accents must not collapse to one neutral color');
  }
});

test('adaptive mode releases a native dark override and continues following OS changes', () => {
  const oldMatchMedia = window.matchMedia,
    oldSend = window.electron.ipcRenderer.send;
  let osDark = false,
    nativeSource = 'dark';
  const messages = [];
  // Electron matchMedia observes nativeTheme.themeSource, including explicit overrides.
  window.matchMedia = (query) =>
    query.includes('prefers-color-scheme')
      ? { matches: nativeSource === 'dark' || (nativeSource === 'system' && osDark) }
      : oldMatchMedia(query);
  window.electron.ipcRenderer.send = (channel, source) => {
    if (channel === 'update-theme') {
      nativeSource = source;
      messages.push(source);
    }
  };
  try {
    const s = store();
    assert.equal(s.isDark, true);
    s.applyCurrent();
    assert.equal(messages.at(-1), 'system');
    s.onThemeChange();
    assert.equal(s.isDark, false);
    s.updateGeneralPreferences({ mode: 'dark' });
    assert.equal(nativeSource, 'dark');
    s.onThemeChange();
    s.updateGeneralPreferences({ mode: 'system' });
    s.selectTheme('host:echo');
    s.onThemeChange();
    assert.equal(nativeSource, 'system');
    assert.equal(s.isDark, false);
    osDark = true;
    s.onThemeChange();
    assert.equal(s.isDark, true);
    assert.equal(nativeSource, 'system');
    osDark = false;
    s.onThemeChange();
    assert.equal(s.isDark, false);
    assert.equal(nativeSource, 'system');
  } finally {
    window.matchMedia = oldMatchMedia;
    window.electron.ipcRenderer.send = oldSend;
  }
});
test('explicit display preferences and theme defaults resolve native mode sources independently of system color', () => {
  const s = store();
  const light = register('light-variant', { defaultMode: 'light' });
  const dark = register('dark-variant', { defaultMode: 'dark' });
  s.updateGeneralPreferences({ mode: 'theme' });
  for (const systemDark of [false, true]) {
    s.systemDark = systemDark;
    for (const [key, source] of [
      ['host:echo', 'system'],
      ['host:solid', 'system'],
      [light.key, 'light'],
      [dark.key, 'dark'],
    ]) {
      s.selectTheme(key);
      assert.equal(s.nativeThemeSource, source);
      s.updateGeneralPreferences({ mode: 'light' });
      assert.equal(s.nativeThemeSource, 'light');
      assert.equal(s.isDark, false);
      s.updateGeneralPreferences({ mode: 'dark' });
      assert.equal(s.nativeThemeSource, 'dark');
      assert.equal(s.isDark, true);
      s.updateGeneralPreferences({ mode: 'system' });
      assert.equal(s.nativeThemeSource, 'system');
      assert.equal(s.isDark, systemDark);
      s.updateGeneralPreferences({ mode: 'theme' });
    }
  }
});
test('sidebar resolves the outer framework background independently of the player surface', () => {
  const s = store();
  const p = register('shared-frame', {
    variants: {
      light: {
        tokens: { ...api.neutralTokens(false), sidebar: '#eeeeee', player: '#ccddee' },
        background: { color: '#ddeeff' },
      },
      dark: {
        tokens: { ...api.neutralTokens(true), sidebar: '#444444', player: '#223344' },
        background: { color: '#112233', gradient: 'linear-gradient(#112233, #334455)' },
      },
    },
  });
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode });
    for (const key of [...api.builtinAppThemes.map((e) => e.key), p.key]) {
      s.selectTheme(key);
      const frame = s.appearance.background?.color ?? s.appearance.tokens.shell;
      assert.equal(s.appearance.tokens.sidebar, frame);
      assert.equal(s.cssTokens['--surface-sidebar-base'], frame);
      assert.notEqual(s.appearance.tokens.sidebar, s.appearance.tokens.player);
    }
    s.selectTheme('host:solid');
    s.updateOverride({
      palette: { source: 'custom', color: '#ce929c' },
    });
    s.updateGeneralPreferences({ transparency: 45 });
    assert.equal(s.appearance.tokens.sidebar, s.appearance.tokens.shell);
    assert.notEqual(s.appearance.tokens.sidebar, s.appearance.tokens.player);
    assert.equal(s.surfaceVariables['--surface-player-opacity'], '50%');
  }
});
test('display modes are preferences, built-in themes are palettes, and previews isolate theme edits', () => {
  const s = store();
  assert.deepEqual(s.preferences, api.defaultAppearance());
  assert.equal(s.preferences.mode, 'system');
  assert.deepEqual(
    api.builtinAppThemes.map((t) => t.title),
    ['Echo', '纯色', '自定义'],
  );
  s.beginPreview();
  s.selectTheme('host:solid');
  s.updateOverride({ palette: { source: 'custom', color: '#d68fab' } });
  assert.equal(s.preferences.themeKey, 'host:echo');
  assert.equal(s.preferences.mode, 'system');
  s.cancelPreview();
  assert.equal(s.desiredThemeKey, 'host:echo');
  s.beginPreview();
  s.selectTheme('host:solid');
  s.updateOverride({ palette: { source: 'custom', color: '#d68fab' } });
  s.applyPreview();
  assert.equal(s.preferences.themeKey, 'host:solid');
  s.beginPreview();
  s.selectTheme('host:echo');
  assert.equal(s.override.palette.source, 'theme');
  s.selectTheme('host:solid');
  assert.equal(s.override.palette.color, '#d68fab');
  s.cancelPreview();
  for (const mode of ['system', 'light', 'dark']) {
    s.updateGeneralPreferences({ mode });
    s.selectTheme('host:echo');
    s.selectTheme('host:solid');
    assert.equal(s.preferences.mode, mode);
  }
});
test('theme packages share type categories across providers and custom backgrounds stay outside the catalog', () => {
  const dynamic = register('dynamic-package', { type: 'dynamic' });
  assert.throws(() => register('removed-effects', { type: 'effects' }));
  const solid = register('solid-package', { type: 'solid' });
  const ordinary = register('ordinary-package');
  assert.equal(api.appThemeType(api.resolveAppTheme(dynamic.key)), 'dynamic');
  assert.equal(api.appThemeType(api.resolveAppTheme(solid.key)), 'solid');
  assert.equal(api.appThemeType(api.resolveAppTheme(ordinary.key)), 'default');
  assert.equal(
    api.catalogAppThemes.value.some((entry) => entry.key === api.CUSTOM_THEME_KEY),
    false,
  );
  assert.ok(api.resolveAppTheme(api.CUSTOM_THEME_KEY));
  const solidPackages = api.catalogAppThemes.value.filter(
    (entry) => api.appThemeType(entry) === 'solid',
  );
  assert.deepEqual(
    solidPackages.map((entry) => entry.key),
    ['host:solid', solid.key],
  );
  for (const type of ['plugin', 'image', 'animated']) {
    assert.throws(() => ordinary.registry.register({ ...ordinary.entry, type }), /主题类型无效/);
  }
  dynamic.dispose();
  assert.equal(
    api.catalogAppThemes.value.some((entry) => entry.key === dynamic.key),
    false,
  );
});
test('custom image is an independent skin and switching back restores the solid skin unchanged', () => {
  const s = store();
  const solid = api.resolveAppTheme('host:solid');
  assert.equal(solid.title, '纯色');
  s.beginPreview();
  s.selectTheme(solid.key);
  s.updateOverride({ palette: { source: 'custom', color: '#bd97bb' } });
  assert.equal(s.desiredThemeKey, 'host:solid');
  const palette = api.copyAppearance(s.appearance.tokens);
  assert.throws(
    () =>
      s.updateOverride({
        background: { ...s.override.background, source: 'image', image: 'background.png' },
      }),
    /自定义皮肤/,
  );
  s.setCustomBackground('background.png');
  assert.equal(s.desiredThemeKey, api.CUSTOM_THEME_KEY);
  assert.equal(s.override.background.image, 'background.png');
  assert.equal(s.backgroundImage, 'background.png');
  assert.notDeepEqual(s.appearance.tokens, palette);
  assert.equal(s.override.palette.source, 'theme');
  s.applyPreview();
  s.selectTheme('host:echo');
  s.selectTheme('host:solid');
  assert.equal(s.override.palette.color, '#bd97bb');
  assert.deepEqual(s.appearance.tokens, palette);
  assert.equal(s.override.background.image, '');
  assert.equal(s.backgroundImage, '');
  s.selectTheme(api.CUSTOM_THEME_KEY);
  assert.equal(s.override.background.image, 'background.png');
});
test('solid theme colors remain visible with fixed material and window transparency', () => {
  const s = store();
  s.selectTheme('host:solid');
  s.updatePreferences({ mode: 'light' });
  for (const color of ['#ce929c', '#6b9bd1', '#87a793']) {
    s.updateOverride({ palette: { source: 'custom', color } });
    const tokens = s.appearance.tokens;
    assert.ok(
      api.contrast(tokens.main, '#ffffff') >= 1.5,
      `${color} content must retain its color`,
    );
    assert.equal(tokens.player, tokens.main);
    assert.equal(tokens.sidebar, tokens.shell);
    assert.notEqual(tokens.sidebar, tokens.player);
    assert.equal(s.cssTokens['--surface-main-base'], tokens.main);
    assert.equal(s.cssTokens['--surface-player-base'], tokens.player);
    s.updateGeneralPreferences({ transparency: 45 });
    assert.deepEqual(s.appearance.tokens, tokens);
    assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
    assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
  }
});
test('background cancellation restores the theme draft while global material changes stay saved', () => {
  const s = store();
  s.beginPreview();
  const before = api.copyAppearance(s.activePreferences);
  s.updateGeneralPreferences({ transparency: 55 });
  s.restoreThemeDraft(before);
  assert.deepEqual(s.preview, s.preferences);
  assert.deepEqual(s.activePreferences.overrides, {});
  s.selectTheme('host:solid');
  s.updateOverride({ palette: { source: 'custom', color: '#bd97bb' } });
  const draft = api.copyAppearance(s.activePreferences);
  s.setCustomBackground('draft.png');
  s.restoreThemeDraft(draft);
  assert.deepEqual(s.activePreferences, draft);
  assert.notDeepEqual(s.preview, s.preferences);
});
test('custom skin confirmation, cancellation and reset preserve the image identity independently of plugin skins', () => {
  const p = register('custom-independent', {
    decorations: { background: { name: 'PluginBackground' } },
  });
  const s = store();
  s.selectTheme(p.key);
  s.updateThemeSettings({});
  s.beginPreview();
  s.setCustomBackground('first.png');
  assert.equal(s.currentTheme.pluginId, 'host');
  assert.equal(s.currentTheme.decorations, undefined);
  s.cancelPreview();
  assert.equal(s.desiredThemeKey, p.key);
  assert.equal(s.preferences.overrides[api.CUSTOM_THEME_KEY], undefined);
  s.beginPreview();
  s.setCustomBackground('saved.png');
  s.applyPreview();
  s.updateGeneralPreferences({ transparency: 75 });
  s.updateOverride({ background: { ...s.override.background, positionX: 20 } });
  s.resetAppearanceAdjustments();
  assert.equal(s.desiredThemeKey, api.CUSTOM_THEME_KEY);
  assert.equal(s.override.background.image, 'saved.png');
  assert.equal(s.override.background.positionX, 20);
  assert.equal(s.windowTransparency, 0);
  s.beginPreview();
  s.setCustomBackground('replacement.png');
  s.cancelPreview();
  assert.equal(s.override.background.image, 'saved.png');
  s.selectTheme(p.key);
  assert.equal(s.currentTheme.decorations.background.name, 'PluginBackground');
});
test('resetting untouched skin effects creates no artificial theme draft', () => {
  const s = store();
  s.beginPreview();
  s.updateGeneralPreferences({ transparency: api.defaultAppearance().transparency });
  assert.deepEqual(s.preview.overrides, {});
  s.updateGeneralPreferences({ transparency: 50 });
  s.updateGeneralPreferences({ transparency: api.defaultAppearance().transparency });
  assert.deepEqual(s.preview.overrides, {});
});
test('cover atmosphere follows cover colors independently of the shared accent and skin transparency', () => {
  const s = store();
  s.updateGeneralPreferences({
    accent: { source: 'custom', color: '#0055bb' },
    atmosphere: { source: 'cover', height: 85, strength: 140 },
  });
  s.coverColor = '#bb6633';
  s.applyCurrent();
  const warm = document.body.style.getPropertyValue('--accent-gradient-color-rgb');
  const accent = document.documentElement.style.getPropertyValue('--color-atmosphere-rgb');
  assert.ok(warm);
  assert.notEqual(warm, accent);
  assert.equal(s.sourceColor, '#0055bb');
  assert.equal(document.documentElement.style.getPropertyValue('--color-primary'), s.accentColor);
  s.updateGeneralPreferences({ transparency: 60 });
  assert.equal(document.body.style.getPropertyValue('--accent-gradient-color-rgb'), warm);
  s.coverColor = '#339966';
  s.applyCurrent();
  assert.notEqual(document.body.style.getPropertyValue('--accent-gradient-color-rgb'), warm);
  s.updateGeneralPreferences({ atmosphere: { source: 'off', height: 85, strength: 140 } });
  assert.equal(document.body.style.getPropertyValue('--accent-gradient-color-rgb'), '');
});
test('general appearance changes persist independently of theme and nested editor cancellation', () => {
  const s = store();
  s.beginPreview();
  s.selectTheme('host:solid');
  s.updateOverride({ palette: { source: 'custom', color: '#ce929c' } });
  const beforeEditor = api.copyAppearance({
    themeKey: s.activePreferences.themeKey,
    overrides: s.activePreferences.overrides,
  });
  s.updateGeneralPreferences({ transparency: 50 });
  const general = {
    mode: 'dark',
    atmosphere: { source: 'cover', height: 80, strength: 120 },
  };
  s.updateGeneralPreferences(general);
  s.setCustomColor('#225588');
  s.restoreThemeDraft(beforeEditor);
  assert.deepEqual(s.activePreferences.overrides, beforeEditor.overrides);
  assert.equal(s.windowTransparency, 50);
  for (const [key, value] of Object.entries(general)) {
    assert.deepEqual(s.preferences[key], value);
    assert.deepEqual(s.activePreferences[key], value);
  }
  assert.equal(s.activePreferences.accent.color, '#225588');
  s.cancelPreview();
  assert.equal(s.preferences.themeKey, 'host:echo');
  assert.deepEqual(s.preferences.overrides, {});
  assert.equal(s.isDark, true);
  assert.equal(s.floatingSurfaceFrosted, false);
  assert.equal(s.preferences.accent.color, '#225588');
});
test('applying and resetting theme parameters preserves palette and global appearance preferences', () => {
  const s = store();
  s.beginPreview();
  s.selectTheme('host:solid');
  s.updateOverride({ palette: { source: 'custom', color: '#ce929c' } });
  s.updateGeneralPreferences({ mode: 'light' });
  s.setMode('cover');
  s.applyPreview();
  assert.equal(s.preferences.themeKey, 'host:solid');
  assert.equal(s.override.palette.color, '#ce929c');
  assert.equal(s.preferences.accent.source, 'cover');
  assert.equal(s.preferences.mode, 'light');
  s.beginPreview();
  s.resetThemeSettings();
  s.applyPreview();
  assert.equal(s.override.palette.color, '#ce929c');
  assert.equal(s.floatingSurfaceFrosted, false);
  assert.equal(s.preferences.accent.source, 'cover');
  assert.equal(s.preferences.mode, 'light');
});
test('standard themes retain fixed panel material without a global panel preference', () => {
  const s = store();
  assert.equal('surfaces' in s.preferences, false);
  assert.equal('setPanelEffect' in s, false);
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  assert.equal(s.surfaceVariables['--surface-player-opacity'], '50%');
  assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
  assert.equal(s.floatingSurfaceFrosted, false);
});
test('custom panel opacity previews, saves and cancels independently of global transparency', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  s.setCustomBackgroundSample('landscape.png', '#8b9879');
  s.updateGeneralPreferences({ transparency: 40 });
  assert.equal(s.panelOpacity, 50);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, panelOpacity: 0, zoom: 135 } });
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '0%');
  assert.equal(s.surfaceVariables['--surface-player-opacity'], '0%');
  assert.equal(s.surfaceVariables['--surface-sidebar-opacity'], '50%');
  assert.equal(s.windowTransparency, 40);
  assert.equal(s.override.background.zoom, 135);
  s.cancelPreview();
  assert.equal(s.panelOpacity, 50);
  assert.equal(s.override.background.zoom, 110);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, panelOpacity: 85, zoom: 150 } });
  s.applyPreview();
  assert.equal(s.preferences.overrides[api.CUSTOM_THEME_KEY].background.panelOpacity, 85);
  s.selectTheme('host:echo');
  assert.equal(s.panelOpacity, 50);
  s.selectTheme(api.CUSTOM_THEME_KEY);
  assert.equal(s.panelOpacity, 85);
  assert.equal(s.override.background.zoom, 150);
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '85%');
  assert.equal(s.surfaceVariables['--surface-player-opacity'], '85%');
  assert.equal(s.windowTransparency, 40);
});

test('old image preferences gain safe defaults and invalid zoom and panel opacity are bounded', () => {
  const legacy = api.defaultOverride();
  delete legacy.background.zoom;
  delete legacy.background.panelOpacity;
  assert.equal(api.normalizeOverride(legacy).background.zoom, 110);
  assert.equal(api.normalizeOverride(legacy).background.panelOpacity, 50);
  for (const [zoom, opacity, expectedZoom, expectedOpacity] of [
    [70, -20, 100, 0],
    [300, 140, 200, 100],
  ]) {
    const value = api.normalizeOverride({
      ...legacy,
      background: { ...legacy.background, zoom, panelOpacity: opacity },
    });
    assert.equal(value.background.zoom, expectedZoom);
    assert.equal(value.background.panelOpacity, expectedOpacity);
  }
});

test('custom panel opacity participates in contrast calculations without recoloring floating surfaces', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  s.setCustomBackgroundSample('landscape.png', '#8b9879');
  const floating = api.copyAppearance(s.appearance.floating);
  for (const panelOpacity of [0, 50, 100]) {
    s.updateOverride({ background: { ...s.override.background, panelOpacity } });
    const surfaces = s.accentSurfaces;
    assert.equal(
      surfaces[0],
      api.mixColor(s.appearance.tokens.shell, s.appearance.tokens.main, panelOpacity / 100),
    );
    assert.deepEqual(s.appearance.floating, floating);
  }
});
test('window transparency survives theme switching and background cancellation and resets independently', () => {
  const plugin = register('global-material', { settings: { defaults: { texture: 20 } } });
  const s = store();
  s.updateGeneralPreferences({ transparency: 40 });
  s.beginPreview();
  s.updateGeneralPreferences({ transparency: 55 });
  s.cancelPreview();
  assert.equal(s.windowTransparency, 55);
  for (const key of ['host:echo', 'host:solid', api.CUSTOM_THEME_KEY, plugin.key]) {
    s.selectTheme(key);
    assert.equal(s.windowTransparency, 55);
    assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
    assert.equal(s.surfaceVariables['--surface-player-opacity'], '50%');
  }
  s.updateThemeSettings({ texture: 55 });
  s.updateGeneralPreferences({ transparency: 40 });
  s.resetThemeSettings();
  assert.equal(s.themeSettings.texture, 20);
  assert.equal(s.windowTransparency, 40);
  s.updateThemeSettings({ texture: 55 });
  s.updateGeneralPreferences({ mode: 'dark', accent: { source: 'custom', color: '#225588' } });
  const overrides = api.copyAppearance(s.preferences.overrides);
  s.resetAppearanceAdjustments();
  assert.equal(s.preferences.themeKey, plugin.key);
  assert.equal(s.preferences.mode, 'dark');
  assert.deepEqual(s.preferences.overrides, overrides);
  assert.equal(s.themeSettings.texture, 55);
  assert.equal(s.preferences.accent.source, 'theme');
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
});
test('fixed panel material and global atmosphere remain identical across theme backgrounds and display modes', () => {
  const plugin = register('material-defaults', {
    variants: {
      light: {
        tokens: api.neutralTokens(false),
        background: { gradient: 'linear-gradient(#ffffff, #dddddd)' },
      },
      dark: { tokens: api.neutralTokens(true), background: { color: '#111111' } },
    },
  });
  const s = store();
  for (const source of ['off', 'cover']) {
    s.updateGeneralPreferences({ atmosphere: { source, height: 80, strength: 120 } });
    s.updateGeneralPreferences({ transparency: 40 });
    for (const key of ['host:echo', 'host:solid', api.CUSTOM_THEME_KEY, plugin.key]) {
      s.selectTheme(key);
      for (const mode of ['light', 'dark']) {
        s.updateGeneralPreferences({ mode });
        assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
        assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
        assert.equal(s.preferences.atmosphere.source, source);
        assert.equal(document.body.style.getPropertyValue('--accent-gradient-user-height'), '80%');
      }
    }
  }
  s.resetAppearanceAdjustments();
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  assert.equal(s.preferences.atmosphere.source, 'off');
});
test('window transparency does not change fixed panel material and remains global through skin previews', () => {
  const s = store();
  s.updateGeneralPreferences({ transparency: 40 });
  for (const transparency of [0, 40, 75, 100]) {
    s.updateGeneralPreferences({ transparency });
    assert.equal(s.windowTransparency, transparency);
    assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
    assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
    assert.equal(s.surfaceVariables['--surface-player-opacity'], '50%');
  }
  s.beginPreview();
  s.selectTheme(api.CUSTOM_THEME_KEY);
  s.updateGeneralPreferences({ transparency: 50 });
  s.cancelPreview();
  assert.equal(s.preferences.transparency, 50);
  s.selectTheme('host:solid');
  assert.equal(s.windowTransparency, 50);
  s.resetAppearanceAdjustments();
  assert.equal(s.windowTransparency, 0);
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
});
test('custom image stays selected and starts sharp independently of global transparency', () => {
  const s = store();
  s.setCustomBackground('custom-image.png');
  for (const transparency of [0, 40, 100]) {
    s.updateGeneralPreferences({ transparency });
    assert.equal(s.backgroundImage, 'custom-image.png');
    assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
    assert.equal(s.surfaceVariables['--surface-player-backdrop-filter'], 'none');
  }
  s.updateGeneralPreferences({ windowFrosted: true });
  s.updateGeneralPreferences({ transparency: 0 });
  assert.equal(s.activePreferences.windowFrosted, true);
  s.beginPreview();
  s.selectTheme('host:echo');
  s.cancelPreview();
  assert.equal(s.activePreferences.windowFrosted, true);
  s.resetAppearanceAdjustments();
  assert.equal(s.activePreferences.windowFrosted, false);
  assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
});
test('free image crops persist, preview reversibly and clear when replacing the source image', () => {
  const s = store();
  s.setCustomBackground('first-image.png');
  const crop = { x: 100, y: 200, width: 600, height: 300, sourceWidth: 1600, sourceHeight: 900 };
  s.updateOverride({ background: { ...s.override.background, crop } });
  const saved = api.copyAppearance(s.preferences);
  const restored = store();
  restored.preferences = saved;
  assert.deepEqual(restored.override.background.crop, crop);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, crop: { ...crop, width: 400 } } });
  assert.equal(s.override.background.crop.width, 400);
  assert.equal(s.preferences.overrides[api.CUSTOM_THEME_KEY].background.crop.width, 600);
  s.cancelPreview();
  assert.deepEqual(s.override.background.crop, crop);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, crop: { ...crop, height: 500 } } });
  s.applyPreview();
  assert.equal(s.preferences.overrides[api.CUSTOM_THEME_KEY].background.crop.height, 500);
  s.beginPreview();
  s.setCustomBackground('second-image.png');
  assert.equal(s.override.background.crop, null);
  s.cancelPreview();
  assert.equal(s.backgroundImage, 'first-image.png');
  assert.equal(s.override.background.crop.height, 500);
  s.updateOverride({
    background: {
      ...s.override.background,
      ...api.defaultOverride().background,
      source: 'image',
      image: s.backgroundImage,
    },
  });
  assert.equal(s.override.background.crop, null);
  assert.equal(s.backgroundImage, 'first-image.png');
});
test('floating frosting persists independently across window transparency changes, themes and cancelled image previews', () => {
  const s = store();
  assert.equal(s.floatingSurfaceFrosted, false);
  s.updateGeneralPreferences({ floatingSurfaceFrosted: true });
  for (const transparency of [0, 50, 100]) {
    s.updateGeneralPreferences({ transparency });
    assert.equal(s.floatingSurfaceFrosted, true);
  }
  s.beginPreview();
  s.selectTheme(api.CUSTOM_THEME_KEY);
  s.updateGeneralPreferences({ floatingSurfaceFrosted: false });
  s.cancelPreview();
  assert.equal(s.preferences.floatingSurfaceFrosted, false);
  assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
  s.updateGeneralPreferences({ floatingSurfaceFrosted: true });
  const saved = api.copyAppearance(s.preferences);
  const restored = store();
  restored.preferences = saved;
  restored.applyCurrent();
  assert.equal(restored.floatingSurfaceFrosted, true);
  restored.selectTheme('host:solid');
  assert.equal(restored.floatingSurfaceFrosted, true);
  restored.resetAppearanceAdjustments();
  assert.equal(restored.floatingSurfaceFrosted, false);
  assert.equal(restored.preferences.themeKey, 'host:solid');
});
test('generated palettes terminate and preserve readable text for extreme and saturated seeds', () => {
  for (const dark of [false, true])
    for (const seed of [
      '#000000',
      '#ffffff',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#ffff00',
      '#ee99cc',
    ]) {
      const t = api.paletteFromSeed(seed, dark);
      for (const key of ['shell', 'sidebar', 'main', 'card', 'player', 'elevated']) {
        assert.ok(api.contrast(t.text, t[key]) >= 4.5, `${dark} ${seed} text on ${key}`);
        assert.ok(api.contrast(t.secondary, t[key]) >= 4.5, `${dark} ${seed} secondary on ${key}`);
      }
    }
});
test('disabled plugin keeps desired key and settings, reinstatement recovers, stale dispose cannot remove replacement', () => {
  const p = register();
  const s = store();
  s.selectTheme(p.key);
  s.updateGeneralPreferences({ transparency: 45 });
  p.dispose();
  assert.equal(s.desiredThemeKey, p.key);
  assert.equal(s.effectiveThemeKey, 'host:echo');
  assert.equal(s.windowTransparency, 45);
  const d = p.registry.register(p.entry);
  p.dispose();
  assert.equal(s.effectiveThemeKey, p.key);
  assert.equal(s.windowTransparency, 45);
  d();
  assert.equal(s.effectiveThemeKey, 'host:echo');
});
test('theme errors are isolated by revision and retry is deliberate', () => {
  const p = register('broken', {
    resolve: () => {
      throw new Error('broken');
    },
  });
  const s = store();
  s.selectTheme(p.key);
  void s.appearance;
  assert.equal(s.effectiveThemeKey, 'host:echo');
  for (let i = 0; i < 5; i++) void s.appearance;
  assert.equal(p.errors.length, 1);
  api.retryAppTheme(p.key);
  void s.appearance;
  assert.equal(p.errors.length, 2);
  assert.equal(s.effectiveThemeKey, 'host:echo');
});
test('settings validate before mutation and store only differences from defaults', () => {
  const p = register('config', {
    settings: { defaults: { size: 2 }, validate: (values) => values.size >= 1 && values.size <= 4 },
  });
  const s = store();
  s.selectTheme(p.key);
  s.updateThemeSettings({ size: 3 });
  assert.deepEqual(s.override.settings, { size: 3 });
  assert.throws(() => s.updateThemeSettings({ size: 9 }));
  assert.equal(s.themeSettings.size, 3);
  s.updateThemeSettings({ size: 2 });
  assert.deepEqual(s.override.settings, {});
  s.removePluginThemes('config');
  assert.equal(s.preferences.themeKey, 'host:echo');
  assert.equal(s.preferences.overrides[p.key], undefined);
});
test('theme registration checks capability, colors, synchronous resolution and JSON settings', () => {
  assert.throws(() =>
    api
      .createAppThemeApi(
        'blocked',
        () => {},
        () => {},
        false,
      )
      .register({}),
  );
  assert.throws(() =>
    register('bad', {
      variants: { light: { tokens: { main: 'no-color' } }, dark: { tokens: {} } },
    }),
  );
  assert.throws(() => register('bad-default', { settings: { defaults: { callback: () => {} } } }));
  const p = register('async', { resolve: () => Promise.resolve({ tokens: { main: '#ffffff' } }) });
  const s = store();
  s.selectTheme(p.key);
  assert.equal(s.effectiveThemeKey, 'host:echo');
  assert.equal(p.errors.length, 1);
});
test('top shortcuts and lower menu settings reset independently and retain inactive plugin positions', () => {
  const pluginKey = JSON.stringify(['plugin', 'card']);
  const layout = {
    ...api.emptySidebarLayout(),
    shortcutKeys: ['explore', pluginKey, 'home', 'purchased'],
    hiddenItems: { history: true },
    sectionOrder: ['library'],
    itemOrder: { library: ['cloud', 'favorites'] },
  };
  const reset = api.resetSidebarMenus(layout);
  assert.deepEqual(reset.shortcutKeys, layout.shortcutKeys);
  assert.deepEqual(reset.hiddenItems, {});
  assert.deepEqual(api.normalizeShortcutKeys(['purchased', 'purchased']), ['purchased']);
  assert.deepEqual(
    api.reorderShortcutKeys(
      layout.shortcutKeys,
      ['explore', 'home', 'purchased'],
      ['purchased', 'explore', 'home'],
    ),
    ['purchased', pluginKey, 'explore', 'home'],
  );
  assert.deepEqual(
    api.reorderShortcutKeys(layout.shortcutKeys, ['explore', 'home'], ['home', 'home']),
    layout.shortcutKeys,
  );
  assert.deepEqual(layout.hiddenItems, { history: true });
});

test('legacy plugin surfaces cannot replace fixed host panel material', () => {
  const s = store();
  const apiTheme = api.createThemeApi(
    'legacy',
    (d) => {
      disposers.push(d);
      return d;
    },
    () => {},
    false,
  );
  const remove = apiTheme.surface.set({ mainOpacity: 74, backdropFilter: 'blur(12px)' });
  s.applyCurrent();
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  assert.equal(document.body.style.getPropertyValue('--surface-main-opacity'), '');
  s.updateGeneralPreferences({ transparency: 20 });
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  assert.equal(s.surfaceVariables['--surface-backdrop-filter'], 'none');
  const p = register('global');
  s.selectTheme(p.key);
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  remove();
  assert.deepEqual(api.legacySurfaceVariables.value, {});
});

const { createRenderer, defineComponent, h, nextTick, isReadonly } = require('vue');
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null });
const renderer = createRenderer({
  createElement: node,
  createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text),
  setText: (el, text) => (el.text = text),
  setElementText: (el, text) => {
    el.text = text;
    el.children = [];
  },
  parentNode: (el) => el.parent,
  nextSibling: (el) => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, old, value) => (el.props[key] = value),
  insert(el, parent, anchor = null) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = parent;
    const i = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(i < 0 ? parent.children.length : i, 0, el);
  },
  remove(el) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = null;
  },
});
function mountTheme(s, layer) {
  const root = node('root');
  const app = renderer.createApp(
    defineComponent({
      setup: () => () =>
        h(api.ThemeContent, { key: s.currentTheme.key + s.currentTheme.revision, layer }),
    }),
  );
  app.mount(root);
  return { app, root };
}
test('real theme settings component receives readonly context and stale handles cannot update a replacement', async () => {
  let context;
  const component = defineComponent({
    setup() {
      context = api.useAppTheme();
      return () => h('label', String(context.settings.value.size));
    },
  });
  const p = register('context', { settings: { defaults: { size: 2 }, component } });
  const s = store();
  s.selectTheme(p.key);
  const view = mountTheme(s, 'settings');
  assert.equal(isReadonly(context.settings.value), true);
  assert.equal(context.motionEnabled.value, false);
  context.updateSettings({ size: 3 });
  await nextTick();
  assert.equal(s.themeSettings.size, 3);
  const stale = context;
  p.registry.register(p.entry);
  assert.throws(() => stale.updateSettings({ size: 4 }));
  await nextTick();
  assert.equal(s.themeSettings.size, 3);
  view.app.unmount();
});
test('theme component exception falls back once and unmounts the failed revision', async () => {
  const component = defineComponent({
    setup() {
      throw new Error('component failed');
    },
  });
  const p = register('component-error', { decorations: { background: component } });
  const s = store();
  s.selectTheme(p.key);
  const view = mountTheme(s, 'background');
  await nextTick();
  assert.equal(s.effectiveThemeKey, 'host:echo');
  assert.equal(p.errors.length, 1);
  view.app.unmount();
});

test('theme package accent is preserved exactly rather than normalized like extracted cover colors', () => {
  const plugin = register('qq-palette', {
    variants: {
      light: { tokens: {}, accent: '#F1CF0B' },
      dark: { tokens: {}, accent: '#F1CF0B' },
    },
  });
  const s = store();
  s.selectTheme(plugin.key);
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode });
    assert.equal(s.accentColor.toLowerCase(), '#f1cf0b');
    assert.equal(document.documentElement.style.getPropertyValue('--color-primary'), '#f1cf0b');
  }
});

test('custom background surfaces use the sampled image color and reject stale samples', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  s.updateGeneralPreferences({ mode: 'light', transparency: 40 });
  s.updateOverride({ background: { ...s.override.background, textColor: '#000000' } });
  s.setCustomBackgroundSample('landscape.png', '#8b9879');
  assert.equal(s.appearance.tokens.main, api.paletteFromSeed('#8b9879', false).main);
  assert.equal(s.appearance.tokens.player, s.appearance.tokens.main);
  assert.notEqual(s.appearance.tokens.main, '#ffffff');
  assert.equal(s.surfaceVariables['--surface-main-opacity'], '50%');
  assert.equal(s.windowTransparency, 40);
  s.updateGeneralPreferences({ mode: 'dark' });
  s.updateOverride({ background: { ...s.override.background, textColor: '#ffffff' } });
  assert.equal(s.appearance.tokens.main, api.paletteFromSeed('#8b9879', true).main);
  s.setCustomBackground('new-image.png');
  s.setCustomBackgroundSample('landscape.png', '#ff0000');
  assert.equal(s.appearance.tokens.main, api.neutralTokens(true).main);
  s.setCustomBackgroundSample('new-image.png', '#668899');
  s.selectTheme('host:echo');
  s.setCustomBackgroundSample('new-image.png', '#ff0000');
  assert.equal(s.appearance.tokens.main, api.neutralTokens(true).main);
  s.selectTheme('host:custom');
  assert.equal(s.appearance.tokens.main, api.paletteFromSeed('#668899', true).main);
});

test('image sampling leaves floating surfaces readable for either custom foreground', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  for (const mode of ['light', 'dark']) {
    s.updateGeneralPreferences({ mode });
    s.updateOverride({
      background: { ...s.override.background, textColor: mode === 'dark' ? '#ffffff' : '#000000' },
    });
    const neutral = api.neutralTokens(mode === 'dark');
    for (const color of ['#8b9879', '#ffffff', '#000000', '#ff00ff']) {
      s.setCustomBackgroundSample('landscape.png', color);
      for (const key of ['elevated', 'card', 'border'])
        assert.equal(s.appearance.tokens[key], neutral[key]);
      assert.equal(s.cssTokens['--surface-dialog-base'], neutral.elevated);
      assert.ok(api.contrast(s.appearance.tokens.text, s.appearance.tokens.elevated) >= 7);
      for (const floatingSurfaceFrosted of [false, true]) {
        s.updateGeneralPreferences({ floatingSurfaceFrosted, transparency: 90 });
        assert.equal(s.cssTokens['--surface-elevated-base'], neutral.elevated);
        assert.equal(s.surfaceVariables['--surface-elevated-opacity'], '100%');
      }
    }
  }
});

test('custom foreground defaults to white, previews reversibly and preserves general display mode', () => {
  const s = store();
  s.updateGeneralPreferences({ mode: 'light' });
  s.setCustomBackground('landscape.png');
  assert.equal(s.override.background.textColor, '#ffffff');
  assert.equal(s.isDark, false);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, textColor: '#000000' } });
  assert.equal(s.isDark, false);
  s.cancelPreview();
  assert.equal(s.isDark, false);
  s.beginPreview();
  s.updateOverride({ background: { ...s.override.background, textColor: '#000000' } });
  s.applyPreview();
  assert.equal(s.preferences.overrides[api.CUSTOM_THEME_KEY].background.textColor, '#000000');
  s.selectTheme('host:echo');
  assert.equal(s.nativeThemeSource, 'light');
  assert.equal(s.preferences.mode, 'light');
  s.selectTheme(api.CUSTOM_THEME_KEY);
  assert.equal(s.override.background.textColor, '#000000');
});

test('custom text edits preserve panel tints, controls and floating surfaces across display modes', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  s.setCustomBackgroundSample('landscape.png', '#8b9879');
  for (const mode of ['light', 'dark', 'system']) {
    s.updateGeneralPreferences({ mode });
    for (const systemDark of [false, true]) {
      s.systemDark = systemDark;
      const surfaceColors = () =>
        Object.fromEntries(
          Object.entries(s.cssTokens).filter(
            ([key]) => !['--text-main', '--text-secondary'].includes(key),
          ),
        );
      const before = surfaceColors();
      const surfaces = { ...s.appearance.tokens };
      delete surfaces.text;
      delete surfaces.secondary;
      for (const color of ['#ffffff', '#672dd2', '#000000', '#ffe3a3', '#ff0000']) {
        s.beginPreview();
        s.updateOverride({ background: { ...s.override.background, textColor: color } });
        assert.equal(s.cssTokens['--text-main'], color);
        assert.equal(s.isDark, mode === 'dark' || (mode === 'system' && systemDark));
        assert.deepEqual(surfaceColors(), before);
        for (const [key, value] of Object.entries(surfaces))
          assert.equal(s.appearance.tokens[key], value);
        s.applyPreview();
        assert.deepEqual(surfaceColors(), before);
        s.beginPreview();
        s.updateOverride({ background: { ...s.override.background, textColor: '#447799' } });
        s.cancelPreview();
        assert.equal(s.cssTokens['--text-main'], color);
        assert.deepEqual(surfaceColors(), before);
      }
    }
  }
});

test('arbitrary custom text colors remain exact while floating surfaces keep independent readable text', () => {
  const s = store();
  s.setCustomBackground('landscape.png');
  for (const color of [
    '#ffe3a3',
    '#ffb8c7',
    '#447799',
    '#777777',
    '#ff0000',
    '#ffffff',
    '#000000',
  ]) {
    s.updateOverride({ background: { ...s.override.background, textColor: color } });
    assert.equal(s.appearance.tokens.text, color);
    assert.equal(s.cssTokens['--text-main'], color);
    assert.ok(api.contrast(s.cssTokens['--floating-text-main'], s.appearance.tokens.elevated) >= 7);
  }
  s.updateOverride({ background: { ...s.override.background, textColor: 'invalid' } });
  assert.equal(s.appearance.tokens.text, '#ffffff');
  s.selectTheme('host:echo');
  assert.equal(s.cssTokens['--floating-text-main'], s.appearance.tokens.text);
});

test('partial plugin palettes derive polarity from actual colors and share panel colors', () => {
  const plugin = register('fixed-light-foreground', {
    variants: {
      light: { tokens: { shell: '#d07a00', main: '#e09a32', text: '#ffffff', player: '#ff00ff' } },
      dark: { tokens: { shell: '#d07a00', main: '#e09a32', text: '#ffffff', player: '#ff00ff' } },
    },
  });
  const s = store();
  s.updateGeneralPreferences({ mode: 'light' });
  s.selectTheme(plugin.key);
  assert.equal(s.nativeThemeSource, 'light');
  assert.equal(s.isDark, true);
  assert.equal(s.cssTokens['--content-tone'], '#ffffff');
  assert.equal(s.appearance.tokens.sidebar, s.appearance.tokens.shell);
  assert.equal(s.appearance.tokens.player, s.appearance.tokens.main);
  assert.ok(api.contrast(s.appearance.floating.text, s.appearance.floating.background) >= 4.5);
  s.selectTheme('host:echo');
  assert.equal(s.isDark, false);
  assert.equal(s.cssTokens['--content-tone'], '#000000');
});

test('content and floating palettes have independent polarity and invalid pairs are repaired', () => {
  for (const background of ['#ffffff', '#000000', '#777777', '#d07a00', '#14365a']) {
    const colors = api.resolveThemeColors(
      {
        tokens: { shell: '#202024', text: '#ffe3a3' },
        floating: { background, text: background, secondary: background, card: '#ffffff' },
      },
      false,
    );
    assert.equal(colors.dark, true);
    assert.equal(colors.tokens.text, '#ffe3a3');
    assert.ok(api.contrast(colors.floating.text, colors.floating.background) >= 4.5);
    assert.ok(api.contrast(colors.floating.text, colors.floating.card) >= 4.5);
    assert.ok(api.contrast(colors.floating.secondary, colors.floating.background) >= 4.5);
    assert.ok(api.contrast(colors.floating.secondary, colors.floating.card) >= 4.5);
    assert.equal(
      colors.floatingTone,
      api.usesLightForeground(colors.floating.text) ? '#ffffff' : '#000000',
    );
  }
});

test('theme switching matrix resolves complete colors without rewriting global choices', () => {
  const s = store();
  const plugin = register('matrix-plugin', {
    variants: {
      light: { tokens: { shell: '#eff5f0', text: '#234533' }, floating: { background: '#fffef0' } },
      dark: {
        tokens: { shell: '#16251f', text: '#eaf4ee' },
        floating: { background: '#ffffff', text: '#14221a' },
      },
    },
  });
  for (const mode of ['system', 'light', 'dark']) {
    s.updateGeneralPreferences({ mode, floatingSurfaceFrosted: true, transparency: 45 });
    for (const systemDark of [false, true]) {
      s.systemDark = systemDark;
      for (const seed of ['#ffffff', '#000000', '#777777', '#ff0000', '#00ff00', '#0000ff']) {
        for (const key of ['host:echo', 'host:solid', api.CUSTOM_THEME_KEY, plugin.key]) {
          s.selectTheme(key);
          if (key === 'host:solid')
            s.updateOverride({ palette: { source: 'custom', color: seed } });
          if (key === api.CUSTOM_THEME_KEY) {
            s.setCustomBackground('matrix.png');
            s.updateOverride({ background: { ...s.override.background, textColor: seed } });
            s.setCustomBackgroundSample('matrix.png', seed);
            assert.equal(s.appearance.tokens.text, seed);
          }
          assert.equal(s.preferences.mode, mode);
          assert.equal(s.nativeThemeSource, mode);
          assert.equal(s.windowTransparency, 45);
          assert.equal(s.floatingSurfaceFrosted, true);
          assert.equal(s.appearance.tokens.player, s.appearance.tokens.main);
          assert.equal(s.appearance.tokens.sidebar, s.appearance.tokens.shell);
          for (const value of Object.values(s.cssTokens)) assert.match(value, /^#[0-9a-f]{6}$/i);
          assert.ok(
            api.contrast(s.appearance.floating.text, s.appearance.floating.background) >= 4.5,
          );
          s.applyCurrent();
          for (const [key, value] of Object.entries(s.cssTokens))
            assert.equal(document.documentElement.style.getPropertyValue(key), value);
        }
      }
    }
  }
});

test('floating palette fields validate on registration and resolution', () => {
  assert.throws(
    () =>
      register('bad-float', {
        variants: {
          light: { tokens: {}, floating: { background: 'red' } },
          dark: { tokens: {} },
        },
      }),
    /浮层/,
  );
  assert.throws(
    () =>
      register('unknown-float', {
        variants: {
          light: { tokens: {}, floating: { opacity: '#ffffff' } },
          dark: { tokens: {} },
        },
      }),
    /浮层/,
  );
});

test('accent text pairs with each surface without changing the accent fill', () => {
  for (const background of ['#fff4e1', '#172c40', '#ff9900', '#808080']) {
    for (const accent of ['#ffffff', '#000000', '#bbddff', '#c92d27']) {
      const text = api.surfaceAccentText(accent, background, background);
      assert.ok(api.contrast(text, background) >= 4.5, `${text} on ${background}`);
    }
  }
  const s = store();
  const plugin = register('mixed-accent', {
    variants: {
      dark: { tokens: api.neutralTokens(true) },
      light: {
        tokens: { shell: '#172c40', text: '#ffffff' },
        floating: { background: '#fff4e1', text: '#172c40' },
        accent: '#bbddff',
      },
    },
  });
  s.updateGeneralPreferences({ mode: 'light' });
  s.selectTheme(plugin.key);
  assert.equal(s.accentColor, '#bbddff');
  assert.notEqual(s.cssTokens['--floating-accent-text'], s.accentTextColor);
});

test('real cover sampling updates accent CSS through theme changes and discards superseded covers', async () => {
  const originalImage = globalThis.Image;
  const originalCreateElement = document.createElement;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const pixels = new Map([
    ['cover:red', [220, 50, 47]],
    ['cover:green', [53, 162, 104]],
  ]);
  globalThis.Image = class {
    set src(value) {
      this.url = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
  };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  document.createElement = () => {
    let sample;
    return {
      getContext: () => ({
        drawImage: (image) => {
          sample = pixels.get(image.url);
        },
        getImageData: () => ({ data: new Uint8ClampedArray([...sample, 255]) }),
      }),
    };
  };
  try {
    const s = store();
    s.setMode('cover');
    s.updateGeneralPreferences({ mode: 'light' });
    await s.refreshFromCover('cover:red');
    assert.equal(s.coverColor, '#dc322f');
    const red = document.documentElement.style.getPropertyValue('--color-primary');
    assert.equal(red, s.accentColor);
    assert.equal(
      document.documentElement.style.getPropertyValue('--color-primary-text'),
      s.accentTextColor,
    );
    for (const key of ['host:solid', 'host:custom', 'host:echo']) {
      s.selectTheme(key);
      assert.equal(s.accentMode, 'cover');
      assert.equal(s.coverColor, '#dc322f');
      assert.equal(
        document.documentElement.style.getPropertyValue('--color-primary'),
        s.accentColor,
      );
      assert.equal(
        document.documentElement.style.getPropertyValue('--color-primary-text'),
        s.accentTextColor,
      );
    }
    const old = s.refreshFromCover('cover:red');
    const latest = s.refreshFromCover('cover:green');
    await Promise.all([old, latest]);
    assert.equal(s.coverColor, '#35a268');
    assert.notEqual(document.documentElement.style.getPropertyValue('--color-primary'), red);
    assert.equal(document.documentElement.style.getPropertyValue('--color-primary'), s.accentColor);
    assert.equal(
      document.documentElement.style.getPropertyValue('--color-primary-text'),
      s.accentTextColor,
    );
  } finally {
    globalThis.Image = originalImage;
    document.createElement = originalCreateElement;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
});

test('independent windows pair image/plugin accents with their floating foreground and surface', () => {
  for (const dark of [false, true]) {
    const s = store();
    s.updateGeneralPreferences({ mode: dark ? 'dark' : 'light' });
    s.setCustomBackground('file:///fixture.png');
    s.updateOverride({ background: { ...s.override.background, textColor: '#fefefe' } });
    s.updateGeneralPreferences({ accent: { source: 'cover', color: '#ffdd00' } });
    s.coverColor = '#ffdd00';
    const vars = api.independentWindowColorVariables(s.cssTokens);
    assert.equal(vars['--text-main'], s.resolvedColors.floating.text);
    assert.equal(vars['--text-secondary'], s.resolvedColors.floating.secondary);
    assert.equal(vars['--content-tone'], s.resolvedColors.floatingTone);
    for (const surface of [vars['--surface-elevated-base'], vars['--floating-card-base']]) {
      assert.ok(api.contrast(vars['--text-main'], surface) >= 4.5);
      assert.ok(api.contrast(vars['--text-secondary'], surface) >= 4.5);
      assert.ok(api.contrast(vars['--floating-accent-text'], surface) >= 4.5);
    }
    assert.equal(s.override.background.textColor, '#fefefe');
    assert.equal(vars['--control-thumb-bg'], '#ffffff');
    assert.equal(vars['--theme-shell'], s.cssTokens['--theme-shell']);
  }
  assert.deepEqual(api.independentWindowColorVariables({}), {});
});

test('the renderer-free playback snapshot uses the host default accent before theme synchronization', () => {
  assert.equal(api.DEFAULT_NOW_PLAYING_APPEARANCE.accentColor, api.DEFAULT_THEME_ACCENT);
});
