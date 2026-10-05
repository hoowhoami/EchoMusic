import { legacySurfaceVariables } from '@/plugins/runtime/theme';
import { DEFAULT_THEME_ACCENT } from '../../shared/themePalette';
import { defineStore } from 'pinia';
import {
  resolveThemeColors,
  themeColorVariables,
  themeContentSurfaces,
  usesLightForeground,
  type ResolvedThemeColors,
} from '@/theme/colors';
import {
  applyAccentToRoot,
  DEFAULT_ACCENT,
  extractDominantColor,
  getAccentPalette,
  createAccentPaletteFromPrimary,
  getNormalizedAccent,
  hexToRgb,
  waitForAbortableDelay,
} from '@/utils/color';
import {
  builtinAppThemes,
  validateThemeAppearance,
  assertJsonSettings,
  failAppTheme,
  resolveAppTheme,
  type AppThemeEntry,
} from '@/theme/registry';
import {
  copyAppearance,
  defaultAppearance,
  CUSTOM_THEME_KEY,
  defaultOverride,
  normalizeOverride,
  neutralTokens,
  paletteFromSeed,
  validColor,
  clamp,
  mixColor,
  type AppearancePreference,
  type ThemeOverride,
  type AccentSource,
  type AppThemeAppearance,
  type GeneralAppearancePreference,
  type ThemeDraft,
  PANEL_MATERIAL,
} from '@/theme/model';
export type AccentMode = AccentSource;
type CoverColorSource = string | readonly string[];
let coverColorRequestSeq = 0;
let coverColorAbortController: AbortController | null = null;
const resolveModeSource = (preference: AppearancePreference, entry: AppThemeEntry) =>
  preference.mode === 'theme' ? (entry.defaultMode ?? 'system') : preference.mode;
export const useThemeStore = defineStore('appearance', {
  state: () => ({
    preferences: defaultAppearance(),
    preview: null as AppearancePreference | null,
    systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    coverColor: DEFAULT_ACCENT,
    customBackgroundSample: { source: '', color: '' },
  }),
  getters: {
    activePreferences: (state): AppearancePreference => state.preview ?? state.preferences,
    desiredThemeKey(): string {
      return this.activePreferences.themeKey;
    },
    currentTheme(): AppThemeEntry {
      return resolveAppTheme(this.desiredThemeKey) ?? builtinAppThemes[0];
    },
    effectiveThemeKey(): string {
      return this.currentTheme.key;
    },
    nativeThemeSource(): 'system' | 'light' | 'dark' {
      return resolveModeSource(this.activePreferences, this.currentTheme);
    },
    variantIsDark(): boolean {
      return (
        this.nativeThemeSource === 'dark' ||
        (this.nativeThemeSource === 'system' && this.systemDark)
      );
    },
    resolvedColors(): ResolvedThemeColors {
      return resolveThemeColors(this.themeDefinition, this.variantIsDark);
    },
    isDark(): boolean {
      return this.resolvedColors.dark;
    },
    displayMode(): 'light' | 'dark' {
      return this.isDark ? 'dark' : 'light';
    },
    override(): ThemeOverride {
      return normalizeOverride(
        this.activePreferences.overrides[this.effectiveThemeKey] ?? defaultOverride(),
      );
    },
    themeSettings(): Record<string, unknown> {
      return { ...this.currentTheme.settings?.defaults, ...this.override.settings };
    },
    themeDefinition(): AppThemeAppearance {
      const entry = this.currentTheme;
      const paletteDark =
        entry.key === CUSTOM_THEME_KEY
          ? usesLightForeground(this.override.background.textColor)
          : this.variantIsDark;
      let base = entry.variants[paletteDark ? 'dark' : 'light'];
      try {
        const result = entry.settings?.validate?.(this.themeSettings);
        if (result === false || (typeof result === 'object' && result.errors?.length))
          throw new Error('主题配置校验失败');
        const resolved = entry.resolve?.({ isDark: paletteDark, settings: this.themeSettings });
        if (resolved) validateThemeAppearance(resolved);
        if (resolved)
          base = {
            ...base,
            ...resolved,
            tokens: { ...base.tokens, ...resolved.tokens },
            floating: { ...base.floating, ...resolved.floating },
          };
      } catch (error) {
        failAppTheme(entry, error);
        base = builtinAppThemes[0].variants[paletteDark ? 'dark' : 'light'];
      }
      const generated =
        this.override.palette.source === 'custom'
          ? paletteFromSeed(this.override.palette.color, paletteDark)
          : null;
      const sample = this.customBackgroundSample;
      const imagePalette =
        entry.key === CUSTOM_THEME_KEY &&
        sample.source === this.backgroundImage &&
        validColor(sample.color)
          ? paletteFromSeed(sample.color, paletteDark)
          : null;
      const tokens = {
        ...base.tokens,
        // Image sampling only tints the window background and its two panels.
        // Floating surfaces and their text keep the theme's readable palette.
        ...(imagePalette
          ? { shell: imagePalette.shell, main: imagePalette.main, player: imagePalette.player }
          : {}),
        ...generated,
      };
      if (entry.key === CUSTOM_THEME_KEY) {
        tokens.text = this.override.background.textColor;
        tokens.secondary = mixColor(tokens.text, neutralTokens(paletteDark).secondary, 0.25);
      }
      const definition = {
        ...base,
        tokens,
        ...(generated ? { accent: this.override.palette.color } : {}),
      };
      return definition;
    },
    appearance(): AppThemeAppearance {
      const colors = this.resolvedColors;
      return { ...this.themeDefinition, tokens: colors.tokens, floating: colors.floating };
    },
    backgroundImage(): string {
      return this.effectiveThemeKey === CUSTOM_THEME_KEY
        ? this.override.background.image
        : (this.appearance.background?.image ?? '');
    },
    accentMode(): AccentMode {
      return this.activePreferences.accent.source;
    },
    customColor(): string {
      return this.activePreferences.accent.color;
    },
    sourceColor(): string {
      const pref = this.activePreferences.accent;
      return pref.source === 'cover'
        ? this.coverColor
        : pref.source === 'custom'
          ? pref.color
          : (this.appearance.accent ?? DEFAULT_THEME_ACCENT);
    },
    accentColor(): string {
      return this.accentMode === 'theme'
        ? this.sourceColor
        : getNormalizedAccent(this.sourceColor, this.isDark);
    },
    accentTextColor(): string {
      return createAccentPaletteFromPrimary(this.accentColor, this.isDark, this.accentSurfaces)
        .primaryText;
    },
    accentSurfaces(): string[] {
      const atmosphere = this.activePreferences.atmosphere;
      return themeContentSurfaces(
        this.resolvedColors,
        atmosphere.source === 'cover'
          ? {
              color: getAccentPalette(this.coverColor, this.isDark).atmosphere,
              opacity: ((this.isDark ? 0.3 : 0.32) * clamp(atmosphere.strength, 20, 200)) / 100,
            }
          : undefined,
      );
    },
    onAccentColor(): string {
      return createAccentPaletteFromPrimary(this.accentColor, this.isDark).onPrimary;
    },
    accentColorRgb(): string {
      const color = hexToRgb(this.accentColor) ?? hexToRgb(DEFAULT_ACCENT);
      return color ? `${color.r}, ${color.g}, ${color.b}` : '0, 113, 227';
    },
    windowTransparency(): number {
      return clamp(this.activePreferences.transparency, 0, 100);
    },
    floatingSurfaceFrosted(): boolean {
      return this.activePreferences.floatingSurfaceFrosted;
    },
    surfaceVariables(): Record<string, string> {
      const base: Record<string, string> = {};
      for (const surface of ['main', 'sidebar', 'player', 'card', 'elevated', 'dialog'])
        base[`--surface-${surface}-opacity`] = '100%';
      if (this.currentTheme.pluginId === 'host') Object.assign(base, legacySurfaceVariables.value);
      for (const surface of ['main', 'sidebar', 'player'])
        base[`--surface-${surface}-opacity`] = `${PANEL_MATERIAL.opacity}%`;
      base['--surface-backdrop-filter'] = 'none';
      base['--surface-player-backdrop-filter'] = base['--surface-backdrop-filter'];
      return base;
    },
    cssTokens(): Record<string, string> {
      return themeColorVariables(this.resolvedColors, this.accentColor, this.accentSurfaces);
    },
  },
  actions: {
    setCustomBackgroundSample(source: string, color: string | null) {
      if (this.effectiveThemeKey !== CUSTOM_THEME_KEY || source !== this.backgroundImage) return;
      this.customBackgroundSample = { source, color: color && validColor(color) ? color : '' };
      this.applyCurrent();
    },
    removePluginThemes(pluginId: string) {
      const owns = (key: string) => {
        try {
          const pair = JSON.parse(key);
          return Array.isArray(pair) && pair[0] === pluginId;
        } catch {
          return false;
        }
      };
      const clear = (value: AppearancePreference) => ({
        ...value,
        themeKey: owns(value.themeKey) ? 'host:echo' : value.themeKey,
        overrides: Object.fromEntries(
          Object.entries(value.overrides).filter(([key]) => !owns(key)),
        ),
      });
      this.preferences = clear(this.preferences);
      if (this.preview) this.preview = clear(this.preview);
      this.applyCurrent();
    },
    beginPreview() {
      if (this.preview) return;
      this.preview = copyAppearance(this.preferences);
    },
    cancelPreview() {
      this.preview = null;
      this.applyCurrent();
    },
    applyPreview() {
      if (this.preview)
        this.preferences = {
          ...this.preferences,
          themeKey: this.preview.themeKey,
          overrides: copyAppearance(this.preview.overrides),
        };
      this.preview = null;
      this.applyCurrent();
    },
    updatePreferences(patch: Partial<AppearancePreference>) {
      const next = { ...this.activePreferences, ...copyAppearance(patch) };
      if (this.preview) this.preview = next;
      else this.preferences = next;
      this.applyCurrent();
    },
    /** 设置页的长期偏好即时保存，同时同步到主题草稿，避免被主题撤销覆盖。 */
    updateGeneralPreferences(patch: Partial<GeneralAppearancePreference>) {
      const next = copyAppearance(patch);
      this.preferences = { ...this.preferences, ...next };
      if (this.preview) this.preview = { ...this.preview, ...next };
      this.applyCurrent();
    },
    restoreThemeDraft(draft: ThemeDraft) {
      this.updatePreferences({
        themeKey: draft.themeKey,
        overrides: copyAppearance(draft.overrides),
      });
    },
    selectTheme(key: string) {
      if (!resolveAppTheme(key)) throw new Error('主题不可用');
      this.updatePreferences({ themeKey: key });
    },
    setCustomBackground(image: string) {
      if (!image) throw new Error('请先选择图片');
      this.selectTheme(CUSTOM_THEME_KEY);
      this.updateOverride({ background: { ...this.override.background, source: 'image', image } });
    },
    updateOverride(patch: Partial<ThemeOverride>) {
      if (patch.background && this.desiredThemeKey !== CUSTOM_THEME_KEY)
        throw new Error('图片背景只能用于自定义皮肤');
      if (!resolveAppTheme(this.desiredThemeKey))
        this.updatePreferences({ themeKey: this.effectiveThemeKey });
      const key = this.effectiveThemeKey;
      const value = normalizeOverride({ ...this.override, ...copyAppearance(patch) });
      const overrides = { ...this.activePreferences.overrides };
      if (JSON.stringify(value) === JSON.stringify(defaultOverride())) delete overrides[key];
      else overrides[key] = value;
      this.updatePreferences({ overrides });
    },
    resetAppearanceAdjustments() {
      const defaults = defaultAppearance();
      this.updateGeneralPreferences({
        accent: defaults.accent,
        atmosphere: defaults.atmosphere,
        transparency: defaults.transparency,
        windowFrosted: defaults.windowFrosted,
        floatingSurfaceFrosted: defaults.floatingSurfaceFrosted,
      });
    },
    resetThemeSettings() {
      this.updateOverride({ settings: {} });
    },
    updateThemeSettings(patch: Record<string, unknown>) {
      const entry = this.currentTheme;
      assertJsonSettings(patch);
      const settings = { ...this.themeSettings, ...copyAppearance(patch) };
      const result = entry.settings?.validate?.(settings);
      if (result === false || (typeof result === 'object' && result.errors?.length))
        throw new Error(typeof result === 'object' ? result.errors?.join('；') : '主题设置无效');
      this.updateOverride({
        settings: Object.fromEntries(
          Object.entries(settings).filter(
            ([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(entry.settings?.defaults[key]),
          ),
        ),
      });
    },
    setMode(source: AccentMode) {
      this.updateGeneralPreferences({ accent: { ...this.preferences.accent, source } });
    },
    setCustomColor(color: string) {
      if (!validColor(color)) return;
      this.updateGeneralPreferences({ accent: { source: 'custom', color } });
    },
    onThemeChange() {
      this.systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.applyCurrent();
    },
    applyCurrent() {
      const root = document.documentElement,
        body = document.body;
      root.classList.toggle('dark', this.isDark);
      root.classList.toggle('floating-surfaces-frosted', this.floatingSurfaceFrosted);
      for (const [key, value] of Object.entries(this.cssTokens)) root.style.setProperty(key, value);
      root.style.setProperty('--surface-dialog-base', this.appearance.tokens.elevated!);
      for (const [key, value] of Object.entries(this.surfaceVariables))
        root.style.setProperty(key, value);
      body.classList.toggle(
        'echo-surface-translucent',
        Object.values(this.surfaceVariables).some((value) => value !== '100%' && value !== 'none'),
      );
      applyAccentToRoot(
        this.sourceColor,
        this.isDark,
        this.accentMode === 'theme',
        this.accentSurfaces,
      );
      const atmos = this.activePreferences.atmosphere;
      const enabled = atmos.source === 'cover';
      const strength = clamp(atmos.strength, 20, 200);
      for (const key of Array.from(body.style))
        if (key.startsWith('--accent-gradient-') && !key.startsWith('--accent-gradient-user-'))
          body.style.removeProperty(key);
      if (atmos.source === 'cover') {
        const color = hexToRgb(getAccentPalette(this.coverColor, this.isDark).atmosphere)!;
        // Cover atmosphere is a global effect independent of theme package backgrounds.
        body.style.setProperty('--accent-gradient-color-rgb', `${color.r}, ${color.g}, ${color.b}`);
      }
      body.style.setProperty('--accent-gradient-user-height', `${clamp(atmos.height, 20, 100)}%`);
      body.style.setProperty('--accent-gradient-user-opacity', String(Math.min(1, strength / 100)));
      body.style.setProperty('--accent-gradient-user-gain', String(Math.max(1, strength / 100)));
      body.classList.toggle('accent-gradient-disabled', !enabled);
      body.classList.toggle('cover-atmosphere-enabled', atmos.source === 'cover');
      // 同步模式来源；发送解析后的深浅色会反过来锁定 matchMedia，破坏跟随系统。
      window.electron?.ipcRenderer?.send('update-theme', this.nativeThemeSource);
    },
    async refreshFromCover(coverUrl: CoverColorSource) {
      return this.refreshCoverColor(coverUrl);
    },
    async refreshCoverColor(coverUrl: CoverColorSource): Promise<string | null> {
      const seq = ++coverColorRequestSeq;
      coverColorAbortController?.abort();
      const abortController = new AbortController();
      coverColorAbortController = abortController;
      const urls = Array.from(
        new Set(
          (Array.isArray(coverUrl) ? coverUrl : [coverUrl])
            .map((url) => String(url ?? '').trim())
            .filter(Boolean),
        ),
      );
      if (urls.length === 0) {
        if (coverColorAbortController === abortController) coverColorAbortController = null;
        this.coverColor = DEFAULT_ACCENT;
        this.applyCurrent();
        return this.coverColor;
      }

      const shouldExtract = await waitForAbortableDelay(180, abortController.signal);
      if (!shouldExtract || seq !== coverColorRequestSeq) return null;

      let extracted: string | null = null;
      for (const url of urls) {
        extracted = await extractDominantColor(url, { signal: abortController.signal });
        if (seq !== coverColorRequestSeq || abortController.signal.aborted) return null;
        if (extracted) break;
      }

      if (coverColorAbortController === abortController) coverColorAbortController = null;
      this.coverColor = extracted || DEFAULT_ACCENT;
      this.applyCurrent();
      return this.coverColor;
    },
  },
  persist: { pick: ['preferences'] },
});
