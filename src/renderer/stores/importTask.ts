import { defineStore } from 'pinia';
import type { ImportItemResult, ImportSummary } from '@/utils/importPlaylist';
import logger from '@/utils/logger';

/** 面板中止后 aborted 状态的保留时长，到期自动转 idle（dismiss）。 */
const ABORT_TASK_KEEP_MS = 3000;
let abortClearTimer: ReturnType<typeof setTimeout> | null = null;
const clearAbortClearTimer = () => {
  if (abortClearTimer !== null) {
    clearTimeout(abortClearTimer);
    abortClearTimer = null;
  }
};
/**
 * 导入任务的全局状态，供「导入弹窗」和「当前任务面板」共享。
 *
 * 导入弹窗关闭后任务继续运行，进度在任务面板中实时展示。
 * 完成后停留若干秒自动清除，也可手动关闭。
 */
export type ImportTaskStatus = 'idle' | 'running' | 'completed' | 'aborted';

export const useImportTaskStore = defineStore('importTask', {
  state: () => ({
    status: 'idle' as ImportTaskStatus,
    playlistName: '',
    trackCount: 0,
    done: 0,
    total: 0,
    summary: null as ImportSummary | null,
    items: [] as ImportItemResult[],
    /** 由外部调用方（Dialog）注入；任务面板点中止时触发 */
    onAbort: null as (() => void) | null,
    /** 任务面板触发重新打开导入弹窗的计数器 */
    openRequested: 0,
  }),

  getters: {
    isActive: (state) => state.status === 'running',
    percent: (state) => (state.total > 0 ? Math.round((state.done / state.total) * 100) : 0),
    statusLabel: (state): string => {
      switch (state.status) {
        case 'idle':
          return '';
        case 'running':
          return `同步中 · ${state.done} / ${state.total}`;
        case 'completed': {
          if (!state.summary) return '';
          const { success, low, skipped, failed } = state.summary;
          const parts = [`成功 ${success + low}`];
          if (skipped > 0) parts.push(`跳过 ${skipped}`);
          if (failed > 0) parts.push(`失败 ${failed}`);
          return parts.join(' · ');
        }
        case 'aborted':
          return '已中止';
        default:
          return '';
      }
    },
    completedAt: (state) => (state.status === 'completed' ? Date.now() : 0),
  },

  actions: {
    start(name: string, count: number, abortHandler: () => void) {
      clearAbortClearTimer();
      this.status = 'running';
      this.playlistName = name;
      this.trackCount = count;
      this.done = 0;
      this.total = count;
      this.summary = null;
      this.items = [];
      this.onAbort = abortHandler;
    },

    /** 转入后台运行（弹窗关闭但导入不中断时调用） */
    enterBackground(name: string, abortHandler: () => void) {
      clearAbortClearTimer();
      this.status = 'running';
      this.playlistName = name;
      this.onAbort = abortHandler;
      // done/total/items 已在 runImport onProgress 中实时更新，直接复用
    },

    updateProgress(done: number, total: number, item: ImportItemResult) {
      this.done = done;
      this.total = total;
      const idx = this.items.findIndex((it) => it.external === item.external);
      if (idx >= 0) {
        this.items[idx] = { ...item };
      } else {
        this.items.push({ ...item });
      }
    },

    complete(summary: ImportSummary) {
      clearAbortClearTimer();
      this.status = 'completed';
      this.summary = summary;
      this.onAbort = null;
    },

    /** 任务面板手动中止 */
    requestAbort() {
      if (this.status === 'running') {
        clearAbortClearTimer();
        // 立即收敛为 aborted，避免中止流程卡住时任务一直 running
        this.status = 'aborted';
        logger.info('ImportTask', '后台导入中止请求', { playlistName: this.playlistName });
        this.onAbort?.();
        // 中止反馈保留 ABORT_TASK_KEEP_MS 后自动关闭；面板可提前点「关闭」
        abortClearTimer = setTimeout(() => {
          abortClearTimer = null;
          // 重新获取 store 实例，避免闭包绑定旧实例（HMR/重建边界更稳）
          useImportTaskStore().dismiss();
        }, ABORT_TASK_KEEP_MS);
      }
    },

    /** 任务面板触发重新打开导入弹窗 */
    requestOpen() {
      this.openRequested++;
    },

    dismiss() {
      clearAbortClearTimer();
      this.status = 'idle';
      this.summary = null;
      this.items = [];
      this.onAbort = null;
    },
  },
});
