import { createAccentPaletteFromPrimary, normalizeAccent } from './accentPalette';

// 独立歌词窗口只消费主窗口的取色结果，不解码图片、不写回用户的手动配色。
export const resolveCoverLyricColor = (
  coverColor: string | null | undefined,
  surface: 'desktop' | 'light' | 'dark',
  surfaces?: string[],
): string | undefined => {
  if (typeof coverColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(coverColor)) return undefined;
  // 桌面歌词背景透明，沿用播放页的明亮字色；Mini 按卡片深浅色保证可读性。
  return surface === 'desktop'
    ? normalizeAccent(coverColor, true)
    : createAccentPaletteFromPrimary(
        normalizeAccent(coverColor, surface === 'dark'),
        surface === 'dark',
        surfaces,
      ).primaryText;
};
