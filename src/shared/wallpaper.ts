/**
 * 桌面壁纸显示设置。
 *
 * 壁纸窗口挂在 Explorer 的桌面层（WorkerW）上，内容是主界面歌词页的只读副本，
 * 这里只描述「用哪些屏、显示什么、怎么省电」。
 */

/** 暂停时的行为：保持最后一句歌词静止，或收起壁纸露出系统壁纸。 */
export type WallpaperPauseBehavior = 'freeze' | 'hide';

/** 内容模式：跟随主界面歌词页，或只把歌词铺到桌面上（露出系统壁纸）。 */
export type WallpaperContentMode = 'follow' | 'lyric';

/** 「仅歌词」画面的质感参数：压暗层与浮尘粒子。 */
export interface WallpaperTextureSettings {
  /** 屏幕中心的不透明度（0~1），就是画面上的实际浓度，默认 0.15。 */
  centerDim: number;
  /** 屏幕边缘的不透明度（0~1），默认 0.85。 */
  edgeDim: number;
  /** 中心到边缘的过渡曲线（0~1）：越小越平，越大则中间变化小、靠边变暗快。 */
  curve: number;
  /** 浮尘粒子的数量系数（1 = 默认）。 */
  particleDensity: number;
  /** 浮尘粒子的尺寸系数（1 = 默认）。 */
  particleSize: number;
  /** 浮尘粒子的运动速度系数（1 = 默认，与数量/大小同一口径）：默认已比原先快 1.5 倍，0 静止。 */
  particleSpeed: number;
  /** 是否把画面压暗（中间浅、四周黑）。 */
  dimEnabled: boolean;
  /** 是否叠加浮尘粒子。 */
  particleEnabled: boolean;
  /** 壁纸是否穿透底色层：开启时桌面壁纸直通，关闭时由配色底色把壁纸盖住。 */
  passthroughEnabled: boolean;
}

export const DEFAULT_WALLPAPER_TEXTURE: WallpaperTextureSettings = {
  centerDim: 0.15,
  edgeDim: 0.85,
  curve: 0.5,
  particleDensity: 1,
  particleSize: 1,
  particleSpeed: 1,
  dimEnabled: true,
  particleEnabled: true,
  passthroughEnabled: false,
};

/** 「仅歌词」的整套配色：压暗底色、浮尘颜色与歌词颜色。 */
export type WallpaperPaletteKey = 'ink' | 'warm' | 'ocean' | 'dusk' | 'moss';

export interface WallpaperPalette {
  key: WallpaperPaletteKey;
  label: string;
  /** 压暗层的底色。 */
  dim: string;
  /** 浮尘粒子的颜色。 */
  particle: string;
  /** 歌词颜色；每套配色都给具体色值，不靠空字符串回退到播放页皮肤。 */
  lyric: string;
}

export const WALLPAPER_PALETTES: WallpaperPalette[] = [
  { key: 'ink', label: '墨黑', dim: '#000000', particle: '#ffffff', lyric: '#ffffff' },
  { key: 'warm', label: '暖褐', dim: '#190802', particle: '#ffc48d', lyric: '#ff9d4a' },
  { key: 'ocean', label: '深海', dim: '#020c15', particle: '#9cc4ff', lyric: '#5f9bff' },
  { key: 'dusk', label: '暮紫', dim: '#110318', particle: '#c6a4ff', lyric: '#9d63ff' },
  { key: 'moss', label: '苔绿', dim: '#020e08', particle: '#a1e8bd', lyric: '#5fd693' },
];

export const DEFAULT_WALLPAPER_PALETTE_KEY: WallpaperPaletteKey = 'ink';

export const getWallpaperPalette = (key: WallpaperPaletteKey | undefined): WallpaperPalette =>
  WALLPAPER_PALETTES.find((item) => item.key === key) ?? WALLPAPER_PALETTES[0];

/** 绘制性能档位：一个档位同时决定「正常播放」与「桌面被遮挡」两档帧率。 */
export type WallpaperFrameProfile =
  | 'smooth'
  | 'flow'
  | 'high'
  | 'plus'
  | 'fast'
  | 'max'
  | 'ceiling'
  | 'turbo'
  | 'ultra'
  | 'extreme'
  | 'insane';

export interface WallpaperFramePreset {
  key: WallpaperFrameProfile;
  label: string;
  /** 正常渲染时的目标帧率。 */
  playing: number;
  /** 桌面被窗口挡住时的目标帧率。 */
  occluded: number;
}

/** 最低 30 帧（再低歌词滚动会明显顿），最高 240Hz；档位只是上限，屏幕刷新率更低时由合成器自动压回。 */
export const WALLPAPER_FRAME_PRESETS: WallpaperFramePreset[] = [
  { key: 'smooth', label: '流畅', playing: 30, occluded: 10 },
  { key: 'flow', label: '顺滑', playing: 45, occluded: 15 },
  { key: 'high', label: '高帧', playing: 60, occluded: 20 },
  { key: 'plus', label: '进阶', playing: 75, occluded: 25 },
  { key: 'fast', label: '极速', playing: 90, occluded: 30 },
  { key: 'max', label: '满血', playing: 120, occluded: 40 },
  { key: 'ceiling', label: '天花板', playing: 144, occluded: 48 },
  { key: 'turbo', label: '超频', playing: 165, occluded: 55 },
  { key: 'ultra', label: '超凡', playing: 180, occluded: 60 },
  { key: 'extreme', label: '极致', playing: 200, occluded: 66 },
  { key: 'insane', label: '极限', playing: 240, occluded: 80 },
];

export const DEFAULT_WALLPAPER_FRAME_PROFILE: WallpaperFrameProfile = 'high';

/** 帧率量程：滑杆轨道固定铺满这段区间，真正能拖到多少由这块屏的刷新率决定。 */
export const WALLPAPER_MIN_FPS = 30;
export const WALLPAPER_MAX_FPS = 240;

/** 桌面被挡住时的省电档 = 当前帧率的 20%，跟着设置走，不再单独配一档。 */
export const WALLPAPER_OCCLUDED_RATIO = 0.2;

/** 省电档帧率：四舍五入到整数，最低 1 帧（0 会被当成暂停）。 */
export const occludedFpsOf = (fps: number): number =>
  Math.max(1, Math.round(fps * WALLPAPER_OCCLUDED_RATIO));

/** 把任意来源的帧率夹进量程；非数字按默认档处理前的兜底由调用方决定。 */
export const clampFrameRate = (fps: number): number =>
  Math.min(WALLPAPER_MAX_FPS, Math.max(WALLPAPER_MIN_FPS, Math.round(fps)));

/**
 * 下发给插件的节奏帧率：0 表示不限（主窗口，或壁纸没开帧率预算）。
 * 与 clampFrameRate 的区别是不能把 0 抬成 30 —— 省电档本身可能只有几帧，
 * 而「不限」必须能和「很低的帧率」区分开。
 */
export const paceFpsOf = (fps: number): number =>
  Number.isFinite(fps) && fps > 0 ? Math.min(WALLPAPER_MAX_FPS, Math.round(fps)) : 0;

export const getWallpaperFramePreset = (
  key: WallpaperFrameProfile | undefined,
): WallpaperFramePreset =>
  WALLPAPER_FRAME_PRESETS.find((item) => item.key === key) ??
  WALLPAPER_FRAME_PRESETS.find((item) => item.key === DEFAULT_WALLPAPER_FRAME_PROFILE) ??
  WALLPAPER_FRAME_PRESETS[0];

/**
 * 把持久化的屏幕 id 收敛到「当前真实存在的屏幕」上。
 *
 * Electron 在 Windows 上的 Display.id 并不稳定：换缩放、重挂、驱动更新、重启都可能换号。
 * 旧配置里留下的号一旦全部失效，设置页每块屏的开关都会判成关，主进程又回落到主屏接着画，
 * 看上去就是「开关全关着，壁纸还在动」。所以两边都先过一遍这里：交集为空时落回主屏。
 */
export const pickDisplayIds = (
  ids: readonly string[] | undefined,
  available: readonly string[],
  fallback: string,
): string[] => {
  const alive = new Set(available);
  const kept: string[] = [];
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || !alive.has(id) || kept.includes(id)) continue;
    kept.push(id);
  }
  return kept.length > 0 ? kept : [fallback];
};

export interface WallpaperSettings {
  /** 目标显示器 id（Electron Display.id 的字符串形式）；首次启动会落成主屏 id。 */
  displayIds: string[];
  contentMode: WallpaperContentMode;
  pauseBehavior: WallpaperPauseBehavior;
  /**
   * 全局默认绘制帧率（帧/秒）。档位不再是固定几档，滑杆连续取值；
   * 桌面被挡住时的省电档按这个数的 20% 自动算。
   */
  frameRate: number;
  /**
   * 每块屏自己的绘制帧率（显示器 id → 帧/秒）。没配过的屏回落到 frameRate。
   * 多屏的刷新率常常不一样（144Hz 副屏配 60Hz 主屏），一刀切的帧率必然有一块屏在空烧。
   */
  frameRates: Record<string, number>;
  /** 「仅歌词」的整套配色。 */
  palette: WallpaperPaletteKey;
  /** 「仅歌词」的画面质感参数。 */
  texture: WallpaperTextureSettings;
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  displayIds: [],
  contentMode: 'follow',
  pauseBehavior: 'freeze',
  frameRate:
    WALLPAPER_FRAME_PRESETS.find((item) => item.key === DEFAULT_WALLPAPER_FRAME_PROFILE)?.playing ??
    60,
  frameRates: {},
  palette: DEFAULT_WALLPAPER_PALETTE_KEY,
  texture: { ...DEFAULT_WALLPAPER_TEXTURE },
};

/** 可供选择的显示器。 */

export interface WallpaperDisplay {
  id: string;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  /** 这块屏的刷新率（Hz）；系统没报出来时是 0。 */
  refreshRate: number;
  primary: boolean;
}

/** 歌词区域在壁纸窗口里的位置（CSS 像素，相对窗口左上角）。 */
export interface WallpaperLyricRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 窗口的 devicePixelRatio，主进程换算屏幕物理像素时用。 */
  dpr: number;
}

/** 主进程回给渲染层的壁纸运行状态。 */
export interface WallpaperState {
  enabled: boolean;
  supported: boolean;
  attached: boolean;
  activeDisplayIds: string[];
  coverage: number;
  /** 当前生效的帧率；0 表示暂停绘制。 */
  frameRate: number;
  /** 每块屏当前生效的帧率（显示器 id → 帧/秒），0 表示这块屏暂停绘制。 */
  activeFrameRates: Record<string, number>;
  /** 每块屏当前为 0 帧的原因（covered/occluded/paused/fullscreen），供设置页说清楚为什么停了。 */
  activeReasons: Record<string, string>;
  /** 当前策略原因，便于渲染层决定是否冻结动画。 */
  reason: string;
  displays: WallpaperDisplay[];
  settings: WallpaperSettings;
}

const CONTENT_MODES: WallpaperContentMode[] = ['follow', 'lyric'];

const PALETTE_KEYS: WallpaperPaletteKey[] = WALLPAPER_PALETTES.map((item) => item.key);

const clampDecimal = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const normalizeTexture = (
  input: Partial<WallpaperTextureSettings> | null | undefined,
): WallpaperTextureSettings => {
  const raw = (input ?? {}) as Partial<WallpaperTextureSettings> & {
    // 旧版字段：只在迁移老配置时用，读出来立刻换算成新口径。
    edgeStart?: number;
    edgeDarkness?: number;
  };
  const legacy = typeof raw.edgeDarkness === 'number' || typeof raw.edgeStart === 'number';
  // 旧版中心压暗是「滑块值 × 0.3」的映射，这里反算回真实浓度；旧版压黑范围与曲线同义。
  const centerDim = legacy
    ? clampDecimal(
        typeof raw.centerDim === 'number'
          ? raw.centerDim * 0.3
          : DEFAULT_WALLPAPER_TEXTURE.centerDim,
        DEFAULT_WALLPAPER_TEXTURE.centerDim,
        0,
        1,
      )
    : clampDecimal(raw.centerDim, DEFAULT_WALLPAPER_TEXTURE.centerDim, 0, 1);
  return {
    centerDim,
    edgeDim: legacy
      ? clampDecimal(raw.edgeDarkness, DEFAULT_WALLPAPER_TEXTURE.edgeDim, 0, 1)
      : clampDecimal(raw.edgeDim, DEFAULT_WALLPAPER_TEXTURE.edgeDim, 0, 1),
    curve: legacy
      ? clampDecimal(raw.edgeStart, DEFAULT_WALLPAPER_TEXTURE.curve, 0, 1)
      : clampDecimal(raw.curve, DEFAULT_WALLPAPER_TEXTURE.curve, 0, 1),
    particleDensity: clampDecimal(
      raw.particleDensity,
      DEFAULT_WALLPAPER_TEXTURE.particleDensity,
      0,
      2,
    ),
    particleSize: clampDecimal(raw.particleSize, DEFAULT_WALLPAPER_TEXTURE.particleSize, 0, 2),
    particleSpeed: clampDecimal(raw.particleSpeed, DEFAULT_WALLPAPER_TEXTURE.particleSpeed, 0, 2),
    dimEnabled: raw.dimEnabled !== false,
    particleEnabled: raw.particleEnabled !== false,
    // 默认关闭：老配置里没有这个字段时也按「不穿透」处理。
    passthroughEnabled: raw.passthroughEnabled === true,
  };
};

/**
 * 老配置里存的是档位名（'insane' 这种），新配置存帧数。
 * 这里把两种写法都读成帧数，读不出来返回 null 交给调用方兜底。
 */
const readFrameRate = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return clampFrameRate(value);
  if (typeof value === 'string') {
    const preset = WALLPAPER_FRAME_PRESETS.find((item) => item.key === value);
    if (preset) return clampFrameRate(preset.playing);
  }
  return null;
};

/** 每块屏的帧率表：键为显示器 id，值夹进量程；认得档位名的老值就地换算，其余丢掉。 */
const normalizeFrameRates = (input: unknown): Record<string, number> => {
  const next: Record<string, number> = {};
  if (!input || typeof input !== 'object') return next;
  for (const [rawId, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const id = String(rawId).trim();
    if (!id) continue;
    const fps = readFrameRate(rawValue);
    if (fps === null) continue;
    next[id] = fps;
  }
  return next;
};

/**
 * 某块屏实际用的帧率：单独配过用它，没配过回落到全局那一个。
 * 主进程算策略、设置页显示滑杆都走这里，两边不会各算一套。
 */
export const frameRateOf = (
  settings: Pick<WallpaperSettings, 'frameRate' | 'frameRates'>,
  displayId: string,
): number => settings.frameRates?.[displayId] ?? settings.frameRate;

/**
 * 把每屏帧率收敛到「当前真实存在的屏 + 这块屏真实的刷新率」。
 *
 * 两件事只能在这里收：屏幕重插、换口之后 id 会变，旧屏的键再没人读得懂，留着只会越攒越多；
 * 用户在系统里把屏从 144Hz 降到 60Hz 之后，存下来的 144 不会自己变小，界面上就会出现
 * 「设定 144 帧 / 当前 60 帧」这种自相矛盾的显示。
 */
export const reconcileFrameRates = (
  rates: Record<string, number>,
  displays: readonly Pick<WallpaperDisplay, 'id' | 'refreshRate'>[],
): { rates: Record<string, number>; changed: boolean } => {
  const limits = new Map(displays.map((display) => [display.id, display.refreshRate]));
  const next: Record<string, number> = {};
  let changed = false;
  for (const [id, value] of Object.entries(rates ?? {})) {
    const limit = limits.get(id);
    // 屏已经不在了：这个键没有任何读者，直接丢掉。
    if (limit === undefined) {
      changed = true;
      continue;
    }
    const capped = limit > 0 ? Math.min(value, limit) : value;
    if (capped !== value) changed = true;
    next[id] = capped;
  }
  return { rates: next, changed };
};

export const normalizeWallpaperSettings = (
  input: Partial<WallpaperSettings> | null | undefined = {},
): WallpaperSettings => {
  const raw = (input ?? {}) as Partial<WallpaperSettings> & {
    // 老配置字段：存的是档位名，读出来立刻换算成帧数，之后一律只认 frameRate/frameRates。
    frameProfile?: unknown;
    frameProfiles?: unknown;
    frameRate?: unknown;
    frameRates?: unknown;
  };
  const ids = Array.isArray(raw.displayIds)
    ? raw.displayIds
        .filter((id) => typeof id === 'string' && id.trim().length > 0)
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0)
    : DEFAULT_WALLPAPER_SETTINGS.displayIds;
  return {
    displayIds: Array.from(new Set(ids)),
    contentMode: CONTENT_MODES.includes(raw.contentMode as WallpaperContentMode)
      ? (raw.contentMode as WallpaperContentMode)
      : DEFAULT_WALLPAPER_SETTINGS.contentMode,
    pauseBehavior: raw.pauseBehavior === 'hide' ? 'hide' : 'freeze',
    // 老配置读 frameProfile（档位名），新配置读 frameRate（帧数），两者都换算成帧数。
    frameRate:
      readFrameRate(raw.frameRate) ??
      readFrameRate(raw.frameProfile) ??
      DEFAULT_WALLPAPER_SETTINGS.frameRate,
    frameRates: normalizeFrameRates(raw.frameRates ?? raw.frameProfiles),
    palette: PALETTE_KEYS.includes(raw.palette as WallpaperPaletteKey)
      ? (raw.palette as WallpaperPaletteKey)
      : DEFAULT_WALLPAPER_PALETTE_KEY,
    texture: normalizeTexture(raw.texture),
  };
};
