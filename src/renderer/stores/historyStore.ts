import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Song } from '@/models/song';

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
/** 同一首歌在此时间窗口内不重复记录（防止 play 事件重复触发） */
const RECORD_DEBOUNCE_MS = 60_000;
/** 退场动画时长（ms），需与 CSS animation-duration 一致 */
const EXIT_ANIM_MS = 250;

export const useHistoryStore = defineStore(
  'history',
  () => {
    const entries = ref<LocalHistoryEntry[]>([]);
    const maxEntries = ref(DEFAULT_MAX_ENTRIES);

    /**
     * Session 内已记录追踪（不持久化）。
     * 应用重启后自动清空，替代脆弱的 historyLocalRecorded 标志位。
     */
    const playedThisSession = new Map<string, number>();

    /**
     * 播放记录版本号。每次 recordPlay 递增，供 History.vue 监听以触发滚动动画。
     */
    const playRecordVersion = ref(0);

    /** 退场动画进行中时，标记对应歌曲的 historyKey。SongList 据此渲染 is-leaving class */
    const promotedKey = ref<string | null>(null);
    /** 正在被删除的歌曲 historyKey 集合（退场动画期间标记，动画结束后实际移除） */
    const removingKeys = ref(new Set<string>());
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;

    /** 记录一次播放，由 player 在 play 事件触发时调用 */
    const recordPlay = (song: Song) => {
      const now = Date.now();
      const mxid = String(song.mixSongId || song.fileId || song.id || '0');
      const historyKey = `${mxid}:${now}`;
      const current = entries.value;
      const existingIndex = current.findIndex((e) => {
        const eMxid = String(e.song.mixSongId || e.song.fileId || e.song.id || '0');
        return eMxid === mxid;
      });

      // Session 去重仅对新建条目生效；已存在条目永远更新 lastPlayedAt 并置顶
      if (existingIndex < 0) {
        const lastRecorded = playedThisSession.get(mxid);
        if (lastRecorded !== undefined && now - lastRecorded < RECORD_DEBOUNCE_MS) return;
        playedThisSession.set(mxid, now);
      }

      // 因为 lastPlayedAt 永远 = Date.now()，直接插入/移动到数组头部，无需全量排序
      if (existingIndex >= 0) {
        const updatedPlayCount = (current[existingIndex].playCount || 0) + 1;
        const updatedEntry: LocalHistoryEntry = {
          song: { ...song, historyKey, lastPlayedAt: now, playCount: updatedPlayCount },
          lastPlayedAt: now,
          playCount: updatedPlayCount,
          historyKey,
        };

        // 已在顶部：原地更新
        if (existingIndex === 0) {
          const newEntries = [...current];
          newEntries[0] = updatedEntry;
          entries.value = newEntries;
          playRecordVersion.value++;
          return;
        }

        // 两阶段：退场动画（缩小+淡出）→ 延时重排
        const oldKey = current[existingIndex].historyKey;
        if (exitTimer !== null) clearTimeout(exitTimer);
        promotedKey.value = oldKey;
        exitTimer = setTimeout(() => {
          const newEntries = [...entries.value];
          const idx = newEntries.findIndex((e) => e.historyKey === oldKey);
          if (idx > 0) {
            const [item] = newEntries.splice(idx, 1);
            newEntries.unshift({ ...item, ...updatedEntry });
            entries.value = newEntries.slice(0, maxEntries.value);
          }
          promotedKey.value = null;
          exitTimer = null;
          playRecordVersion.value++;
        }, EXIT_ANIM_MS);
        return;
      }

      const newEntry: LocalHistoryEntry = {
        song: { ...song, historyKey, lastPlayedAt: now, playCount: 1 },
        lastPlayedAt: now,
        playCount: 1,
        historyKey,
      };
      entries.value = [newEntry, ...current].slice(0, maxEntries.value);
      playRecordVersion.value++;
    };

    /** 清空所有本地播放历史（立即生效，无动画） */
    const clear = () => {
      entries.value = [];
      removingKeys.value = new Set();
      if (removeTimer !== null) {
        clearTimeout(removeTimer);
        removeTimer = null;
      }
      playedThisSession.clear();
    };

    /** 删除单条播放历史（退场动画 → 250ms 后实际移除） */
    const removeEntry = (historyKey: string) => {
      removingKeys.value = new Set([...removingKeys.value, historyKey]);
      if (removeTimer !== null) clearTimeout(removeTimer);
      removeTimer = setTimeout(() => {
        entries.value = entries.value.filter((e) => e.historyKey !== historyKey);
        removingKeys.value = new Set();
        removeTimer = null;
      }, EXIT_ANIM_MS);
    };

    /** 批量删除播放历史（退场动画 → 250ms 后实际移除） */
    const removeEntries = (historyKeys: string[]) => {
      removingKeys.value = new Set([...removingKeys.value, ...historyKeys]);
      if (removeTimer !== null) clearTimeout(removeTimer);
      removeTimer = setTimeout(() => {
        const keySet = new Set(historyKeys);
        entries.value = entries.value.filter((e) => !keySet.has(e.historyKey));
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
      playRecordVersion,
      promotedKey,
      removingKeys,
      recordPlay,
      clear,
      removeEntry,
      removeEntries,
      getAllEntries,
      getEntries,
    };
  },
  {
    persist: { pick: ['entries', 'maxEntries'] },
  },
);
