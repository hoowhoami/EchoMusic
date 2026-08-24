import { defineStore } from 'pinia';
import logger from '@/utils/logger';
import router from '@/router';
import { iconCloudUpload } from '@/icons';
import {
  BUILTIN_PLUGIN_ID,
  createTaskLifecycleActions,
  createTaskOwner,
  registerTask,
} from '@/plugins/taskPanel';
import {
  activateTaskControl,
  clearTaskControl,
  consumeTaskOpen,
  createTaskControlState,
  finishTaskControl,
  requestTaskAbort,
  requestTaskOpen,
} from '@/tasks/taskControl';

const TASK_ID = 'echo:cloud-upload';
const taskOwner = createTaskOwner(BUILTIN_PLUGIN_ID);

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
  title?: string;
  artist?: string;
  duration?: number;
  size: number;
  extension: string;
  modifiedAt: number;
  status: 'pending' | 'matching' | 'uploading' | 'success' | 'failed';
  audioId?: string | number;
  albumAudioId?: string | number;
  matchStatus: CloudUploadMatchStatus;
  matchReason?: string;
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

export interface CloudUploadRun {
  readonly active: boolean;
  readonly signal: AbortSignal;
  updateProgress: (done: number, total: number, item: CloudUploadItem) => boolean;
  setPhase: (phase: CloudUploadPhase) => boolean;
  complete: (summary: CloudUploadSummary) => boolean;
  enterBackground: (abortHandler: () => void) => boolean;
  abort: (options?: CloudUploadAbortOptions) => boolean;
  dismiss: () => boolean;
}

let currentRun: CloudUploadRun | null = null;

/** 云盘上传业务状态。任务展示和运行世代由 CloudUploadRun 统一管理。 */
export const useCloudUploadStore = defineStore('cloudUpload', {
  state: () => ({
    ...createTaskControlState<CloudUploadOpenMode>('start'),
    status: 'idle' as CloudUploadStatus,
    phase: 'matching' as CloudUploadPhase,
    done: 0,
    total: 0,
    summary: null as CloudUploadSummary | null,
    items: [] as CloudUploadItem[],
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
    start(count: number, abortHandler: () => void): CloudUploadRun {
      currentRun?.dismiss();
      // The returned run methods must retain this Pinia instance.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const store = this;
      store.status = 'running';
      store.phase = 'matching';
      store.done = 0;
      store.total = count;
      store.summary = null;
      store.items = [];
      activateTaskControl(store, abortHandler);

      const openDetail = async () => {
        if (router.currentRoute.value.name !== 'cloud') await router.push({ name: 'cloud' });
        store.requestOpen('detail');
      };
      const task = registerTask(taskOwner, {
        id: TASK_ID,
        name: `上传到云盘 · ${count || '未知'} 首`,
        icon: iconCloudUpload,
        status: 'running',
        retention: 'transient',
        progress: { done: 0, total: count, percent: 0, label: store.statusLabel },
        actions: createTaskLifecycleActions({
          status: 'running',
          onDetail: openDetail,
          onAbort: () => {
            run.abort();
          },
        }),
      });

      const ownsRun = () => currentRun === run;
      const isRunning = () =>
        ownsRun() && task.active && !task.signal.aborted && store.status === 'running';
      const clearState = () => {
        clearTaskControl(store);
        store.status = 'idle';
        store.summary = null;
        store.items = [];
      };

      const run: CloudUploadRun = {
        get active() {
          return ownsRun() && task.active;
        },
        signal: task.signal,
        updateProgress: (done, total, item) => {
          if (!isRunning()) return false;
          store.done = done;
          store.total = total;
          const index = store.items.findIndex((candidate) => candidate.path === item.path);
          if (index >= 0) store.items[index] = { ...item };
          else store.items.push({ ...item });
          return task.update({
            progress: {
              done,
              total,
              percent: store.percent,
              label: store.statusLabel,
            },
          });
        },
        setPhase: (phase) => {
          if (!isRunning()) return false;
          store.phase = phase;
          return task.update({
            progress: {
              done: store.done,
              total: store.total,
              percent: store.percent,
              label: store.statusLabel,
            },
          });
        },
        complete: (summary) => {
          if (!isRunning()) return false;
          const labels = [`成功 ${summary.success}`];
          if (summary.failed > 0) labels.push(`失败 ${summary.failed}`);
          if (summary.secondUpload > 0) labels.push(`秒传 ${summary.secondUpload}`);
          if (
            !task.finish('completed', {
              progress: { label: labels.join(' · ') },
              actions: createTaskLifecycleActions({
                status: 'completed',
                onDetail: openDetail,
              }),
            })
          ) {
            return false;
          }
          finishTaskControl(store);
          store.status = 'completed';
          store.summary = summary;
          return true;
        },
        enterBackground: (nextAbortHandler) => {
          if (!isRunning()) return false;
          activateTaskControl(store, nextAbortHandler);
          return true;
        },
        abort: (options = {}) => {
          const requested = requestTaskAbort(store, {
            canAbort: isRunning,
            feedback: options.feedback,
            markAborted: () => {
              if (!task.finish('aborted', { progress: { label: '已中止' }, actions: [] })) return;
              store.status = 'aborted';
            },
            onRequested: () => {
              logger.info('CloudUpload', '后台上传中止请求', {
                done: store.done,
                total: store.total,
              });
            },
          });
          if (requested) {
            task.cancel();
            if (options.feedback === false) run.dismiss();
          }
          return requested;
        },
        dismiss: () => {
          if (!ownsRun()) return false;
          task.dismiss();
          clearState();
          currentRun = null;
          return true;
        },
      };

      currentRun = run;
      return run;
    },

    enterBackground(abortHandler: () => void): boolean {
      return currentRun?.enterBackground(abortHandler) ?? false;
    },

    requestAbort(options: CloudUploadAbortOptions = {}): boolean {
      return currentRun?.abort(options) ?? false;
    },

    requestOpen(mode: CloudUploadOpenMode = 'detail') {
      requestTaskOpen(this, mode);
    },

    consumeOpenRequest() {
      return consumeTaskOpen(this);
    },

    markChanged() {
      this.changedRevision++;
    },

    dismiss(): boolean {
      return currentRun?.dismiss() ?? false;
    },
  },
});
