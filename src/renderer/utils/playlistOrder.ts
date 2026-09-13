/** Apply the server's global positions after pages are assembled, never reverse each page. */
export function orderByPlaylistPosition<T>(
  items: readonly T[],
  position: (item: T) => number | undefined,
): T[] {
  if (!items.some((item) => position(item) !== undefined)) return items.slice();
  return items.slice().sort((a, b) => {
    const left = position(a);
    const right = position(b);
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

/** 收藏时间跨页全局倒序；缺失、无效和非正时间沉底，同一时间保持原序。 */
export function orderByCollectTime<T>(items: readonly T[], collectTime: (item: T) => unknown): T[] {
  const timestamp = (item: T) => {
    const value = collectTime(item);
    if (typeof value !== 'number' && typeof value !== 'string') return 0;
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? time : 0;
  };
  return items.slice().sort((a, b) => timestamp(b) - timestamp(a));
}
