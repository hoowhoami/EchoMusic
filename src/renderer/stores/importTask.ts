import { defineStore } from 'pinia';
import type { ImportItemResult, ImportSummary } from '@/utils/importPlaylist';

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
    percent: (state) =>
      state.total > 0 ? Math.round((state.done / state.total) * 100) : 0,
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
    completedAt: (state) =>
      state.status === 'completed' ? Date.now() : 0,
  },

  actions: {
    start(name: string, count: number, abortHandler: () => void) {
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
      this.status = 'running';
      this.playlistName = name;
      this.onAbort = abortHandler;
      // done/total/items 已在 runImport onProgress 中实时更新，直接复用
    },

    updateProgress(done: number, total: number, item: ImportItemResult) {
      this.done = done;
      this.total = total;
      const idx = this.items.findIndex(
        (it) => it.external === item.external,
      );
      if (idx >= 0) {
        this.items[idx] = { ...item };
      } else {
        this.items.push({ ...item });
      }
    },

    complete(summary: ImportSummary) {
      this.status = 'completed';
      this.summary = summary;
      this.onAbort = null;
    },

    abort() {
      this.status = 'aborted';
      this.onAbort?.();
      this.onAbort = null;
    },

    /** 任务面板手动中止 */
    requestAbort() {
      if (this.status === 'running') {
        this.onAbort?.();
        // 等待下一个 updateProgress / complete 来确认状态变更
        // 这里先不管，跑完后 complete() 会覆盖
      }
    },

    /** 任务面板触发重新打开导入弹窗 */
    requestOpen() {
      this.openRequested++;
    },

    dismiss() {
      this.status = 'idle';
      this.summary = null;
      this.items = [];
      this.onAbort = null;
    },
  },
});
