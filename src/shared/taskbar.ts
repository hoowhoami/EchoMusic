/** 任务栏歌词窗口在空闲区里的对齐方式：播放态贴左端，暂停态那一小块居中。 */
export type TaskbarContentAlign = 'start' | 'center';

/** 播放中显示什么：只要封面、只要歌词、封面与歌词并排。 */
export type TaskbarPlayingDisplay = 'cover' | 'lyrics' | 'both';
/** 暂停中显示什么：只要封面、只要「歌名·歌手」、封面与歌名并排。 */
export type TaskbarPausedDisplay = 'cover' | 'name' | 'both';

export interface TaskbarLyricSettings {
  position: 'auto' | 'left' | 'center' | 'right';
  maxWidth: number;
  fontSize: number;
  fontFamily: string;
  playingDisplay: TaskbarPlayingDisplay;
  pausedDisplay: TaskbarPausedDisplay;
  showTranslation: boolean;
  wordByWord: boolean;
}

export const DEFAULT_TASKBAR_LYRIC_SETTINGS: TaskbarLyricSettings = {
  position: 'auto',
  maxWidth: 400,
  fontSize: 14,
  fontFamily: 'follow',
  playingDisplay: 'both',
  pausedDisplay: 'both',
  showTranslation: true,
  wordByWord: true,
};

const PLAYING_DISPLAYS = ['cover', 'lyrics', 'both'] as const;
const PAUSED_DISPLAYS = ['cover', 'name', 'both'] as const;
const isPlayingDisplay = (input: unknown): input is TaskbarPlayingDisplay =>
  typeof input === 'string' && (PLAYING_DISPLAYS as readonly string[]).includes(input);
const isPausedDisplay = (input: unknown): input is TaskbarPausedDisplay =>
  typeof input === 'string' && (PAUSED_DISPLAYS as readonly string[]).includes(input);

/** 旧版本存的是 showCover / showLyrics / showNowPlaying 三个布尔，只在迁移时读一次。 */
interface LegacyTaskbarDisplaySettings {
  showCover?: unknown;
  showLyrics?: unknown;
  showNowPlaying?: unknown;
}

/**
 * 播放态旧配置折算：「封面 + 歌词」都开算并排，只开一个就是那一项。
 *
 * 三个布尔描述不了同一项在两状态里各显不显（播放只要歌词、暂停只要封面时就无解），
 * 所以改存两档枚举，旧数据先按「并排还是独占」还原，用户升级后看到的样子不变。
 */
const legacyPlayingDisplay = (legacy: LegacyTaskbarDisplaySettings): TaskbarPlayingDisplay => {
  if (legacy.showLyrics === false) return 'cover';
  return legacy.showCover === false ? 'lyrics' : 'both';
};

/** 暂停态旧配置折算：旧版本没有「只有歌名」这一档，关掉封面又不开歌名时退回只看封面。 */
const legacyPausedDisplay = (legacy: LegacyTaskbarDisplaySettings): TaskbarPausedDisplay => {
  if (legacy.showNowPlaying !== true) return 'cover';
  return legacy.showCover === false ? 'name' : 'both';
};

export function normalizeTaskbarLyricSettings(input: unknown = {}): TaskbarLyricSettings {
  const value =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Partial<TaskbarLyricSettings>)
      : {};
  const defaults = DEFAULT_TASKBAR_LYRIC_SETTINGS;
  const legacy = value as Partial<TaskbarLyricSettings> & LegacyTaskbarDisplaySettings;
  // 只有真正存过旧字段的老配置才走折算，全新安装直接取默认（两者 / 两者）。
  const hasLegacyDisplay =
    typeof legacy.showCover === 'boolean' ||
    typeof legacy.showLyrics === 'boolean' ||
    typeof legacy.showNowPlaying === 'boolean';
  const number = (input: unknown, fallback: number, min: number, max: number) =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.round(Math.min(max, Math.max(min, input)))
      : fallback;
  const normalized: TaskbarLyricSettings = {
    position: ['auto', 'left', 'center', 'right'].includes(value.position ?? '')
      ? value.position!
      : defaults.position,
    maxWidth: number(value.maxWidth, defaults.maxWidth, 160, 800),
    fontSize: number(value.fontSize, defaults.fontSize, 11, 22),
    fontFamily:
      typeof value.fontFamily === 'string' && value.fontFamily.trim()
        ? value.fontFamily.trim()
        : defaults.fontFamily,
    playingDisplay: isPlayingDisplay(value.playingDisplay)
      ? value.playingDisplay
      : hasLegacyDisplay
        ? legacyPlayingDisplay(legacy)
        : defaults.playingDisplay,
    pausedDisplay: isPausedDisplay(value.pausedDisplay)
      ? value.pausedDisplay
      : hasLegacyDisplay
        ? legacyPausedDisplay(legacy)
        : defaults.pausedDisplay,
    showTranslation:
      typeof value.showTranslation === 'boolean' ? value.showTranslation : defaults.showTranslation,
    wordByWord: typeof value.wordByWord === 'boolean' ? value.wordByWord : defaults.wordByWord,
  };
  return normalized;
}

/**
 * 原生布局使用任务栏客户区内的物理像素，不能当作屏幕上的 DIP。
 *
 * left/right 相对任务栏客户区 —— 歌词窗口是任务栏的子窗口，setBounds
 * 按父窗口相对坐标解释。
 */
export interface NativeTaskbarLayout {
  left: { x: number; y: number; width: number; height: number };
  right: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  centered: boolean;
  isDark: boolean;
  available: boolean;
}

export interface TaskbarLyricState {
  enabled: boolean;
  visible: boolean;
  isDark: boolean;
  anchor: 'left' | 'center' | 'right';
  maxWidth: number;
  settings: TaskbarLyricSettings;
}

export function resolveTaskbarLyricRegion(
  layout: NativeTaskbarLayout,
  settings: TaskbarLyricSettings,
) {
  if (!layout.available || !Number.isFinite(layout.scaleFactor) || layout.scaleFactor <= 0)
    return null;
  // center 也要先落到某一块空闲区上：两块空闲区中间隔着任务栏按钮，
  // 没法跨簇居中，只能在选中那一块里居中。
  const side =
    settings.position === 'auto' || settings.position === 'center'
      ? layout.centered && layout.left.width >= layout.right.width
        ? 'left'
        : 'right'
      : settings.position;
  /**
   * 内容在空闲区里的横向偏移。center 取正中，并夹在两侧 8px 内边距之间，
   * 空闲区只比内容宽一点时也不会贴到任务栏按钮上。
   */
  const alignOffset = (anchor: 'left' | 'center' | 'right', available: number, content: number) => {
    if (anchor === 'right') return available - content - 8;
    if (anchor === 'center')
      return Math.max(8, Math.min(available - content - 8, (available - content) / 2));
    return 8;
  };
  const resolveSide = (regionSide: 'left' | 'right') => {
    const rect = layout[regionSide];
    // 可用区域与内容锚定分开：回退到另一块空闲区时仍保留用户选择的对齐方向。
    const anchor = settings.position === 'auto' ? regionSide : settings.position;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const scale = layout.scaleFactor;
    const width = Math.floor(Math.min(settings.maxWidth, rect.width / scale - 16));
    const height = Math.floor(rect.height / scale);
    if (width < 160 || height < 28 || height > 100) return null;
    return {
      anchor,
      bounds: {
        x: Math.round(rect.x / scale + alignOffset(anchor, rect.width / scale, width)),
        y: Math.round(rect.y / scale),
        width,
        height,
      },
    };
  };
  // 指定侧作为首选；没有安全空间时使用另一侧，两侧都不足才隐藏。
  return resolveSide(side) ?? resolveSide(side === 'left' ? 'right' : 'left');
}
