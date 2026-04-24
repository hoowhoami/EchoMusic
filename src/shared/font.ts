// 默认 fallback 字体链
const FONT_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/**
 * 根据字体名构建完整的 CSS font-family 字符串
 */
export function buildFontFamily(fontName: string): string {
  if (!fontName || fontName === 'system-ui') return FONT_FALLBACK;
  const quoted = fontName.includes(' ') ? `"${fontName}"` : fontName;
  return `${quoted}, ${FONT_FALLBACK}`;
}
