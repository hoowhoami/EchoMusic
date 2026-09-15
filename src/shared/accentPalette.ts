/** Perceptual palette generation. OKLab matrices follow CSS Color 4 (D65 / sRGB). */
export type Rgb = { r: number; g: number; b: number };
export type Oklab = { l: number; a: number; b: number };
export interface AccentPalette {
  primary: string;
  atmosphere: string;
  primaryText: string;
  onPrimary: string;
  hover: string;
  pressed: string;
  onHover: string;
  onPressed: string;
  subtle: string;
  onSubtle: string;
  focusRing: string;
}
const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
export const parseAccent = (hex: string): Rgb => {
  let value = String(hex ?? '')
    .replace(/^#/, '')
    .trim();
  if (/^[\da-f]{3}$/i.test(value))
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  if (!/^[\da-f]{6}$/i.test(value)) value = '0071e3';
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
};
export const accentHex = (rgb: Rgb) =>
  '#' +
  [rgb.r, rgb.g, rgb.b]
    .map((v) =>
      Math.round(clamp(v, 0, 255))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
export const rgbToOklab = (rgb: Rgb): Oklab => {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((v) => linear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};
const labLinear = ({ l, a, b }: Oklab) => {
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ];
};
/** Reduce chroma at constant hue/lightness instead of clipping RGB channels. */
export const oklabToRgb = (lab: Oklab): Rgb => {
  const l = clamp(lab.l);
  const initial = labLinear({ ...lab, l });
  if (initial.every((v) => v >= -1e-7 && v <= 1 + 1e-7)) {
    const [r, g, b] = initial.map((v) => Math.round(clamp(gamma(v)) * 255));
    return { r, g, b };
  }
  let low = 0,
    high = 1;
  for (let i = 0; i < 22; i++) {
    const scale = (low + high) / 2;
    const channels = labLinear({ l, a: lab.a * scale, b: lab.b * scale });
    if (channels.every((v) => v >= -1e-7 && v <= 1 + 1e-7)) low = scale;
    else high = scale;
  }
  const [r, g, b] = labLinear({ l, a: lab.a * low, b: lab.b * low }).map((v) =>
    Math.round(clamp(gamma(v)) * 255),
  );
  return { r, g, b };
};
export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const lum = (v: Rgb) =>
    0.2126 * linear(v.r / 255) + 0.7152 * linear(v.g / 255) + 0.0722 * linear(v.b / 255);
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
export const compositeAccent = (foreground: Rgb, background: Rgb, alpha: number): Rgb => ({
  r: foreground.r * alpha + background.r * (1 - alpha),
  g: foreground.g * alpha + background.g * (1 - alpha),
  b: foreground.b * alpha + background.b * (1 - alpha),
});
// Legacy HSL normalization retained for its original color character.
const roundChannel = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const delta = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  if (delta !== 0) {
    if (max === nr) h = ((ng - nb) / delta) % 6;
    else if (max === ng) h = (nb - nr) / delta + 2;
    else h = (nr - ng) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: clamp(s), l: clamp(l) };
};

const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  const sat = clamp(s);
  const lit = clamp(l);
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hue = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lit - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: roundChannel((r + m) * 255),
    g: roundChannel((g + m) * 255),
    b: roundChannel((b + m) * 255),
  };
};

export const normalizeAccent = (hex: string, isDark: boolean): string => {
  if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex ?? '').trim())) return '#0071e3';
  const rgb = parseAccent(String(hex).trim());
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // 近乎灰度的颜色，回落到默认主题色
  if (s < 0.08) return '#0071e3';

  let nextS = s;
  let nextL = l;

  if (isDark) {
    // 深色模式：S ∈ [0.45, 0.85]，L ∈ [0.55, 0.72]
    nextS = Math.min(0.85, Math.max(0.45, s));
    nextL = Math.min(0.72, Math.max(0.55, l));
  } else {
    // 浅色模式：S ∈ [0.55, 0.9]，L ∈ [0.42, 0.55]
    nextS = Math.min(0.9, Math.max(0.55, s));
    nextL = Math.min(0.55, Math.max(0.42, l));
  }

  const { r, g, b } = hslToRgb(h, nextS, nextL);
  return accentHex({ r, g, b });
};

// Includes main, elevated and interaction surfaces.
export const accentSurfaces = (dark: boolean): string[] =>
  dark ? ['#26262a', '#36363a', '#2f2f34', '#505055'] : ['#ffffff', '#f5f5f7', '#d0d0d4'];
const readable = (color: string, backgrounds: string[], dark: boolean): string => {
  const lab = rgbToOklab(parseAccent(color));
  const passes = (rgb: Rgb) =>
    backgrounds.every((bg) => contrastRatio(rgb, parseAccent(bg)) >= 4.55);
  if (passes(parseAccent(color))) return color;
  let low = 0,
    high = 1;
  for (let i = 0; i < 22; i++) {
    const t = (low + high) / 2;
    const rgb = oklabToRgb({ ...lab, l: lab.l + ((dark ? 1 : 0) - lab.l) * t });
    if (passes(rgb)) high = t;
    else low = t;
  }
  return accentHex(oklabToRgb({ ...lab, l: lab.l + ((dark ? 1 : 0) - lab.l) * high }));
};
const onColor = (hex: string) =>
  contrastRatio(parseAccent(hex), parseAccent('#fff')) >=
  contrastRatio(parseAccent(hex), parseAccent('#000'))
    ? '#ffffff'
    : '#000000';
export const createAccentPaletteFromPrimary = (primary: string, dark: boolean): AccentPalette => {
  const lab = rgbToOklab(parseAccent(primary));
  // Background tint shares the accent hue, with less chroma and a mode-specific lightness.
  // Do not raise chroma: neutral / muted seeds must remain neutral / muted.
  const chroma = Math.hypot(lab.a, lab.b);
  const atmosphereScale = chroma > 0 ? Math.min(0.55, 0.065 / chroma) : 0;
  const atmosphere = accentHex(
    oklabToRgb({
      l: dark ? 0.56 : 0.88,
      a: lab.a * atmosphereScale,
      b: lab.b * atmosphereScale,
    }),
  );
  const state = (delta: number) => accentHex(oklabToRgb({ ...lab, l: clamp(lab.l + delta) }));
  // Keep a stable foreground through hover/press transitions; move fills away from its luminance.
  const onPrimary = onColor(primary);
  const direction = onPrimary === '#ffffff' ? -1 : 1;
  const hover = state(direction * 0.035);
  const pressed = state(direction * 0.065);
  const subtle = accentHex(
    compositeAccent(
      parseAccent(primary),
      parseAccent(dark ? '#36363a' : '#f5f5f7'),
      dark ? 0.18 : 0.12,
    ),
  );
  const primaryText = readable(primary, [...accentSurfaces(dark), subtle], dark);
  return {
    primary,
    atmosphere,
    primaryText,
    onPrimary,
    hover,
    pressed,
    onHover: onPrimary,
    onPressed: onPrimary,
    subtle,
    onSubtle: readable(primary, [subtle], dark),
    focusRing: primaryText,
  };
};
export const getAccentPalette = (hex: string, dark: boolean) =>
  createAccentPaletteFromPrimary(normalizeAccent(hex, dark), dark);
