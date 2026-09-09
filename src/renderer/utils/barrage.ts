export interface BarrageItem {
  text: string;
  userId: string;
}

export const BARRAGE_LANES = 4;
export const BARRAGE_LIMIT = 100;

export function normalizeBarrageUserId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const id = String(value).trim();
  // 保留字符串精度，且匿名/无效 ID 不参与“自己”的判断。
  return /^[1-9]\d*$/.test(id) ? id : '';
}

export function normalizeBarrageItems(value: unknown): BarrageItem[] {
  if (!Array.isArray(value)) return [];
  const items: BarrageItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.content !== 'string') continue;
    const text = item.content.trim();
    if (!text) continue;
    items.push({ text, userId: normalizeBarrageUserId(item.user_id) });
    if (items.length === BARRAGE_LIMIT) break;
  }
  return items;
}

export function getFreeBarrageLane(flights: readonly { lane: number }[]): number {
  for (let lane = 0; lane < BARRAGE_LANES; lane++) {
    if (!flights.some((flight) => flight.lane === lane)) return lane;
  }
  return -1;
}

export const barrageIdentity = (item: BarrageItem) => JSON.stringify([item.userId, item.text]);

// 仅抑制刚刚本地展示的同用户同内容，避免接口回流后紧接着重复；不永久去重。
export function nextBarrageItem(
  items: BarrageItem[], cursor: number, recent: Map<string, number>, now: number,
): { item?: BarrageItem; cursor: number } {
  for (const [key, expiry] of recent) if (expiry <= now) recent.delete(key);
  for (let n = 0; n < items.length; n++) {
    const item = items[cursor++ % items.length];
    if (!recent.has(barrageIdentity(item))) return { item, cursor };
  }
  return { cursor };
}
