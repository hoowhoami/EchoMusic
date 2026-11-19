export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * 把 #rgb / #rrggbb 解析成通道值。
 * 壁纸的压暗层与浮尘都要按配色换色，画布只认 rgba 字符串，这里统一做一次转换。
 */
export const parseHexColor = (
  value: string,
  fallback: RgbColor = { r: 0, g: 0, b: 0 },
): RgbColor => {
  const hex = value.trim().replace(/^#/, '');
  const expand = (input: string) =>
    input.length === 3
      ? input
          .split('')
          .map((char) => char + char)
          .join('')
      : input;
  const normalized = expand(hex);
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return fallback;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
};

/** 把一种颜色按比例混向另一种颜色（ratio 为后者的占比），用于派生配色的中间调。 */
export const mixColor = (from: RgbColor, to: RgbColor, ratio: number): RgbColor => {
  const weight = Math.min(1, Math.max(0, ratio));
  return {
    r: Math.round(from.r + (to.r - from.r) * weight),
    g: Math.round(from.g + (to.g - from.g) * weight),
    b: Math.round(from.b + (to.b - from.b) * weight),
  };
};

/** 把通道值拼回 #rrggbb，供 CSS 背景色使用。 */
export const hexColor = (color: RgbColor): string =>
  '#' + [color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, '0')).join('');

/** 把像素通道拼成画布能用的 rgba 颜色。 */
export const rgba = (color: RgbColor, alpha: number): string =>
  'rgba(' + [color.r, color.g, color.b, alpha].join(', ') + ')';
