export interface TaskbarLyricSettings {
  position: 'auto' | 'left' | 'right';
  maxWidth: number;
  fontSize: number;
  showCover: boolean;
  showTranslation: boolean;
  wordByWord: boolean;
}

export const DEFAULT_TASKBAR_LYRIC_SETTINGS: TaskbarLyricSettings = {
  position: 'auto',
  maxWidth: 400,
  fontSize: 14,
  showCover: true,
  showTranslation: true,
  wordByWord: true,
};

export function normalizeTaskbarLyricSettings(input: unknown = {}): TaskbarLyricSettings {
  const value =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Partial<TaskbarLyricSettings>)
      : {};
  const defaults = DEFAULT_TASKBAR_LYRIC_SETTINGS;
  const number = (input: unknown, fallback: number, min: number, max: number) =>
    typeof input === 'number' && Number.isFinite(input)
      ? Math.round(Math.min(max, Math.max(min, input)))
      : fallback;
  return {
    position: ['auto', 'left', 'right'].includes(value.position ?? '')
      ? value.position!
      : defaults.position,
    maxWidth: number(value.maxWidth, defaults.maxWidth, 160, 800),
    fontSize: number(value.fontSize, defaults.fontSize, 11, 22),
    showCover: typeof value.showCover === 'boolean' ? value.showCover : defaults.showCover,
    showTranslation:
      typeof value.showTranslation === 'boolean' ? value.showTranslation : defaults.showTranslation,
    wordByWord: typeof value.wordByWord === 'boolean' ? value.wordByWord : defaults.wordByWord,
  };
}

/** 原生布局使用任务栏客户区内的物理像素，不能当作屏幕上的 DIP。 */
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
  anchor: 'left' | 'right';
  maxWidth: number;
  settings: TaskbarLyricSettings;
}

export function resolveTaskbarLyricRegion(
  layout: NativeTaskbarLayout,
  settings: TaskbarLyricSettings,
) {
  if (!layout.available || !Number.isFinite(layout.scaleFactor) || layout.scaleFactor <= 0)
    return null;
  const side =
    settings.position === 'auto'
      ? layout.centered && layout.left.width >= layout.right.width
        ? 'left'
        : 'right'
      : settings.position;
  const rect = layout[side];
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const scale = layout.scaleFactor;
  const width = Math.floor(Math.min(settings.maxWidth, rect.width / scale - 16));
  const height = Math.floor(rect.height / scale);
  if (width < 160 || height < 28 || height > 100) return null;
  return {
    anchor: side,
    bounds: {
      x: Math.round(rect.x / scale + (side === 'right' ? rect.width / scale - width - 8 : 8)),
      y: Math.round(rect.y / scale),
      width,
      height,
    },
  };
}
