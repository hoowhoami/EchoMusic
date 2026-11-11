/**
 * AMLL 引擎宿主容器样式。
 * AMLL core 自身不设置 font-family（style.css 无定义、无 Shadow DOM 隔离），
 * 歌词 DOM 的字体完全继承宿主；其他内置皮肤的歌词由 LyricScroller 内部应用
 * 歌词页字体，这里必须把 buildLyricFontFamily() 挂到宿主上，否则歌词会跟随全局字体。
 * 歌词颜色沿用 core 的 --amll-lp-color CSS 变量约定，仅在皮肤配置了颜色时下发。
 */
export interface AmllHostStyle {
  fontFamily: string;
  [cssVariable: `--${string}`]: string | undefined;
}

export const buildAmllHostStyle = (
  fontFamily: string,
  textColor: string | undefined,
  resolvedTextColor: string,
): AmllHostStyle => {
  const style: AmllHostStyle = { fontFamily };
  if (textColor) {
    style['--amll-lp-color'] = resolvedTextColor;
  }
  return style;
};
