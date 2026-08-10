import { watch } from 'vue';
import { iconCloudUpload } from '@/icons';
import { useCloudUploadStore } from '@/stores/cloudUpload';
import router from '@/router';
import {
  BUILTIN_PLUGIN_ID,
  createTaskHandle,
  createTaskLifecycleActions,
  type TaskStatus,
} from '@/plugins/taskPanel';

const TASK_ID = 'echo:cloud-upload';

/**
 * 云盘上传模块任务面板自注册：把后台上传状态桥接到 taskPanelState。
 * 由 setupTaskBridges() 调用一次，返回 dispose（停止 watch）。
 */
export const setupCloudTaskBridge = (): (() => void) => {
  const cloudUploadStore = useCloudUploadStore();
  const handle = createTaskHandle(TASK_ID, BUILTIN_PLUGIN_ID);
  const openCloudUploadDetail = async () => {
    if (router.currentRoute.value.name !== 'cloud') {
      await router.push({ name: 'cloud' });
    }
    cloudUploadStore.requestOpen('detail');
  };

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

      const taskStatus: TaskStatus =
        cloudUploadStore.status === 'aborted'
          ? 'aborted'
          : cloudUploadStore.isActive
            ? 'running'
            : 'completed';

      const showProgress = cloudUploadStore.isActive;

      const actions = createTaskLifecycleActions({
        status: taskStatus,
        onDetail: openCloudUploadDetail,
        onAbort: () => cloudUploadStore.requestAbort(),
        onDismiss: () => cloudUploadStore.dismiss(),
      });

      handle.set({
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
