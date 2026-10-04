import { defineStore } from 'pinia';
import { effectScope, toRaw, watch } from 'vue';
import type { ImportItemResult, ImportSummary } from '@/utils/importPlaylist';
import logger from '@/utils/logger';
import { iconPlaylistAdd } from '@/icons';
import {
  BUILTIN_PLUGIN_ID,
  createTaskLifecycleActions,
  createTaskOwner,
  registerTask,
} from '@/plugins/taskPanel';
import {
  activateTaskControl,
  clearTaskControl,
  createTaskControlState,
  finishTaskControl,
  requestTaskAbort,
  requestTaskOpen,
} from '@/tasks/taskControl';

const TASK_ID = 'echo:import';
const taskOwner = createTaskOwner(BUILTIN_PLUGIN_ID);

export type ImportTaskStatus = 'idle' | 'running' | 'completed' | 'aborted';
export type ImportTaskPhase = 'preparing' | 'cloud' | 'local';

export interface ImportTaskAbortOptions {
  feedback?: boolean;
}

export interface ImportTaskRun {
  readonly active: boolean;
  readonly signal: AbortSignal;
  updateProgress: (done: number, total: number, item: ImportItemResult) => boolean;
  resetProgress: (done: number, total: number, items: ImportItemResult[]) => boolean;
  setPhase: (phase: ImportTaskPhase) => boolean;
  complete: (summary: ImportSummary) => boolean;
  enterBackground: (name: string, abortHandler: () => void) => boolean;
  abort: (options?: ImportTaskAbortOptions) => boolean;
  dismiss: () => boolean;
}

let currentRun: ImportTaskRun | null = null;

/** 导入业务状态。任务展示和运行世代由 ImportTaskRun 统一管理。 */
export const useImportTaskStore = defineStore('importTask', {
  state: () => ({
    ...createTaskControlState('detail'),
    status: 'idle' as ImportTaskStatus,
    phase: 'preparing' as ImportTaskPhase,
    playlistName: '',
    done: 0,
    total: 0,
    summary: null as ImportSummary | null,
    items: [] as ImportItemResult[],
    progressRevision: 0,
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
          const { success, skipped, failed } = state.summary;
          const parts = [`成功 ${success}`];
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
    start(
      name: string,
      abortHandler: () => void,
      isCurrentSession: () => boolean = () => true,
    ): ImportTaskRun {
      currentRun?.dismiss();
      // The returned run methods must retain this Pinia instance.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const store = this;
      store.status = 'running';
      store.phase = 'preparing';
      store.playlistName = name;
      store.done = 0;
      store.total = 0;
      store.summary = null;
      store.items = [];
      activateTaskControl(store, abortHandler);

      const task = registerTask(taskOwner, {
        id: TASK_ID,
        name: `导入歌单 · ${name || '未知歌单'}`,
        icon: iconPlaylistAdd,
        status: 'running',
        retention: 'transient',
        progress: { done: 0, total: 0, percent: 0, label: store.statusLabel },
        actions: createTaskLifecycleActions({
          status: 'running',
          onDetail: () => store.requestOpen(),
          onAbort: () => {
            run.abort();
          },
        }),
      });

      const ownsRun = () => currentRun === run;
      const sessionScope = effectScope(true);
      const itemIndices = new Map<ImportItemResult['external'], number>();
      const isRunning = () =>
        ownsRun() &&
        task.active &&
        !task.signal.aborted &&
        isCurrentSession() &&
        store.status === 'running';
      const clearState = () => {
        clearTaskControl(store);
        store.status = 'idle';
        store.phase = 'preparing';
        store.summary = null;
        store.items = [];
        store.progressRevision += 1;
      };

      const run: ImportTaskRun = {
        get active() {
          return ownsRun() && task.active && isCurrentSession();
        },
        signal: task.signal,
        setPhase: (phase) => {
          if (!isRunning()) return false;
          store.phase = phase;
          return true;
        },
        updateProgress: (done, total, item) => {
          if (!isRunning()) return false;
          store.done = done;
          store.total = total;
          const key = toRaw(item.external);
          const index = itemIndices.get(key);
          if (index !== undefined) store.items[index] = { ...item };
          else {
            itemIndices.set(key, store.items.length);
            store.items.push({ ...item });
          }
          store.progressRevision += 1;
          return task.update({
            progress: {
              done,
              total,
              percent: store.percent,
              label: store.statusLabel,
            },
          });
        },
        resetProgress: (done, total, items) => {
          if (!isRunning()) return false;
          store.items = [];
          itemIndices.clear();
          store.done = done;
          store.total = total;
          for (const item of items) {
            const key = toRaw(item.external);
            const index = itemIndices.get(key);
            if (index === undefined) {
              itemIndices.set(key, store.items.length);
              store.items.push({ ...item });
            } else store.items[index] = { ...item };
          }
          store.progressRevision += 1;
          return task.update({
            progress: { done, total, percent: store.percent, label: store.statusLabel },
          });
        },
        complete: (summary) => {
          if (!isRunning()) return false;
          const { success, skipped, failed } = summary;
          const labels = [`成功 ${success}`];
          if (skipped > 0) labels.push(`跳过 ${skipped}`);
          if (failed > 0) labels.push(`失败 ${failed}`);
          if (
            !task.finish('completed', {
              progress: { label: labels.join(' · ') },
              actions: createTaskLifecycleActions({
                status: 'completed',
                onDetail: () => store.requestOpen(),
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
        enterBackground: (nextName, nextAbortHandler) => {
          if (!isRunning()) return false;
          store.playlistName = nextName;
          activateTaskControl(store, nextAbortHandler);
          return task.update({ name: `导入歌单 · ${nextName || '未知歌单'}` });
        },
        abort: (options = {}) => {
          const requested = requestTaskAbort(store, {
            canAbort: () =>
              ownsRun() && task.active && !task.signal.aborted && store.status === 'running',
            feedback: options.feedback,
            markAborted: () => {
              if (!task.finish('aborted', { progress: { label: '已中止' }, actions: [] })) return;
              store.status = 'aborted';
            },
            onRequested: () => {
              logger.info('ImportTask', '后台导入中止请求', {
                playlistName: store.playlistName,
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
          sessionScope.stop();
          task.dismiss();
          clearState();
          currentRun = null;
          return true;
        },
      };

      currentRun = run;
      // The runner can outlive its dialog. Its account subscription must do so
      // too, and is explicitly released when this run is replaced or dismissed.
      sessionScope.run(() =>
        watch(
          isCurrentSession,
          (current) => {
            if (!current) run.dismiss();
          },
          { flush: 'sync', immediate: true },
        ),
      );
      return run;
    },

    getCurrentRun(): ImportTaskRun | null {
      return currentRun;
    },

    enterBackground(name: string, abortHandler: () => void): boolean {
      return currentRun?.enterBackground(name, abortHandler) ?? false;
    },

    requestAbort(options: ImportTaskAbortOptions = {}): boolean {
      return currentRun?.abort(options) ?? false;
    },

    requestOpen() {
      requestTaskOpen(this, 'detail');
    },

    dismiss(): boolean {
      return currentRun?.dismiss() ?? false;
    },
  },
});
