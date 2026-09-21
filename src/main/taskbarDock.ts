export type TaskbarEdge = 'top' | 'bottom' | 'left' | 'right';
export type TaskbarDockMode = 'taskbar' | 'work-area' | 'screen-edge';
export type TaskbarRect = { x: number; y: number; width: number; height: number };
export type TaskbarDisplay = {
  bounds: TaskbarRect;
  workArea: TaskbarRect;
  scaleFactor?: number;
};
/** All geometry is in Electron DIPs, including native shell rectangles. */
export type TaskbarShellLayout = {
  bounds: TaskbarRect;
  reliable: boolean;
  occupied: TaskbarRect[];
  playerVisible?: boolean;
  shellAbovePlayer?: boolean;
  foregroundFullscreen?: boolean;
  playerBounds?: TaskbarRect;
};
export type TaskbarDockPlacement = {
  bounds: TaskbarRect;
  edge: TaskbarEdge;
  mode: TaskbarDockMode;
  taskbarThickness: number;
};

const MARGIN = 8;
const right = (r: TaskbarRect) => r.x + r.width;
const bottom = (r: TaskbarRect) => r.y + r.height;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const shellEdge = (display: TaskbarDisplay, shell?: TaskbarShellLayout): TaskbarEdge | null => {
  if (!shell) return null;
  const b = display.bounds;
  const r = shell.bounds;
  return r.width >= r.height
    ? Math.abs(r.y - b.y) < Math.abs(bottom(r) - bottom(b))
      ? 'top'
      : 'bottom'
    : Math.abs(r.x - b.x) < Math.abs(right(r) - right(b))
      ? 'left'
      : 'right';
};

/** Subtract Start/app/tray intervals; never infer "empty" from a failed probe. */
const findHorizontalSpace = (
  bar: TaskbarRect,
  occupied: TaskbarRect[],
  width: number,
  minimumWidth: number,
) => {
  let cursor = bar.x + MARGIN;
  const end = right(bar) - MARGIN;
  const intervals = occupied
    .filter((r) => r.y < bottom(bar) && bottom(r) > bar.y)
    .map((r) => [Math.max(cursor, r.x - MARGIN), Math.min(end, right(r) + MARGIN)])
    .filter(([start, stop]) => stop > start)
    .sort((a, b) => a[0] - b[0]);
  const gaps: { x: number; width: number }[] = [];
  for (const [start, stop] of intervals) {
    if (start > cursor) gaps.push({ x: cursor, width: start - cursor });
    cursor = Math.max(cursor, stop);
  }
  if (cursor < end) gaps.push({ x: cursor, width: end - cursor });
  const fit =
    gaps.find((gap) => gap.width >= width) ??
    gaps.filter((gap) => gap.width >= minimumWidth).sort((a, b) => b.width - a.width)[0];
  return fit ? { x: Math.ceil(fit.x), width: Math.floor(Math.min(width, fit.width)) } : null;
};

/**
 * Match the taskbar's logical height so Windows DPI scaling stays legible.
 * Overlay only a positively identified free interval. Vertical, crowded,
 * auto-hidden and unsupported shell layouts use the adjacent usable desktop.
 */
export const calculateTaskbarDock = (
  display: TaskbarDisplay,
  preferredEdge?: TaskbarEdge,
  shell?: TaskbarShellLayout,
): TaskbarDockPlacement => {
  const { bounds: b, workArea: w } = display;
  const gaps: Record<TaskbarEdge, number> = {
    top: Math.max(0, w.y - b.y),
    bottom: Math.max(0, bottom(b) - bottom(w)),
    left: Math.max(0, w.x - b.x),
    right: Math.max(0, right(b) - right(w)),
  };
  const nativeEdge = shellEdge(display, shell);
  const detected = (['bottom', 'top', 'left', 'right'] as const)
    .filter((edge) => gaps[edge] >= 18)
    .sort((a, c) => gaps[c] - gaps[a])[0];
  const edge = nativeEdge ?? detected ?? preferredEdge ?? 'bottom';
  const horizontal = edge === 'top' || edge === 'bottom';
  const thickness = gaps[edge] >= 18 ? gaps[edge] : 0;
  const nativeThickness = shell ? (horizontal ? shell.bounds.height : shell.bounds.width) : 0;
  const height = Math.max(
    1,
    Math.min(
      Math.round(clamp(horizontal ? thickness || nativeThickness || 48 : 48, 32, 64)),
      w.height - 2 * Math.min(MARGIN, w.height / 4),
    ),
  );
  const availableWidth = Math.max(1, w.width - 2 * Math.min(MARGIN, w.width / 4));
  const minimumWidth = Math.min(availableWidth, Math.max(160, height * 3.875));
  const width = Math.floor(Math.min(height * (504 / 64), availableWidth));
  const size = { width, height };

  if (horizontal && thickness && shell?.reliable) {
    // Use the measured shell CLIENT surface, not the work-area gap: custom
    // taskbars, borders and rounding can make those two rectangles disagree.
    const inset = 1 / Math.max(1, display.scaleFactor || 1);
    const left = Math.ceil(Math.max(b.x, shell.bounds.x));
    const top = Math.ceil(Math.max(b.y, shell.bounds.y) + inset);
    const stopX = Math.floor(Math.min(right(b), right(shell.bounds)));
    const stopY = Math.floor(Math.min(bottom(b), bottom(shell.bounds)) - inset);
    const strip: TaskbarRect = {
      x: left,
      y: top,
      width: stopX - left,
      height: stopY - top,
    };
    const fittedHeight = Math.min(64, strip.height);
    const fittedWidth = Math.min(availableWidth, Math.floor(fittedHeight * (504 / 64)));
    const space = findHorizontalSpace(
      strip,
      shell.occupied,
      fittedWidth,
      Math.min(fittedWidth, minimumWidth),
    );
    if (space && fittedHeight >= 20) {
      return {
        bounds: {
          ...space,
          height: fittedHeight,
          y: Math.floor(strip.y + (strip.height - fittedHeight) / 2),
        },
        edge,
        mode: 'taskbar',
        taskbarThickness: strip.height,
      };
    }
  }

  // Reserve a hidden shell's revealed area, so revealing it cannot cover controls.
  const reserve = thickness ? 0 : Math.max(nativeThickness, 48);
  const minX = w.x + Math.min(MARGIN, w.width / 4);
  const maxX = Math.max(minX, right(w) - width - MARGIN);
  const minY = w.y + Math.min(MARGIN, w.height / 4);
  const maxY = Math.max(minY, bottom(w) - height - MARGIN);
  const x = edge === 'right' ? maxX - reserve : minX + (edge === 'left' ? reserve : 0);
  const y = edge === 'top' ? minY + reserve : maxY - (edge === 'bottom' ? reserve : 0);
  return {
    bounds: { ...size, x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)) },
    edge,
    mode: thickness ? 'work-area' : 'screen-edge',
    taskbarThickness: thickness,
  };
};
