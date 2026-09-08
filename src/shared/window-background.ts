export interface WindowBackground {
  enabled: boolean;
  transparency: number;
  frosted: boolean;
  color: string;
}

export const DEFAULT_WINDOW_BACKGROUND: WindowBackground = {
  enabled: false,
  transparency: 0,
  frosted: false,
  color: '',
};

export function normalizeWindowBackground(
  value: Partial<WindowBackground> | null,
): WindowBackground {
  const transparency = Number(value?.transparency);
  return {
    enabled: value?.enabled === true,
    transparency: Number.isFinite(transparency) ? Math.min(100, Math.max(0, transparency)) : 0,
    frosted: value?.frosted === true,
    color:
      typeof value?.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '',
  };
}

// The native window mode is fixed until the window is recreated. Keep saved
// preferences separate from the appearance that the current window can use.
export function resolveWindowBackground(
  value: WindowBackground,
  activeEnabled: boolean,
): WindowBackground {
  return activeEnabled
    ? { ...normalizeWindowBackground(value), enabled: true }
    : { ...DEFAULT_WINDOW_BACKGROUND };
}
