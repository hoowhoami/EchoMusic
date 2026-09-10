/** All geometry is Electron screen DIP, never renderer pixels or device pixels. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowDisplay {
  id: number;
  workArea: WindowRect;
  bounds: WindowRect;
}
export const MAIN_WINDOW_DEFAULT_SIZE = { width: 1150, height: 750 };
export const MAIN_WINDOW_MIN_SIZE = { width: 1100, height: 650 };

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 0x7fffffff;
export const validWindowRect = (value: Partial<WindowRect>): value is WindowRect =>
  finite(value.x) &&
  finite(value.y) &&
  finite(value.width) &&
  finite(value.height) &&
  value.width > 0 &&
  value.height > 0;

export const displayWorkArea = (display: WindowDisplay): WindowRect =>
  validWindowRect(display.workArea) ? display.workArea : display.bounds;

/** Wayland owns placement. Keep only the application minimum, without monitor heuristics. */
export function resolveWaylandWindowSize(saved: Partial<WindowRect> | null) {
  return {
    bounds: windowSize(saved),
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
  };
}

function windowSize(saved: Partial<WindowRect> | null) {
  return {
    width: Math.max(
      MAIN_WINDOW_MIN_SIZE.width,
      finite(saved?.width) && saved.width > 0
        ? Math.round(saved.width)
        : MAIN_WINDOW_DEFAULT_SIZE.width,
    ),
    height: Math.max(
      MAIN_WINDOW_MIN_SIZE.height,
      finite(saved?.height) && saved.height > 0
        ? Math.round(saved.height)
        : MAIN_WINDOW_DEFAULT_SIZE.height,
    ),
  };
}

/**
 * Follows VS Code WindowStateValidator's normal-window rules:
 * single display: cap size, clamp top/left, recover bottom/right within 128 DIP;
 * multiple displays: preserve intersecting bounds, otherwise reject the saved state.
 * https://github.com/microsoft/vscode/blob/main/src/vs/platform/windows/electron-main/windows.ts
 */
export function validateWindowBounds(
  saved: Partial<WindowRect> | null,
  displays: WindowDisplay[],
): WindowRect | null {
  if (!saved || !validWindowRect(saved)) return null;
  const bounds = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.round(saved.width),
    height: Math.round(saved.height),
  };
  if (!validWindowRect(bounds)) return null;
  const areas = displays.map(displayWorkArea).filter(validWindowRect);
  if (areas.length === 1) {
    const area = areas[0];
    bounds.x = Math.max(bounds.x, area.x);
    bounds.y = Math.max(bounds.y, area.y);
    bounds.width = Math.min(bounds.width, area.width);
    bounds.height = Math.min(bounds.height, area.height);
    if (bounds.x > area.x + area.width - 128) bounds.x = area.x + area.width - bounds.width;
    if (bounds.y > area.y + area.height - 128) bounds.y = area.y + area.height - bounds.height;
    bounds.x = Math.max(bounds.x, area.x);
    bounds.y = Math.max(bounds.y, area.y);
    return bounds;
  }
  return areas.some(
    (area) =>
      bounds.x + bounds.width > area.x &&
      bounds.y + bounds.height > area.y &&
      bounds.x < area.x + area.width &&
      bounds.y < area.y + area.height,
  )
    ? bounds
    : null;
}

export function resolveMainWindowPlacement(
  saved: Partial<WindowRect> | null,
  displays: WindowDisplay[],
  primaryId: number,
) {
  const usable = displays.filter((display) => validWindowRect(displayWorkArea(display)));
  const primary = usable.find((display) => display.id === primaryId) ?? usable[0];
  const area = primary ? displayWorkArea(primary) : { x: 0, y: 0, ...MAIN_WINDOW_DEFAULT_SIZE };
  const restored = validateWindowBounds(saved, usable);
  const size = windowSize(saved && (!finite(saved.x) || !finite(saved.y)) ? saved : null);
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const bounds = restored ?? {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
  // Application-specific safety: do not let Electron's minimum enlarge the
  // validated restoration rectangle beyond a small/high-DPI work area.
  return {
    bounds,
    minWidth: Math.min(MAIN_WINDOW_MIN_SIZE.width, bounds.width),
    minHeight: Math.min(MAIN_WINDOW_MIN_SIZE.height, bounds.height),
  };
}
