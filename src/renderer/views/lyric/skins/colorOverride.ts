/**
 * 动态壁纸配色自带的歌词颜色：命中时覆盖皮肤给出的字色，
 * 未播字用同色半透明，保留「已播 / 未播」的层次。
 */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const toRgba = (hex: string, alpha: number): string => {
  const value = hex.slice(1);
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
};

/** 已播字色：配色命中就直接用配色色，否则沿用皮肤/全局设置。 */
export const resolvePlayedColor = (override: string | undefined, fallback: string): string =>
  override ? override : fallback;

/** 未播字色：配色命中时用同色半透明，非十六进制色值原样返回。 */
export const resolveUnplayedColor = (override: string | undefined, fallback: string): string => {
  if (!override) return fallback;
  return HEX_COLOR.test(override) ? toRgba(override, 0.55) : override;
};
