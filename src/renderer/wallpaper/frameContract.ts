import { readonly, shallowRef } from 'vue';
import { paceFpsOf } from '../../shared/wallpaper';

/**
 * 壁纸帧率契约。
 *
 * 主程序的帧率设置（每块屏一档、被挡住时按 20% 省电、看不见时整页冻结）原本只落在
 * 宿主自己的绘制循环上（frameBudget 的 scheduleDrawFrame）。插件自绘的画面走的是
 * 自己的循环，宿主碰不到，所以这里把设定公开成契约：
 *
 * - 壁纸窗口通过 setWallpaperFrameMode() 下发当前设定；
 * - 插件页上下文里能读到 page.state.view.frame（响应式）；
 * - 不接上下文的插件监听 window 的 'echomusic:wallpaper-frame' 事件，
 *   事件 detail 与这里返回的对象同形。
 *
 * fps 为 0 表示不限（主窗口、或壁纸没设帧率）；frozen 为 true 时必须完全不出帧，
 * 等下一次事件解除后再续上。
 */
export interface WallpaperFrameMode {
  /** 目标帧率；0 表示不限。 */
  fps: number;
  /** true 表示壁纸现在看不见，应当停止出帧。 */
  frozen: boolean;
}

export const WALLPAPER_FRAME_EVENT = 'echomusic:wallpaper-frame';

const mode = shallowRef<WallpaperFrameMode>({ fps: 0, frozen: false });

/** 只读的当前设定；插件页面里直接读 .value 或放进 watch。 */
export const wallpaperFrameMode = readonly(mode);

/** 当前设定的一次性快照（给逐帧循环用，避免每帧建响应式依赖）。 */
export const readWallpaperFrameMode = (): WallpaperFrameMode => ({
  fps: mode.value.fps,
  frozen: mode.value.frozen,
});

/** 壁纸窗口下发设定；只在真正变化时派发事件，避免每帧都惊动插件。 */
export const setWallpaperFrameMode = (fps: number, frozen: boolean): void => {
  const next: WallpaperFrameMode = { fps: paceFpsOf(fps), frozen: frozen === true };
  const current = mode.value;
  if (next.fps === current.fps && next.frozen === current.frozen) return;
  mode.value = next;
  window.dispatchEvent(
    new CustomEvent<WallpaperFrameMode>(WALLPAPER_FRAME_EVENT, { detail: { ...next } }),
  );
};

/** 监听设定变化，返回取消订阅函数。 */
export const onWallpaperFrameModeChange = (
  handler: (mode: WallpaperFrameMode) => void,
): (() => void) => {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<WallpaperFrameMode>).detail;
    handler({ fps: paceFpsOf(detail?.fps ?? 0), frozen: detail?.frozen === true });
  };
  window.addEventListener(WALLPAPER_FRAME_EVENT, listener);
  return () => window.removeEventListener(WALLPAPER_FRAME_EVENT, listener);
};
