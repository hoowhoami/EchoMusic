/**
 * 任务栏歌词窗口的内容宽度决策。
 *
 * 抽成纯函数是为了能脱离渲染环境验证——切行动画期间不许收窄这条规则，
 * 靠肉眼看很难区分「本来就该收窄」和「收早了」。
 */
export interface ContentWidthInput {
  /** 按当前两行文本量出来的自然宽度（含封面与内边距）。 */
  natural: number;
  /** 原生给出的上限。 */
  maxWidth: number;
  /** 展开态占满可用宽度。 */
  expanded: boolean;
  /** 收起态：只剩封面，歌词区整块让出宽度。 */
  idle: boolean;
  /** 换行动画是否正在进行。 */
  rolling: boolean;
  /** 当前已生效的宽度。 */
  current: number;
}

export const MIN_CONTENT_WIDTH = 160;

/**
 * 收起态（只剩封面）的最小宽度。
 *
 * 160 是给两行歌词留的余量；收起后内容只有封面，沿用 160 会留一大片空白。
 */
export const MIN_IDLE_WIDTH = 24;

/**
 * 切行动画期间只增不减。
 *
 * 切行时新文本在 onMounted 里同步测量完就上报，`reportWidth` 随即把窗口收窄；
 * 而旧行还要再显示 0.5s 向上滑出，这段时间里被裁掉的就是旧行的尾巴——也就是
 * 「当前行比下一行长时，即将换行处先被截断一截」。收窄留到动画结束再执行。
 *
 * 只增不减而非直接冻结：变宽时立刻放行，新行才不会在升入过程中被裁。
 */
export const resolveContentWidth = (input: ContentWidthInput): number => {
  // 居中档播放时窗口贴空闲区左端，宽度再怎么变也只会向右生长，不会再整体左右挪，
  // 所以这里照常按文字量宽度；只有悬停展开才占满上限。
  const base = input.expanded
    ? input.maxWidth
    : input.idle
      ? Math.max(MIN_IDLE_WIDTH, input.natural)
      : Math.max(MIN_CONTENT_WIDTH, input.natural);
  const target = Math.min(input.maxWidth, base);
  return input.rolling ? Math.max(input.current, target) : target;
};
