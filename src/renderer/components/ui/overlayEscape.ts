/** Check painted layers only when Escape is pressed; closing layers still own that key. */
export function isTopmostDrawer(panel: HTMLElement | null): boolean {
  if (!panel) return false;
  const document = panel.ownerDocument;
  if (document.querySelector('.dialog-content, .echo-popover-content, .echo-date-picker-content'))
    return false;
  const view = document.defaultView;
  if (!view) return false;

  let top: HTMLElement | null = null;
  let topZIndex = -Infinity;
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>('.drawer-panel'))) {
    const style = view.getComputedStyle(candidate);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const zIndex = Number.parseFloat(style.zIndex) || 0;
    // Equal z-index layers are painted in document order. Include closing
    // drawers until their visibility transition ends to prevent key repeat
    // from dismissing the layer underneath during the exit animation.
    if (zIndex >= topZIndex) {
      top = candidate;
      topZIndex = zIndex;
    }
  }
  return top === panel;
}
