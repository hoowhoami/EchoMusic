// 默认 fallback 字体链
const FONT_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export interface FontOption {
  label: string;
  value: string;
}

export interface FontOptionOptions {
  includeSystem?: boolean;
  includeFollow?: boolean;
  systemLabel?: string;
  followLabel?: string;
}

export interface FontApi {
  getAll: () => Promise<string[]>;
  getOptions: (options?: FontOptionOptions) => Promise<FontOption[]>;
  buildFamily: (fontName: string) => string;
}

export const normalizeFontName = (fontName: unknown): string =>
  String(fontName ?? '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');

export const compareFontNames = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left.startsWith(right)) return 1;
  if (right.startsWith(left)) return -1;
  return left.localeCompare(right);
};

export const normalizeFontNames = (fonts: unknown): string[] => {
  if (!Array.isArray(fonts)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of fonts) {
    const name = normalizeFontName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  return result.sort(compareFontNames);
};

export const buildFontOptions = (
  fonts: string[],
  options: FontOptionOptions = {},
): FontOption[] => {
  const result: FontOption[] = [];
  const seen = new Set<string>();
  const addOption = (label: string, value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push({ label, value });
  };

  if (options.includeFollow) addOption(options.followLabel || '跟随全局', 'follow');
  if (options.includeSystem !== false) addOption(options.systemLabel || '系统默认', 'system-ui');

  for (const name of normalizeFontNames(fonts)) {
    addOption(name, name);
  }

  return result;
};

export const createFontApi = (readFonts: () => Promise<unknown> | unknown): FontApi => {
  const getAll = async () => {
    try {
      return normalizeFontNames(await readFonts());
    } catch {
      return [];
    }
  };

  return {
    getAll,
    getOptions: async (options) => buildFontOptions(await getAll(), options),
    buildFamily: buildFontFamily,
  };
};

/**
 * 根据字体名构建完整的 CSS font-family 字符串
 */
export function buildFontFamily(fontName: string): string {
  if (!fontName || fontName === 'system-ui') return FONT_FALLBACK;
  const quoted = fontName.includes(' ') ? `"${fontName}"` : fontName;
  return `${quoted}, ${FONT_FALLBACK}`;
}
