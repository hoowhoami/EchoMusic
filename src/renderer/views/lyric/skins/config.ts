import { useThemeStore } from '@/stores/theme';
import { LYRIC_COVER_COLOR_VALUE } from '@/stores/lyric';
import { getNormalizedAccent, DEFAULT_ACCENT } from '@/utils/color';

export const HOST_SKIN_KEYS = {
  cover: 'host:cover',
  portrait: 'host:portrait',
  lyric: 'host:lyric',
  amll: 'host:amll',
} as const;

/**
 * 内置皮肤共用的歌词文本样式（字号 / 字重 / 已播未播颜色）。
 * 每个皮肤各持一份独立配置，互不干扰。
 */
export interface LyricTextStyleConfig extends Record<string, unknown> {
  fontScale: number;
  fontWeightIndex: number;
  playedColor: string;
  unplayedColor: string;
}

export const LYRIC_TEXT_STYLE_DEFAULTS: LyricTextStyleConfig = {
  fontScale: 1,
  fontWeightIndex: 8,
  playedColor: '',
  unplayedColor: '',
};

export interface LyricSkinConfigCover extends LyricTextStyleConfig {
  dynamicAlbumCover: boolean;
}

export const LYRIC_SKIN_COVER_DEFAULTS: LyricSkinConfigCover = {
  ...LYRIC_TEXT_STYLE_DEFAULTS,
  dynamicAlbumCover: false,
};

/** 歌词皮肤配置即歌词文本样式本身。 */
export type LyricSkinConfigLyric = LyricTextStyleConfig;

export const LYRIC_SKIN_LYRIC_DEFAULTS: LyricSkinConfigLyric = { ...LYRIC_TEXT_STYLE_DEFAULTS };

export interface LyricSkinConfigPortrait extends LyricTextStyleConfig {
  backdropOpacity: number;
  carouselEnabled: boolean;
  carouselInterval: number;
  portraitFallbackCover: boolean;
  autoCollapseEnabled: boolean;
  autoCollapseDelay: number;
  collapseHideControls: boolean;
}

export const LYRIC_SKIN_PORTRAIT_DEFAULTS: LyricSkinConfigPortrait = {
  ...LYRIC_TEXT_STYLE_DEFAULTS,
  backdropOpacity: 50,
  carouselEnabled: true,
  carouselInterval: 15,
  portraitFallbackCover: false,
  autoCollapseEnabled: true,
  autoCollapseDelay: 5,
  collapseHideControls: false,
};

/** 内嵌 Apple Music 风格歌词（AMLL）的皮肤配置。 */
export interface LyricSkinConfigAmll extends Record<string, unknown> {
  /** 活跃歌词行在组件高度上的居停位置，0.0～1.0，默认 0.5（垂直居中）。 */
  alignPosition: number;
  /** 是否使用物理弹簧算法驱动歌词位移动画。 */
  enableSpring: boolean;
  /** 是否启用歌词行的模糊效果。 */
  enableBlur: boolean;
  /** 是否启用歌词行缩放律动。 */
  enableScale: boolean;
  /** 是否隐藏已经播放过的歌词行。 */
  hidePassedLines: boolean;
  /** 文字动画渐变宽度（以字号为倍数的倍数），需大于 0，默认 0.5。 */
  wordFadeWidth: number;
  /** 歌词文字颜色；空值回退主题默认白，`__cover__` 取封面主题色。 */
  textColor: string;
  /** 是否启用动态专辑封面（封面随播放律动呼吸）。 */
  dynamicAlbumCover: boolean;
}

export const LYRIC_SKIN_AMLL_DEFAULTS: LyricSkinConfigAmll = {
  alignPosition: 0.5,
  enableSpring: true,
  enableBlur: true,
  enableScale: true,
  hidePassedLines: false,
  wordFadeWidth: 0.5,
  textColor: '',
  dynamicAlbumCover: false,
};

export const AMLL_TEXT_COLOR_FALLBACK = '#ffffff';

export const LYRIC_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export const lyricSkinFontWeight = (index: number) =>
  LYRIC_FONT_WEIGHTS[Math.max(0, Math.min(8, Math.round(index)))] ?? 900;

/** 皮肤内歌词颜色的统一解析：空值回退默认色，`__cover__` 取封面主题色。 */
export function resolveLyricSkinColor(value: string, fallback: string): string {
  if (value === LYRIC_COVER_COLOR_VALUE) {
    const themeStore = useThemeStore();
    // Lyrics have a dark backdrop regardless of the application theme.
    return getNormalizedAccent(themeStore.coverColor || DEFAULT_ACCENT, true);
  }
  return value || fallback;
}
