export function buildRoundedWindowShape(width: number, height: number, radius = 8) {
  const r = Math.max(
    0,
    Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)),
  );
  if (!r) return [];
  const rects = [];
  for (let y = 0; y < r; y++) {
    const distance = r - y - 0.5;
    const inset = Math.round(r - Math.sqrt(r * r - distance * distance));
    rects.push({ x: inset, y, width: width - 2 * inset, height: 1 });
    rects.push({ x: inset, y: height - y - 1, width: width - 2 * inset, height: 1 });
  }
  if (height > 2 * r) rects.push({ x: 0, y: r, width, height: height - 2 * r });
  return rects;
}
