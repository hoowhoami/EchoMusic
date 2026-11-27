/** PageScrollContainer 通过 defineExpose 暴露的能力；scrollToTop 直接复用右下角回顶图标那一份实现 */
export type PageScrollHandle = { scrollToTop: () => void };

/** 同一次双击里两次按下的最大间隔，与浏览器默认的双击判定窗口对齐 */
const PRESS_SEQUENCE_MS = 500;

/**
 * 双击 tab 回到页面顶部（口径：只对「按下时已经选中」的 tab 生效）。
 *
 * 容器：页面组件是 PageScrollContainer 的父组件，useScrollContainer() 只能拿到 null，
 * 所以由页面传入模板 ref（<PageScrollContainer ref="pageScrollRef">）取它 expose 的 scrollToTop。
 * 状态：reka-ui 的 TabsTrigger 在 mousedown 时就完成切换，pointerdown 早于 mousedown，
 * 因此冒泡阶段的 pointerdown 仍能读到切换前的 data-state；到 dblclick 再读就分不清了。
 *
 * 模板：<TabsList @pointerdown="onTabPointerDown" @dblclick="onTabDoubleClick">
 */
export function useTabDoubleClickTop(getPageScroll: () => PageScrollHandle | null) {
  // 记住「上一次按下的是哪个 tab、按下时它有没有选中」：换到别的 tab 上要重新判定，
  // 否则在 A（已选中）双击后 500ms 内去双击 B（未选中）也会被当成回顶。
  let press: { tab: HTMLElement; wasActive: boolean; at: number } | null = null;

  const readTab = (event: Event) =>
    (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="tab"]') ?? null;

  /** reka-ui 的 TabsTrigger 给的是 data-state，自研 CustomTabBar 只有 aria-selected，两种都认 */
  const isTabActive = (trigger: HTMLElement) =>
    trigger.dataset.state === 'active' || trigger.getAttribute('aria-selected') === 'true';

  const onTabPointerDown = (event: PointerEvent) => {
    const trigger = readTab(event);
    if (!trigger) return;
    const now = Date.now();
    // 同一个 tab 的第二次按下：沿用第一次按下的选中态（那时还没被这次点击切换）
    const previous = press;
    const sameSequence =
      previous !== null && previous.tab === trigger && now - previous.at <= PRESS_SEQUENCE_MS;
    press = {
      tab: trigger,
      wasActive: sameSequence ? previous.wasActive : isTabActive(trigger),
      at: now,
    };
  };

  const onTabDoubleClick = (event: MouseEvent) => {
    const trigger = readTab(event);
    const pressed = press;
    press = null;
    if (!trigger || !pressed || pressed.tab !== trigger || !pressed.wasActive) return;
    const pageScroll = getPageScroll();
    if (!pageScroll) {
      // 不静默失败：ref 没挂上必须留下痕迹
      console.warn('[useTabDoubleClickTop] PageScrollContainer ref 未挂载，双击回顶已跳过');
      return;
    }
    // 与单击右下角回顶图标同一条路径（BackToTop.scrollToTop）
    pageScroll.scrollToTop();
  };

  return { onTabPointerDown, onTabDoubleClick };
}
