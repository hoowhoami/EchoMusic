import { watch } from 'vue';
import { iconCloudUpload } from '@/icons';
import { useCloudUploadStore } from '@/stores/cloudUpload';
import {
  BUILTIN_PLUGIN_ID,
  createTaskHandle,
  taskPanelOpen,
  type TaskAction,
} from '@/plugins/taskPanel';

const TASK_ID = 'echo:cloud-upload';

/**
 * 云盘上传模块任务面板自注册：把后台上传状态桥接到 taskPanelState。
 * 由 setupTaskBridges() 调用一次，返回 dispose（停止 watch）。
 */
export const setupCloudTaskBridge = (): (() => void) => {
  const cloudUploadStore = useCloudUploadStore();
  const handle = createTaskHandle(TASK_ID, BUILTIN_PLUGIN_ID);

  const stop = watch(
    () =>
      [
        cloudUploadStore.isActive,
        cloudUploadStore.status,
        cloudUploadStore.done,
        cloudUploadStore.total,
        cloudUploadStore.percent,
        cloudUploadStore.statusLabel,
        cloudUploadStore.phase,
      ] as const,
    () => {
      const active =
        cloudUploadStore.isActive ||
        cloudUploadStore.status === 'completed' ||
        cloudUploadStore.status === 'aborted';
      if (!active) {
        handle.dismiss();
        return;
      }

      const taskStatus: 'running' | 'completed' | 'error' | 'aborted' =
        cloudUploadStore.status === 'aborted'
          ? 'aborted'
          : cloudUploadStore.isActive
            ? 'running'
            : 'completed';

      const showProgress = cloudUploadStore.isActive;

      const actions: TaskAction[] = [];

      if (cloudUploadStore.isActive) {
        actions.push(
          {
            id: 'detail',
            label: '查看详情',
            variant: 'ghost',
            onClick: () => {
              cloudUploadStore.requestOpen();
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'abort',
            label: '中止',
            variant: 'ghost',
            onClick: () => cloudUploadStore.requestAbort(),
          },
        );
      } else if (cloudUploadStore.status === 'completed') {
        actions.push(
          {
            id: 'detail',
            label: '查看结果',
            variant: 'ghost',
            onClick: () => {
              cloudUploadStore.requestOpen();
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'dismiss',
            label: '关闭',
            variant: 'ghost',
            onClick: () => cloudUploadStore.dismiss(),
          },
        );
      } else if (cloudUploadStore.status === 'aborted') {
        actions.push({
          id: 'dismiss',
          label: '关闭',
          variant: 'ghost',
          onClick: () => cloudUploadStore.dismiss(),
        });
      }

      handle.set({
        id: TASK_ID,
        name: `上传到云盘 · ${cloudUploadStore.total || '未知'} 首`,
        icon: iconCloudUpload,
        status: taskStatus,
        progress: showProgress
          ? {
              done: cloudUploadStore.done,
              total: cloudUploadStore.total,
              percent: cloudUploadStore.percent,
              label: cloudUploadStore.statusLabel,
            }
          : { label: cloudUploadStore.statusLabel },
        actions,
      });
    },
    { immediate: true },
  );

  return stop;
};
