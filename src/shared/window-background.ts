export interface WindowBackground {
  transparency: number;
  frosted: boolean;
  color: string;
}

export const DEFAULT_WINDOW_BACKGROUND: WindowBackground = {
  transparency: 0,
  frosted: false,
  color: '',
};

export function normalizeWindowBackground(
  value: Partial<WindowBackground> | null,
): WindowBackground {
  const transparency = Number(value?.transparency);
  return {
    transparency: Number.isFinite(transparency) ? Math.min(100, Math.max(0, transparency)) : 0,
    frosted: value?.frosted === true,
    color:
      typeof value?.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '',
  };
}
