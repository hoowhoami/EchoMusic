// --- LRU 缓存实现 ---

interface CacheEntry {
  key: string;
  value: any;
  expireAt: number;
}

/**
 * 基于 Map 的 LRU 缓存
 * Map 的迭代顺序是插入顺序，每次访问（get）时重新插入以更新顺序
 */
export class LRUCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttl: number; // 毫秒
  private hitCount = 0;
  private missCount = 0;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  /**
   * 获取缓存，命中时更新访问顺序
   */
  get(key: string): any | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }

    // 检查是否过期
    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      this.missCount++;
      return undefined;
    }

    // 更新访问顺序：删除后重新插入（移到末尾 = 最近使用）
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  /**
   * 写入缓存
   */
  set(key: string, value: any): void {
    // 如果已存在，先删除（后面重新插入以更新顺序）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 淘汰最久未使用的条目（Map 迭代器第一个 = 最早插入 = 最久未访问）
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      key,
      value,
      expireAt: Date.now() + this.ttl,
    });
  }

  /**
   * 删除指定缓存
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  /**
   * 当前缓存条目数
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 获取所有缓存 key
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取统计信息
   */
  get stats() {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? ((this.hitCount / total) * 100).toFixed(1) + '%' : 'N/A',
    };
  }
}
