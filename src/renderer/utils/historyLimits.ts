/**
 * 播放历史与续播表共用一份容量。
 * 播放历史最多保留 HISTORY_MAX_ENTRIES 条（与上游一致，原 500）（见 stores/historyStore.ts），
 * 续播表每类也按这个数走；并且历史里已经不存在的曲目，
 * 它的续播进度与对应的桶会一起被清掉（见 pruneResumeAgainstHistory）。
 */
export const HISTORY_MAX_ENTRIES = 1000;
