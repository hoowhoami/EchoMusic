import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Song } from '@/models/song';
import type { StorageHistoryEntry } from '../../shared/storage';
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
  /** 去重键 = `${mxid}:${lastPlayedAt}` */
  historyKey: string;
}

const DEFAULT_MAX_ENTRIES = 500;
/** 退场动画时长（ms），需与 CSS animation-duration 一致 */
const EXIT_ANIM_MS = 250;

const toLocalEntry = (entry: StorageHistoryEntry): LocalHistoryEntry => ({
  song: {
    ...(entry.song as Song),
    historyKey: entry.historyKey,
    lastPlayedAt: entry.lastPlayedAt,
    playCount: entry.playCount,
  },
  lastPlayedAt: entry.lastPlayedAt,
  playCount: entry.playCount,
  historyKey: entry.historyKey,
});

const resolveSongHistoryId = (song: Song) =>
  String(song.mixSongId || song.fileId || song.id || '0');

const upsertEntryAtTop = (
  current: LocalHistoryEntry[],
  entry: LocalHistoryEntry,
  maxEntries: number,
) => {
  const targetId = resolveSongHistoryId(entry.song);
  const filtered = current.filter((item) => resolveSongHistoryId(item.song) !== targetId);
  return [entry, ...filtered].slice(0, maxEntries);
};

export const useHistoryStore = defineStore('history', () => {
  const entries = ref<LocalHistoryEntry[]>([]);
  const maxEntries = ref(DEFAULT_MAX_ENTRIES);
  const hydrated = ref(false);

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
    hydratePromise = storage
      .getHistoryEntries({ offset: 0, limit: maxEntries.value })
      .then((saved) => {
        if (requestGeneration !== generation) return;
        entries.value = (saved ?? []).map(toLocalEntry);
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
      (item) => resolveSongHistoryId(item.song) === resolveSongHistoryId(entry.song),
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
    const requestGeneration = generation;
    if (!hydrated.value) await hydrate();
    if (requestGeneration !== generation) return;
    const now = Date.now();
    const mxid = resolveSongHistoryId(song);
    const existing = entries.value.find((entry) => resolveSongHistoryId(entry.song) === mxid);

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
    playRecordVersion,
    promotedKey,
    removingKeys,
    hydrate,
    completeMetadata,
    recordPlay,
    clear,
    removeEntry,
    removeEntries,
    getAllEntries,
    getEntries,
  };
});
