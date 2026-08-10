import { defineStore } from 'pinia';
import logger from '@/utils/logger';
import {
  activateTaskControl,
  clearTaskControl,
  consumeTaskOpen,
  createTaskAbortTimer,
  createTaskControlState,
  finishTaskControl,
  requestTaskAbort,
  requestTaskOpen,
} from '@/tasks/taskControl';

const abortTimer = createTaskAbortTimer();

export type CloudUploadStatus = 'idle' | 'running' | 'completed' | 'aborted';
export type CloudUploadPhase = 'matching' | 'uploading';
export type CloudUploadOpenMode = 'start' | 'detail';
export type CloudUploadMatchStatus =
  | 'pending'
  | 'linked'
  | 'not_found'
  | 'low_score'
  | 'no_cloud_ids'
  | 'failed';

export interface CloudUploadItem {
  name: string;
  path: string;
  /** 标签解析出的歌名（用于上传显示名） */
  title?: string;
  /** 标签解析出的歌手 */
  artist?: string;
  /** 标签解析出的时长（秒） */
  duration?: number;
  size: number;
  extension: string;
  modifiedAt: number;
  status: 'pending' | 'matching' | 'uploading' | 'success' | 'failed';
  /** 匹配到的歌曲 audio_id（未匹配时为 undefined，上游传 0） */
  audioId?: string | number;
  /** 匹配到的歌曲 album_audio_id */
  albumAudioId?: string | number;
  /** 曲库关联匹配状态 */
  matchStatus: CloudUploadMatchStatus;
  /** 曲库关联匹配说明，写入日志用于排查 */
  matchReason?: string;
  /** 秒传（服务端已存在相同 MD5 的文件） */
  isSecondUpload?: boolean;
  error?: string;
}

export interface CloudUploadSummary {
  total: number;
  success: number;
  failed: number;
  secondUpload: number;
}

export interface CloudUploadAbortOptions {
  feedback?: boolean;
}

/**
 * 云盘上传任务的全局状态，供「上传弹窗」和「任务中心面板」共享。
 *
 * 上传弹窗关闭后任务继续运行，进度在任务面板中实时展示。
 * 完成后停留至手动关闭；面板中止时进入 aborted 反馈 3 秒后自动关闭。
 */
export const useCloudUploadStore = defineStore('cloudUpload', {
  state: () => ({
    ...createTaskControlState<CloudUploadOpenMode>('start'),
    status: 'idle' as CloudUploadStatus,
    /** 当前阶段：匹配 / 上传，供面板区分「匹配中 x/y」「上传中 x/y」 */
    phase: 'matching' as CloudUploadPhase,
    done: 0,
    total: 0,
    summary: null as CloudUploadSummary | null,
    items: [] as CloudUploadItem[],
    /** 云盘内容变更计数器，供云盘页面刷新列表。 */
    changedRevision: 0,
  }),

  getters: {
    isActive: (state) => state.status === 'running',
    percent: (state) => (state.total > 0 ? Math.round((state.done / state.total) * 100) : 0),
    statusLabel: (state): string => {
      switch (state.status) {
        case 'idle':
          return '';
        case 'running':
          return state.phase === 'matching'
            ? `匹配中 ${state.done} / ${state.total}`
            : `上传中 ${state.done} / ${state.total}`;
        case 'completed': {
          if (!state.summary) return '';
          const parts = [`成功 ${state.summary.success}`];
          if (state.summary.failed > 0) parts.push(`失败 ${state.summary.failed}`);
          if (state.summary.secondUpload > 0) parts.push(`秒传 ${state.summary.secondUpload}`);
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
    start(name: string, count: number, abortHandler: () => void) {
      abortTimer.clear();
      this.status = 'running';
      this.phase = 'matching';
      this.done = 0;
      this.total = count;
      this.summary = null;
      this.items = [];
      activateTaskControl(this, abortHandler);
    },

    /** 转入后台运行（弹窗关闭但上传不中断时调用） */
    enterBackground(name: string, abortHandler: () => void) {
      abortTimer.clear();
      this.status = 'running';
      activateTaskControl(this, abortHandler);
      // done/total/items 已在进度回调中实时更新，直接复用
    },

    updateProgress(done: number, total: number, item: CloudUploadItem) {
      this.done = done;
      this.total = total;
      const idx = this.items.findIndex((it) => it.path === item.path);
      if (idx >= 0) {
        this.items[idx] = { ...item };
      } else {
        this.items.push({ ...item });
      }
    },

    setPhase(phase: CloudUploadPhase) {
      this.phase = phase;
    },

    complete(summary: CloudUploadSummary) {
      finishTaskControl(this, abortTimer);
      this.status = 'completed';
      this.summary = summary;
    },

    /** 任务面板手动中止 */
    requestAbort(options: CloudUploadAbortOptions = {}) {
      requestTaskAbort(this, abortTimer, {
        canAbort: () => this.status === 'running',
        feedback: options.feedback,
        // 立即收敛为 aborted，避免中止流程卡住时任务一直 running
        markAborted: () => {
          this.status = 'aborted';
        },
        onRequested: () => {
          logger.info('CloudUpload', '后台上传中止请求', { done: this.done, total: this.total });
        },
        // 重新获取 store 实例，避免闭包绑定旧实例（HMR/重建边界更稳）
        onTimeoutDismiss: () => useCloudUploadStore().dismiss(),
      });
    },

    /** 触发打开全局上传弹窗 */
    requestOpen(mode: CloudUploadOpenMode = 'detail') {
      requestTaskOpen(this, mode);
    },

    consumeOpenRequest() {
      return consumeTaskOpen(this);
    },

    markChanged() {
      this.changedRevision++;
    },

    dismiss() {
      clearTaskControl(this, abortTimer);
      this.status = 'idle';
      this.summary = null;
      this.items = [];
      // 任务结束即清理主进程 allow-list（转后台/重开期间不清）
      void window.electron?.cloud?.clearUploadFiles()?.catch(() => undefined);
    },
  },
});
