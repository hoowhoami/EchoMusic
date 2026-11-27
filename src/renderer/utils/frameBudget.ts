/**
 * 壁纸窗口的渲染帧预算。
 *
 * 主进程的 webContents.setFrameRate() 只对离屏渲染生效，对挂在桌面层的普通窗口
 * 完全不起作用，所以「省电档」里的目标帧率只能落在页面侧：各个自绘循环在真正
 * 下一帧交给 scheduleDrawFrame() 安排：没到点先等着，到点才向合成器要帧。
 *
 * 预算由壁纸窗口按策略下发（0 = 不限）。每个循环各自计数，避免多个循环互相
 * 抢配额把其中一路饿死；主窗口从不设置预算，永远是 0，行为不受影响。
 */
let budgetFps = 0;
const lastDrawAt = new Map<string, number>();

export const setRenderFrameRate = (fps: number): void => {
  const next = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 240) : 0;
  if (next === budgetFps) return;
  budgetFps = next;
  // 换档后立刻放行一帧，避免刚解冻时画面卡到下一个周期。
  lastDrawAt.clear();
};

export interface FrameHandle {
  raf: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 按预算安排下一帧：只有到点才向合成器要帧。
 *
 * 在 rAF 回调里直接再 requestAnimationFrame，等于按显示器刷新率（高刷屏 144Hz）
 * 每帧都把合成器叫醒 —— 预算只挡住「画不画」，挡不住「要不要一帧」，
 * 所以出帧数恒等于刷新率、省电档看不出差别。这里未到点先用 setTimeout 等，
 * 到点才 requestAnimationFrame，一个预算周期只唤醒一次。
 */
export const scheduleDrawFrame = (key: string, draw: (now: number) => void): FrameHandle => {
  const handle: FrameHandle = { raf: null, timer: null };
  const request = () => {
    handle.timer = null;
    handle.raf = requestAnimationFrame((now) => {
      handle.raf = null;
      lastDrawAt.set(key, now);
      draw(now);
    });
  };
  if (budgetFps <= 0) {
    request();
    return handle;
  }
  const wait = (lastDrawAt.get(key) ?? 0) + 1000 / budgetFps - performance.now();
  if (wait <= 0) request();
  else handle.timer = setTimeout(request, wait);
  return handle;
};

export const cancelScheduledFrame = (handle: FrameHandle | null | undefined): void => {
  if (!handle) return;
  if (handle.raf !== null) cancelAnimationFrame(handle.raf);
  if (handle.timer !== null) clearTimeout(handle.timer);
  handle.raf = null;
  handle.timer = null;
};
