export type AppearanceMode = 'theme' | 'system' | 'light' | 'dark';
export type AccentSource = 'theme' | 'cover' | 'custom';
// QQMusic 11.10 skinChanged: rightBgColorView uses skin alpha * 0.5.
export const PANEL_MATERIAL = { opacity: 50 } as const;
export interface AccentPreference {
  source: AccentSource;
  color: string;
}
export interface ThemeOverride {
  palette: { source: 'theme' | 'custom'; color: string };
  background: {
    source: 'theme' | 'image';
    image: string;
    positionX: number;
    positionY: number;
    fit: 'cover' | 'contain';
    textColor: string;
    shade: number;
  };
  settings: Record<string, unknown>;
}
export interface AppearancePreference {
  mode: AppearanceMode;
  themeKey: string;
  overrides: Record<string, ThemeOverride>;
  accent: AccentPreference;
  transparency: number;
  windowFrosted: boolean;
  /** 失焦时强制保持毛玻璃渲染（仅 Windows 毛玻璃后端生效）。 */
  windowFrostedKeepOnBlur: boolean;
  floatingSurfaceFrosted: boolean;
  atmosphere: { source: 'off' | 'cover'; height: number; strength: number };
}
export type GeneralAppearancePreference = Pick<
  AppearancePreference,
  | 'mode'
  | 'accent'
  | 'atmosphere'
  | 'transparency'
  | 'windowFrosted'
  | 'windowFrostedKeepOnBlur'
  | 'floatingSurfaceFrosted'
>;
export type ThemeDraft = Pick<AppearancePreference, 'themeKey' | 'overrides'>;
export interface ThemeTokens {
  shell: string;
  sidebar: string;
  main: string;
  card: string;
  elevated: string;
  player: string;
  text: string;
  secondary: string;
  border: string;
}
export interface FloatingThemeColors {
  background: string;
  card: string;
  text: string;
  secondary: string;
  border: string;
}
export interface AppThemeAppearance {
  tokens: Partial<ThemeTokens>;
  /** Floating surfaces form their own readable color pair, independently of image text. */
  floating?: Partial<FloatingThemeColors>;
  accent?: string;
  background?: {
    gradient?: string;
    color?: string;
    image?: string;
    position?: string;
    fit?: 'cover' | 'contain';
  };
}
export const DEFAULT_THEME_KEY = 'host:echo';
export const CUSTOM_THEME_KEY = 'host:custom';
export const defaultAppearance = (): AppearancePreference => ({
  mode: 'system',
  themeKey: DEFAULT_THEME_KEY,
  overrides: {},
  accent: { source: 'theme', color: '#0071e3' },
  atmosphere: { source: 'off', height: 70, strength: 100 },
  transparency: 0,
  windowFrosted: false,
  windowFrostedKeepOnBlur: false,
  floatingSurfaceFrosted: false,
});
export const defaultOverride = (): ThemeOverride => ({
  palette: { source: 'theme', color: '#6b9bd1' },
  background: {
    source: 'theme',
    image: '',
    positionX: 50,
    positionY: 50,
    fit: 'cover',
    textColor: '#ffffff',
    shade: 0,
  },
  settings: {},
});
export const copyAppearance = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
export const validColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
export const mixColor = (a: string, b: string, amount: number) =>
  '#' +
  rgb(a)
    .map((v, i) =>
      Math.round(v + (rgb(b)[i] - v) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const luminance = (color: string) =>
  rgb(color)
    .map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a: string, b: string) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const readableSurface = (color: string, text: string, dark: boolean) => {
  let surface = color;
  // Keep the selected hue visible; adjust only colors too dark/light for this display mode.
  for (let i = 0; i < 24 && contrast(text, surface) < 7; i++)
    surface = mixColor(surface, dark ? '#111114' : '#ffffff', 0.12);
  return surface;
};
export function paletteFromSeed(seed: string, dark: boolean): ThemeTokens {
  const color = validColor(seed) ? seed : '#6b9bd1';
  const text = dark ? '#f5f5f7' : '#1d1d1f';
  const main = readableSurface(dark ? mixColor(color, '#111114', 0.62) : color, text, dark);
  const shell = mixColor(main, dark ? '#111114' : '#ffffff', 0.12);
  const sidebar = shell;
  const card = readableSurface(mixColor(main, '#ffffff', dark ? 0.06 : 0.08), text, dark);
  // Bound secondary text to a legible contrast against every generated surface.
  let secondary = mixColor(text, main, 0.34);
  const backgrounds = [shell, main, sidebar, card];
  for (
    let i = 0;
    i < 24 && Math.min(...backgrounds.map((bg) => contrast(secondary, bg))) < 4.5;
    i++
  ) {
    const next = mixColor(secondary, text, 0.3);
    if (next === secondary) {
      secondary = text;
      break;
    }
    secondary = next;
  }
  return {
    shell,
    main,
    sidebar,
    card,
    elevated: card,
    player: main,
    text,
    secondary,
    border: mixColor(main, text, 0.18),
  };
}
export const neutralTokens = (dark: boolean): ThemeTokens =>
  dark
    ? {
        shell: '#202024',
        sidebar: '#202024',
        main: '#26262a',
        card: '#36363a',
        elevated: '#36363a',
        player: '#2f2f34',
        text: '#f5f5f7',
        secondary: '#b8bfcb',
        border: '#48484e',
      }
    : {
        shell: '#f0f0f3',
        sidebar: '#f0f0f3',
        main: '#ffffff',
        card: '#f5f5f7',
        elevated: '#ffffff',
        player: '#ffffff',
        text: '#1d1d1f',
        secondary: '#555963',
        border: '#dedee5',
      };
export function normalizeOverride(value: ThemeOverride): ThemeOverride {
  const base = defaultOverride();
  if (!value || typeof value !== 'object') return base;
  const p = value.palette,
    b = value.background;
  if (p?.source === 'custom' && validColor(p.color))
    base.palette = { source: 'custom', color: p.color };
  if (b) {
    base.background = {
      ...base.background,
      source: ['theme', 'image'].includes(b.source) ? b.source : 'theme',
      image: typeof b.image === 'string' ? b.image : '',
      positionX: clamp(b.positionX, 0, 100),
      positionY: clamp(b.positionY, 0, 100),
      fit: b.fit === 'contain' ? 'contain' : 'cover',
      textColor: validColor(b.textColor) ? b.textColor.toLowerCase() : '#ffffff',
      shade: clamp(b.shade, 0, 85),
    };
  }
  if (value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings))
    base.settings = copyAppearance(value.settings);
  return base;
}
