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
  /** 压暗的起点：离屏幕中心的归一化距离。 */
  edgeStart: number;
  /** 贴边压黑的浓度。 */
  edgeDarkness: number;
  /** 浮尘粒子的数量系数（1 = 默认）。 */
  particleDensity: number;
  /** 浮尘粒子的尺寸系数（1 = 默认）。 */
  particleSize: number;
  /** 是否把画面压暗（中间浅、四周黑）。 */
  dimEnabled: boolean;
  /** 是否叠加浮尘粒子。 */
  particleEnabled: boolean;
  /** 壁纸是否穿透底色层：开启时桌面壁纸直通，关闭时由配色底色把壁纸盖住。 */
  passthroughEnabled: boolean;
}

export const DEFAULT_WALLPAPER_TEXTURE: WallpaperTextureSettings = {
  edgeStart: 0.5,
  edgeDarkness: 0.5,
  particleDensity: 1,
  particleSize: 1,
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
  /** 歌词颜色；空字符串表示跟随播放页皮肤。 */
  lyric: string;
}

export const WALLPAPER_PALETTES: WallpaperPalette[] = [
  { key: 'ink', label: '墨黑', dim: '#000000', particle: '#ffffff', lyric: '' },
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

const FRAME_PROFILE_KEYS = WALLPAPER_FRAME_PRESETS.map((item) => item.key);

export const getWallpaperFramePreset = (
  key: WallpaperFrameProfile | undefined,
): WallpaperFramePreset =>
  WALLPAPER_FRAME_PRESETS.find((item) => item.key === key) ??
  WALLPAPER_FRAME_PRESETS.find((item) => item.key === DEFAULT_WALLPAPER_FRAME_PROFILE) ??
  WALLPAPER_FRAME_PRESETS[0];

export interface WallpaperSettings {
  /** 目标显示器 id（Electron Display.id 的字符串形式）；首次启动会落成主屏 id。 */
  displayIds: string[];
  contentMode: WallpaperContentMode;
  pauseBehavior: WallpaperPauseBehavior;
  /** 绘制性能档位：决定正常播放与桌面被遮挡时各自的帧率。 */
  frameProfile: WallpaperFrameProfile;
  /** 「仅歌词」的整套配色。 */
  palette: WallpaperPaletteKey;
  /** 「仅歌词」的画面质感参数。 */
  texture: WallpaperTextureSettings;
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  displayIds: [],
  contentMode: 'follow',
  pauseBehavior: 'freeze',
  frameProfile: DEFAULT_WALLPAPER_FRAME_PROFILE,
  palette: DEFAULT_WALLPAPER_PALETTE_KEY,
  texture: { ...DEFAULT_WALLPAPER_TEXTURE },
};

/** 可供选择的显示器。 */
/**
 * 系统桌面壁纸。url 是 data URL（可能为空：读不到文件或壁纸是纯色），
 * style 是 Windows 的铺法，用于在页面里按同样方式铺开。
 */

export interface WallpaperDisplay {
  id: string;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

/** 主进程回给渲染层的壁纸运行状态。 */
/** 歌词区域在壁纸窗口里的位置（CSS 像素，相对窗口左上角）。 */
export interface WallpaperLyricRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 窗口的 devicePixelRatio，主进程换算屏幕物理像素时用。 */
  dpr: number;
}

export interface WallpaperState {
  enabled: boolean;
  supported: boolean;
  attached: boolean;
  activeDisplayIds: string[];
  coverage: number;
  fullscreen: boolean;
  /** 当前生效的帧率；0 表示暂停绘制。 */
  frameRate: number;
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
  const raw = (input ?? {}) as Partial<WallpaperTextureSettings>;
  return {
    edgeStart: clampDecimal(raw.edgeStart, DEFAULT_WALLPAPER_TEXTURE.edgeStart, 0, 1),
    edgeDarkness: clampDecimal(raw.edgeDarkness, DEFAULT_WALLPAPER_TEXTURE.edgeDarkness, 0, 1),
    particleDensity: clampDecimal(
      raw.particleDensity,
      DEFAULT_WALLPAPER_TEXTURE.particleDensity,
      0,
      2,
    ),
    particleSize: clampDecimal(raw.particleSize, DEFAULT_WALLPAPER_TEXTURE.particleSize, 0, 2),
    dimEnabled: raw.dimEnabled !== false,
    particleEnabled: raw.particleEnabled !== false,
    // 默认关闭：老配置里没有这个字段时也按「不穿透」处理。
    passthroughEnabled: raw.passthroughEnabled === true,
  };
};

export const normalizeWallpaperSettings = (
  input: Partial<WallpaperSettings> | null | undefined = {},
): WallpaperSettings => {
  const raw = (input ?? {}) as Partial<WallpaperSettings>;
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
    frameProfile: FRAME_PROFILE_KEYS.includes(raw.frameProfile as WallpaperFrameProfile)
      ? (raw.frameProfile as WallpaperFrameProfile)
      : DEFAULT_WALLPAPER_FRAME_PROFILE,
    palette: PALETTE_KEYS.includes(raw.palette as WallpaperPaletteKey)
      ? (raw.palette as WallpaperPaletteKey)
      : DEFAULT_WALLPAPER_PALETTE_KEY,
    texture: normalizeTexture(raw.texture),
  };
};
