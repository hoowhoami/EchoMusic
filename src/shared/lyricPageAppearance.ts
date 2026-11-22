/** 歌词页外观模式：深色 / 浅色 / 跟随主程序。 */
export type LyricPageAppearanceMode = 'dark' | 'light' | 'follow';

/** 纯函数解析：歌词页外观模式 → 是否深色（跟随档取主程序当前深浅态；脏值守卫回退深色）。 */
export const resolveLyricPageIsDark = (
  mode: LyricPageAppearanceMode,
  appIsDark: boolean,
): boolean => (mode === 'follow' ? appIsDark : mode !== 'light');

/** 浅色歌词页的墨色锚点：浅档深色文字与深色元素统一取值（与深色兜底背景同源）。 */
export const LYRIC_PAGE_INK = '#1a1d22';

/** 脏值守卫：非法外观模式回退默认深色（持久化损坏 / 旧版本值）。 */
export const normalizeLyricPageAppearanceMode = (mode: unknown): LyricPageAppearanceMode =>
  mode === 'light' || mode === 'follow' ? mode : 'dark';
