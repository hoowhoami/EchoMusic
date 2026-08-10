import { defineStore } from 'pinia';
import type { ImportItemResult, ImportSummary } from '@/utils/importPlaylist';
import logger from '@/utils/logger';
import {
  activateTaskControl,
  clearTaskControl,
  createTaskAbortTimer,
  createTaskControlState,
  finishTaskControl,
  requestTaskAbort,
  requestTaskOpen,
} from '@/tasks/taskControl';

const abortTimer = createTaskAbortTimer();

/**
 * 导入任务的全局状态，供「导入弹窗」和「任务中心面板」共享。
 *
 * 导入弹窗关闭后任务继续运行，进度在任务面板中实时展示。
 * 完成后停留若干秒自动清除，也可手动关闭。
 */
export type ImportTaskStatus = 'idle' | 'running' | 'completed' | 'aborted';

export interface ImportTaskAbortOptions {
  feedback?: boolean;
}

export const useImportTaskStore = defineStore('importTask', {
  state: () => ({
    ...createTaskControlState('detail'),
    status: 'idle' as ImportTaskStatus,
    playlistName: '',
    done: 0,
    total: 0,
    summary: null as ImportSummary | null,
    items: [] as ImportItemResult[],
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
  },

  actions: {
    /** 转入后台运行（弹窗关闭但导入不中断时调用） */
    enterBackground(name: string, abortHandler: () => void) {
      abortTimer.clear();
      this.status = 'running';
      this.playlistName = name;
      activateTaskControl(this, abortHandler);
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
      finishTaskControl(this, abortTimer);
      this.status = 'completed';
      this.summary = summary;
    },

    /** 任务面板手动中止 */
    requestAbort(options: ImportTaskAbortOptions = {}) {
      requestTaskAbort(this, abortTimer, {
        canAbort: () => this.status === 'running',
        feedback: options.feedback,
        // 立即收敛为 aborted，避免中止流程卡住时任务一直 running
        markAborted: () => {
          this.status = 'aborted';
        },
        onRequested: () => {
          logger.info('ImportTask', '后台导入中止请求', { playlistName: this.playlistName });
        },
        // 重新获取 store 实例，避免闭包绑定旧实例（HMR/重建边界更稳）
        onTimeoutDismiss: () => useImportTaskStore().dismiss(),
      });
    },

    /** 任务面板触发重新打开导入弹窗 */
    requestOpen() {
      requestTaskOpen(this, 'detail');
    },

    dismiss() {
      clearTaskControl(this, abortTimer);
      this.status = 'idle';
      this.summary = null;
      this.items = [];
    },
  },
});
