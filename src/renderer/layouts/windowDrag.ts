/** Native pointer notifications may arrive after controls have moved or unmounted. */
export function isWindowDragTarget(target: Element | null): boolean {
  return Boolean(
    target?.closest('.window-drag-area, .drag-region') &&
    !target.closest(
      '.no-drag, button, a, input, textarea, select, [role="button"], [role="combobox"]',
    ),
  );
}
