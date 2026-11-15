/**
 * 壁纸的绘制策略：把「是否在放歌、歌词区域被挡住多少、桌面被窗口盖住多少」换算成每块屏的
 * 目标帧率与可见性。这里是纯函数，便于单元测试。
 *
 * 判定看的是「歌词区域」而不是整块屏：桌面被窗口盖住大半、但歌词还露着时没有
 * 降帧的必要；反过来歌词区被盖住一半以上，就算屏幕其余部分空着也降帧。
 */
import type { WallpaperPauseBehavior } from '../../shared/wallpaper';

/** 歌词区域被窗口挡住的面积超过这个比例就降帧。写死常量，不做成设置项。 */
export const WALLPAPER_OCCLUDED_RATIO = 0.5;
/** 已经降帧之后，要退到这个比例以下才恢复满帧（滞回）。 */
export const WALLPAPER_OCCLUDED_EXIT_RATIO = 0.4;
/** 歌词区域（没有歌词区域时退回整块屏）被挡住超过这个比例就停止刷新（画面冻在原地，不隐藏）。 */
export const WALLPAPER_PAUSE_RATIO = 0.8;
/**
 * 已经冻结之后，要退到这个比例以下才解冻。
 * 单个阈值会让窗口边缘正好压在 80% 上来回动时反复冻结/解冻 —— 每次解冻都要整页重绘，
 * 比一直降帧更费电，看起来就是「冻着冻着突然动一下」。
 */
export const WALLPAPER_PAUSE_EXIT_RATIO = 0.68;

/**
 * 'fullscreen' 不是这里算出来的：独占全屏时主进程已经把窗口销毁了，
 * 只是拿它当状态页上的展示原因，判定链里没有这一档。
 */
export type WallpaperFrameReason =
  'disabled' | 'detached' | 'fullscreen' | 'covered' | 'occluded' | 'paused' | 'playing';

export interface WallpaperFrameInput {
  enabled: boolean;
  attached: boolean;
  playing: boolean;
  /** 整块屏被窗口盖住的比例（0~1）。 */
  coverage: number;
  /** 歌词区域被窗口盖住的比例（0~1）。 */
  lyricCoverage: number;
  /** 渲染层是否上报过歌词区域；没有（背景/视频模式）就退回整屏覆盖率判定。 */
  lyricRegionKnown?: boolean;
  pauseBehavior: WallpaperPauseBehavior;
  /** 正常渲染时的目标帧率。 */
  playingFps: number;
  occludedFps: number;
  /** 上一轮判定出的档位：只用来走滞回（冻结/降帧的退出阈值更宽松）。 */
  previousReason?: WallpaperFrameReason;
}

export interface WallpaperFramePolicy {
  frameRate: number;
  visible: boolean;
  reason: WallpaperFrameReason;
}

/** 降帧档：不超过正常播放帧率，也不低于 0。 */
const reducedFps = (input: WallpaperFrameInput): number =>
  Math.min(input.playingFps, Math.max(0, Math.round(input.occludedFps)));

export const resolveWallpaperFrame = (input: WallpaperFrameInput): WallpaperFramePolicy => {
  if (!input.enabled) return { frameRate: 0, visible: false, reason: 'disabled' };
  if (!input.attached) return { frameRate: 0, visible: false, reason: 'detached' };
  // 独占全屏不在这里判：主进程在那种状态下根本不创建壁纸窗口。
  // 被挡住多少，看的是「歌词区域」这一块：有歌词区域就只用它，
  // 没有（背景/视频模式）才退回整块屏的覆盖率。
  const coverRatio = input.lyricRegionKnown ? input.lyricCoverage : input.coverage;
  // 歌词区域被挡住大半：画面冻在原地，窗口挪开后自动续上。
  // 这里不隐藏窗口——用户看到的是「壁纸不动了」，而不是「壁纸没了」。
  const pauseRatio =
    input.previousReason === 'covered' ? WALLPAPER_PAUSE_EXIT_RATIO : WALLPAPER_PAUSE_RATIO;
  if (coverRatio >= pauseRatio) {
    return { frameRate: 0, visible: true, reason: 'covered' };
  }
  if (!input.playing) {
    if (input.pauseBehavior === 'hide') {
      return { frameRate: 0, visible: false, reason: 'paused' };
    }
    // 暂停且保留画面：画面本来就不动，整页冻结即可，不需要「极慢刷新」兜底。
    return { frameRate: 0, visible: true, reason: 'paused' };
  }
  // 歌词被挡住：只降到遮挡档，不停画——挡住它的窗口随时会挪开。
  const occludedRatio =
    input.previousReason === 'occluded' ? WALLPAPER_OCCLUDED_EXIT_RATIO : WALLPAPER_OCCLUDED_RATIO;
  if (coverRatio >= occludedRatio) {
    const fps = reducedFps(input);
    return { frameRate: fps, visible: fps > 0, reason: 'occluded' };
  }
  return { frameRate: Math.max(1, Math.round(input.playingFps)), visible: true, reason: 'playing' };
};
