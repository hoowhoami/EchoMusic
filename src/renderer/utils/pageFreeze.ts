/**
 * 页面冻结：把「这一刻的画面」定死，让渲染端不再产生新帧。
 *
 * 动态壁纸在看不见的时候（桌面被整块盖住、暂停且不显示壁纸）会调用它：
 * 停掉浮尘与歌词的逐帧刷新、暂停所有 CSS 动画与过渡，合成器便没有新帧可画。
 * 这比把帧率压到 1fps 再慢慢重绘更省 —— 降帧只减少提交次数，绘制与动画本身还在。
 *
 * 状态挂在 <html> 上（类名直接当样式选择器用），变化时派发一个 window 事件，
 * 让各个绘制循环自己停表 / 复跑。
 */
const FROZEN_CLASS = 'wallpaper-frozen';
const FROZEN_EVENT = 'page-freeze-change';

export const isPageFrozen = (): boolean =>
  document.documentElement.classList.contains(FROZEN_CLASS);

export const setPageFrozen = (frozen: boolean): void => {
  if (isPageFrozen() === frozen) return;
  document.documentElement.classList.toggle(FROZEN_CLASS, frozen);
  window.dispatchEvent(new CustomEvent<boolean>(FROZEN_EVENT, { detail: frozen }));
};

export const onPageFreezeChange = (handler: (frozen: boolean) => void): (() => void) => {
  const listener = (event: Event) => handler((event as CustomEvent<boolean>).detail === true);
  window.addEventListener(FROZEN_EVENT, listener);
  return () => window.removeEventListener(FROZEN_EVENT, listener);
};
