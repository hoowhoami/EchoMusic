import { defineStore } from 'pinia';
import { isProxy, isRef, ref, toRaw, unref } from 'vue';
import type { Song } from '@/models/song';
import type { StorageHistoryAddListenTimeResult, StorageHistoryEntry } from '../../shared/storage';
import { resolveSongId } from '../../shared/historyStats';
import { withoutEmbeddedMetadata } from '../../shared/embeddedMetadata';
import logger from '@/utils/logger';
import { completeSongMetadata } from '@/services/songMetadata';
import { needsSongMetadata } from '@/utils/mappers/songMetadata';

export interface LocalHistoryEntry {
  /** 歌曲完整信息（可独立渲染，不依赖远端 API） */
  song: Song;
  /** 最后播放时间戳（ms） */
  lastPlayedAt: number;
  /** 播放次数（本地累计） */
  playCount: number;
  /** 本地累计实听时长（ms，老数据为 0） */
  listenedMs: number;
  /** 去重键 = `${mxid}:${lastPlayedAt}` */
  historyKey: string;
}

// 与 EchoMusicNext 对齐：历史读取/保留上限 1000 条（原生存储层 clamp 上限 5000）
const DEFAULT_MAX_ENTRIES = 1000;
/** 退场动画时长（ms），需与 CSS animation-duration 一致 */
const EXIT_ANIM_MS = 250;

const toLocalEntry = (entry: StorageHistoryEntry): LocalHistoryEntry => ({
  song: {
    ...withoutEmbeddedMetadata(entry.song as Song),
    historyKey: entry.historyKey,
    lastPlayedAt: entry.lastPlayedAt,
    playCount: entry.playCount,
  },
  lastPlayedAt: entry.lastPlayedAt,
  playCount: entry.playCount,
  listenedMs: Number(entry.listenedMs) || 0,
  historyKey: entry.historyKey,
});

// 歌曲唯一 ID 的解析统一走 shared/historyStats 的 resolveSongId（与统计口径一致）

/**
 * 递归解除响应式包装。snapshot 的嵌套字段（artists/singers/relateGoods 等）会被
 * spread 重建路径深度代理后存进 raw target，单层 toRaw 解不干净；IPC 结构化克隆
 * 拒绝任何 Proxy 节点（"An object could not be cloned"），必须整棵树都还原成普通对象。
 */
const deepToRaw = <T>(value: T): T => {
  let raw: unknown = value;
  if (isRef(raw)) raw = unref(raw);
  if (isProxy(raw)) raw = toRaw(raw);
  if (Array.isArray(raw)) return raw.map((item) => deepToRaw(item)) as unknown as T;
  if (raw && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(raw)) out[key] = deepToRaw(item);
    return out as T;
  }
  return raw as T;
};

const upsertEntryAtTop = (
  current: LocalHistoryEntry[],
  entry: LocalHistoryEntry,
  maxEntries: number,
) => {
  const targetId = resolveSongId(entry.song);
  const filtered = current.filter((item) => resolveSongId(item.song) !== targetId);
  return [entry, ...filtered].slice(0, maxEntries);
};

export const useHistoryStore = defineStore('history', () => {
  const entries = ref<LocalHistoryEntry[]>([]);
  const maxEntries = ref(DEFAULT_MAX_ENTRIES);
  const hydrated = ref(false);
  /** 终身累计实听毫秒（独立聚合，不受历史裁剪/删除/清空影响）；null 表示尚未取到 */
  const listenedTotalMs = ref<number | null>(null);

  /**
   * 播放记录版本号。每次 recordPlay 递增，供 History.vue 监听以触发滚动动画。
   */
  const playRecordVersion = ref(0);

  /** 退场动画进行中时，标记对应歌曲的 historyKey。SongList 据此渲染 is-leaving class */
  const promotedKey = ref<string | null>(null);
  /** 正在被删除的歌曲 historyKey 集合（退场动画期间标记，动画结束后实际移除） */
  const removingKeys = ref(new Set<string>());
  let hydratePromise: Promise<void> | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPromotion: LocalHistoryEntry | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  /** 页面按需发起补全；不写播放记录，避免改变次数、时间和置顶动画。 */
  const completeMetadata = async (isCurrent: () => boolean) => {
    const requestGeneration = generation;
    const ownsScope = () => requestGeneration === generation && isCurrent();
    if (!ownsScope()) return;
    const snapshot = entries.value.filter(
      (entry) => !removingKeys.value.has(entry.historyKey) && needsSongMetadata(entry.song),
    );
    if (!snapshot.length) return;
    try {
      const originals = snapshot.map((entry) => entry.song);
      const completed = await completeSongMetadata(originals, ownsScope);
      if (!ownsScope()) return;
      const updates = new Map<Song, Song>();
      completed.forEach((song, index) => {
        if (song !== originals[index]) updates.set(originals[index], song);
      });
      if (!updates.size) return;
      let changed = false;
      const next = entries.value.map((entry) => {
        const song = updates.get(entry.song);
        if (!song || removingKeys.value.has(entry.historyKey)) return entry;
        changed = true;
        return { ...entry, song };
      });
      if (changed) entries.value = next;
    } catch (error) {
      if (ownsScope()) logger.warn('HistoryStore', 'Complete song metadata failed', error);
    }
  };

  const hydrate = async () => {
    if (hydrated.value) return;
    if (hydratePromise) return hydratePromise;
    const storage = window.electron?.storage;
    if (!storage) {
      hydrated.value = true;
      return;
    }
    const requestGeneration = generation;
    // 终身累计与条目分开取：聚合读取失败不影响历史列表展示
    const loadListenTotal = async () => {
      try {
        return (await storage.getHistoryListenTotal?.()) ?? null;
      } catch (error) {
        logger.warn('HistoryStore', 'Load listen total failed', error);
        return null;
      }
    };
    hydratePromise = Promise.all([
      storage.getHistoryEntries({ offset: 0, limit: maxEntries.value }),
      loadListenTotal(),
    ])
      .then(([saved, total]) => {
        if (requestGeneration !== generation) return;
        entries.value = (saved ?? []).map(toLocalEntry);
        const lifetime = Number(total?.listenedMs);
        if (total?.ok && Number.isFinite(lifetime) && lifetime >= 0) {
          listenedTotalMs.value = lifetime;
        }
        hydrated.value = true;
      })
      .catch((error) => {
        logger.warn('HistoryStore', 'Load history failed', error);
      })
      .finally(() => {
        hydratePromise = null;
      });
    return hydratePromise;
  };

  const applyRecordedEntry = (entry: LocalHistoryEntry, previousKey?: string | null) => {
    if (exitTimer !== null) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
    if (pendingPromotion) {
      entries.value = upsertEntryAtTop(entries.value, pendingPromotion, maxEntries.value);
      pendingPromotion = null;
    }
    promotedKey.value = null;
    const current = entries.value;
    const existingIndex = current.findIndex(
      (item) => resolveSongId(item.song) === resolveSongId(entry.song),
    );

    if (existingIndex <= 0) {
      entries.value = upsertEntryAtTop(current, entry, maxEntries.value);
      playRecordVersion.value++;
      return;
    }

    const oldKey = previousKey ?? current[existingIndex].historyKey;
    pendingPromotion = entry;
    promotedKey.value = oldKey;
    exitTimer = setTimeout(() => {
      entries.value = upsertEntryAtTop(entries.value, entry, maxEntries.value);
      pendingPromotion = null;
      promotedKey.value = null;
      exitTimer = null;
      playRecordVersion.value++;
    }, EXIT_ANIM_MS);
  };

  /** 记录一次播放，由 player 在 play 事件触发时调用 */
  const recordPlay = async (song: Song) => {
    // 与 addListenTime 同理：先整树解除响应式 Proxy，避免 IPC 结构化克隆失败
    song = withoutEmbeddedMetadata(deepToRaw(song));
    const requestGeneration = generation;
    if (!hydrated.value) await hydrate();
    if (requestGeneration !== generation) return;
    const now = Date.now();
    const mxid = resolveSongId(song);
    const existing = entries.value.find((entry) => resolveSongId(entry.song) === mxid);

    let stored: StorageHistoryEntry | null | undefined;
    try {
      stored = await window.electron?.storage?.recordHistoryPlay({
        song,
        playedAt: now,
        maxEntries: maxEntries.value,
      });
    } catch {
      return;
    }
    if (!stored || requestGeneration !== generation) return;

    applyRecordedEntry(toLocalEntry(stored), existing?.historyKey);
  };

  /**
   * 累加一段本地实听时长。
   * 条目维度：条目不存在（被删除/被上限 prune）时存储层不会重建，这里也不新建；
   * 终身累计维度：无论条目是否存在都会累加，历史变动不影响总时长。
   */
  const addListenTime = async (song: Song, listenedMs: number) => {
    const amount = Math.round(Number(listenedMs));
    if (!Number.isFinite(amount) || amount <= 0) return;
    // snapshot 顶层与嵌套字段都可能带响应式 Proxy（内嵌元数据补全等路径会用普通字面量
    // 重建 snapshot，从 reactive state 读出即 Proxy，且 spread 时嵌套字段也被深度代理），
    // IPC 结构化克隆拒绝 Proxy（"An object could not be cloned"），异常被上层吞掉导致
    // 时长静默丢失；整树解除包装后再落库
    const plain = withoutEmbeddedMetadata(deepToRaw(song));
    let result: StorageHistoryAddListenTimeResult | undefined;
    try {
      result = await window.electron?.storage?.addHistoryListenTime?.({
        song: plain,
        listenedMs: amount,
      });
    } catch (error) {
      logger.warn('HistoryStore', 'Add listen time failed', error);
      return;
    }
    if (!result?.ok) return;
    // 终身累计是权威总值，直接覆盖本地缓存
    const lifetime = Number(result.totalListenedMs);
    if (Number.isFinite(lifetime) && lifetime >= 0) listenedTotalMs.value = lifetime;
    if (!result.updated) return;
    const songId = resolveSongId(plain);
    const entry = entries.value.find((item) => resolveSongId(item.song) === songId);
    if (!entry) return;
    // 优先采用存储层回传的权威总值，避免本地增量与并发写入漂移
    const total = Number(result.listenedMs);
    entry.listenedMs = Number.isFinite(total) ? total : (Number(entry.listenedMs) || 0) + amount;
  };

  /** 清空所有本地播放历史（立即生效，无动画） */
  const clear = () => {
    generation += 1;
    hydrated.value = true;
    entries.value = [];
    removingKeys.value = new Set();
    promotedKey.value = null;
    pendingPromotion = null;
    if (exitTimer !== null) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
    if (removeTimer !== null) {
      clearTimeout(removeTimer);
      removeTimer = null;
    }
    void window.electron?.storage?.clearHistory().catch((error) => {
      logger.warn('HistoryStore', 'Clear history failed', error);
    });
  };

  /** 删除单条播放历史（退场动画 → 250ms 后实际移除） */
  const removeEntry = (historyKey: string) => {
    removeEntries([historyKey]);
  };

  /** 批量删除播放历史（退场动画 → 250ms 后实际移除） */
  const removeEntries = (historyKeys: string[]) => {
    if (!historyKeys.length) return;
    void window.electron?.storage?.removeHistoryEntries({ historyKeys }).catch((error) => {
      logger.warn('HistoryStore', 'Remove history failed', error);
    });
    removingKeys.value = new Set([...removingKeys.value, ...historyKeys]);
    if (removeTimer !== null) clearTimeout(removeTimer);
    removeTimer = setTimeout(() => {
      const keySet = removingKeys.value;
      entries.value = entries.value.filter((entry) => !keySet.has(entry.historyKey));
      removingKeys.value = new Set();
      removeTimer = null;
    }, EXIT_ANIM_MS);
  };

  /** 获取全部条目（返回副本，避免外部修改响应式数组） */
  const getAllEntries = (): LocalHistoryEntry[] => [...entries.value];

  /** 分页获取条目 */
  const getEntries = (options?: { offset?: number; limit?: number }): LocalHistoryEntry[] => {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? entries.value.length;
    return entries.value.slice(offset, offset + limit);
  };

  return {
    entries,
    maxEntries,
    hydrated,
    listenedTotalMs,
    playRecordVersion,
    promotedKey,
    removingKeys,
    hydrate,
    completeMetadata,
    recordPlay,
    addListenTime,
    clear,
    removeEntry,
    removeEntries,
    getAllEntries,
    getEntries,
  };
});
