/**
 * 模块级 Map 缓存的 LRU 容量裁剪工具。
 *
 * 背景：部分缓存（如收藏状态、写真 URL）以歌曲/歌词为键，会话期间只增不减，
 * 长时间运行 + 大量切歌会缓慢累积。利用 Map 的插入顺序特性，在写入时裁剪最旧条目，
 * 给缓存一个明确上界，避免无界增长。
 */
export function setWithLimit<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  // 重新插入已存在的键会更新其插入顺序，使其成为"最近使用"，符合 LRU 语义。
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);

  // 超出上限时，从头部删除最旧的条目，直到回到上限以内。
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
