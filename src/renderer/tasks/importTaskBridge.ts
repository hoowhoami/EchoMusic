import { watch } from 'vue';
import { iconPlaylistAdd } from '@/icons';
import { useImportTaskStore } from '@/stores/importTask';
import {
  BUILTIN_PLUGIN_ID,
  createTaskHandle,
  taskPanelOpen,
  type TaskAction,
} from '@/plugins/taskPanel';

const TASK_ID = 'echo:import';

/**
 * 导入模块任务面板自注册：把后台导入状态桥接到 taskPanelState。
 * 由 setupTaskBridges() 调用一次，返回 dispose（停止 watch）。
 */
export const setupImportTaskBridge = (): (() => void) => {
  const importTaskStore = useImportTaskStore();
  const handle = createTaskHandle(TASK_ID, BUILTIN_PLUGIN_ID);

  const stop = watch(
    () =>
      [
        importTaskStore.isActive,
        importTaskStore.status,
        importTaskStore.playlistName,
        importTaskStore.done,
        importTaskStore.total,
        importTaskStore.percent,
        importTaskStore.statusLabel,
      ] as const,
    () => {
      const active =
        importTaskStore.isActive ||
        importTaskStore.status === 'completed' ||
        importTaskStore.status === 'aborted';
      if (!active) {
        handle.dismiss();
        return;
      }

      const taskStatus: 'running' | 'completed' | 'error' | 'aborted' =
        importTaskStore.status === 'aborted'
          ? 'aborted'
          : importTaskStore.isActive
            ? 'running'
            : 'completed';

      const showProgress = importTaskStore.isActive;

      const actions: TaskAction[] = [];

      if (importTaskStore.isActive) {
        actions.push(
          {
            id: 'detail',
            label: '查看详情',
            variant: 'ghost',
            onClick: () => {
              importTaskStore.requestOpen();
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'abort',
            label: '中止',
            variant: 'ghost',
            onClick: () => importTaskStore.requestAbort(),
          },
        );
      } else if (importTaskStore.status === 'completed') {
        actions.push(
          {
            id: 'detail',
            label: '查看结果',
            variant: 'ghost',
            onClick: () => {
              importTaskStore.requestOpen();
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'dismiss',
            label: '关闭',
            variant: 'ghost',
            onClick: () => importTaskStore.dismiss(),
          },
        );
      } else if (importTaskStore.status === 'aborted') {
        actions.push({
          id: 'dismiss',
          label: '关闭',
          variant: 'ghost',
          onClick: () => importTaskStore.dismiss(),
        });
      }

      handle.set({
        id: TASK_ID,
        name: `导入歌单 · ${importTaskStore.playlistName || '未知歌单'}`,
        icon: iconPlaylistAdd,
        status: taskStatus,
        progress: showProgress
          ? {
              done: importTaskStore.done,
              total: importTaskStore.total,
              percent: importTaskStore.percent,
              label: importTaskStore.statusLabel,
            }
          : { label: importTaskStore.statusLabel },
        actions,
      });
    },
    { immediate: true },
  );

  return stop;
};
