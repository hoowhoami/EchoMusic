export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;
export function normalizeZoomLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, value))
    : 0;
}
export const zoomLevelToFactor = (level: number) => 1.2 ** normalizeZoomLevel(level);
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
