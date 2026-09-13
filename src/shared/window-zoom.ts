export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;
export const ZOOM_STEP_PERCENT = 5;
export function normalizeZoomLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, value))
    : 0;
}
export const zoomLevelToFactor = (level: number) => 1.2 ** normalizeZoomLevel(level);
export function stepZoomLevel(level: number, direction: 1 | -1): number {
  const percent = Math.round(zoomLevelToFactor(level) * 100) + direction * ZOOM_STEP_PERCENT;
  if (percent <= zoomLevelToFactor(MIN_ZOOM_LEVEL) * 100) return MIN_ZOOM_LEVEL;
  if (percent >= zoomLevelToFactor(MAX_ZOOM_LEVEL) * 100) return MAX_ZOOM_LEVEL;
  // Persist Chromium's level so existing saved zoom and titlebar geometry stay compatible.
  return Math.log(percent / 100) / Math.log(1.2);
}
export const titleBarHeight = (level: number) =>
  Math.max(35, Math.round(46 * zoomLevelToFactor(level)));
export function zoomShortcut(
  input: { key: string; code?: string; control: boolean; meta: boolean; alt: boolean },
  platform: string,
): 'in' | 'out' | 'reset' | null {
  if (
    input.alt ||
    (platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta)
  )
    return null;
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset';
  return null;
}
