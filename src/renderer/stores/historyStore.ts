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

export const useHistoryStore = defineStore('history', () => {
  const entries = ref<LocalHistoryEntry[]>([]);
  const maxEntries = ref(DEFAULT_MAX_ENTRIES);

  /**
   * Session 内已记录追踪（不持久化）。
   * 应用重启后自动清空，替代脆弱的 historyLocalRecorded 标志位。
   */
  const playedThisSession = new Map<string, number>();

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

    const newEntries = [...current];

    if (existingIndex >= 0) {
      const updatedPlayCount = (current[existingIndex].playCount || 0) + 1;
      newEntries.splice(existingIndex, 1, {
        song: { ...song, historyKey, lastPlayedAt: now, playCount: updatedPlayCount },
        lastPlayedAt: now,
        playCount: updatedPlayCount,
        historyKey,
      });
    } else {
      newEntries.push({
        song: { ...song, historyKey, lastPlayedAt: now, playCount: 1 },
        lastPlayedAt: now,
        playCount: 1,
        historyKey,
      });
    }

    newEntries.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);

    if (newEntries.length > maxEntries.value) {
      newEntries.splice(maxEntries.value);
    }

    entries.value = newEntries;
  };

  /** 清空所有本地播放历史 */
  const clear = () => {
    entries.value = [];
    playedThisSession.clear();
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
    recordPlay,
    clear,
    getAllEntries,
    getEntries,
  };
}, {
  persist: { pick: ['entries', 'maxEntries'] },
});
