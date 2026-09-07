export interface StickyLayerMeasurement {
  naturalTop: number;
  stickyTop: number;
  visualHeight: number;
  marginTop: number;
}

/** One geometry plan drives both the overlay and the native scroller's barrier. */
export function planPageStickyLayout(
  items: readonly StickyLayerMeasurement[],
  viewportHeight: number,
) {
  let inset = 0;
  const tops = items.map((item) => {
    const top = Math.max(item.naturalTop, item.stickyTop);
    if (item.naturalTop <= item.stickyTop + 1) {
      inset = Math.max(inset, top + item.marginTop + item.visualHeight);
    }
    return top;
  });
  return { tops, inset: Math.min(Math.max(0, viewportHeight), Math.max(0, inset)) };
}
