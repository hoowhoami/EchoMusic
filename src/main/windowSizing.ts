export const MAIN_WINDOW_LAYOUT_MIN_HEIGHT = 650;

/**
 * Keep the native minimum tied to the smallest supported layout, rather than
 * increasing it with the display size. Tiling compositors derive their cell
 * size independently from the full display work area.
 */
export const resolveMainWindowMinHeight = (availableHeight: number): number => {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) {
    return MAIN_WINDOW_LAYOUT_MIN_HEIGHT;
  }
  return Math.max(1, Math.min(MAIN_WINDOW_LAYOUT_MIN_HEIGHT, Math.floor(availableHeight * 0.95)));
};
