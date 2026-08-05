import { watch } from 'vue';
import { storeToRefs } from 'pinia';
import { iconCloudDownload } from '@/icons';
import { useUpdateStore } from '@/stores/update';
import {
  BUILTIN_PLUGIN_ID,
  createTaskHandle,
  taskPanelOpen,
  type TaskAction,
} from '@/plugins/taskPanel';

const TASK_ID = 'echo:update';

/**
 * 更新模块任务面板自注册：把更新状态桥接到 taskPanelState。
 * 由 setupTaskBridges() 调用一次，返回 dispose（停止 watch）。
 */
export const setupUpdateTaskBridge = (): (() => void) => {
  const updateStore = useUpdateStore();
  const { downloadStatus, downloadPercent, downloadError, isChecking } = storeToRefs(updateStore);
  const handle = createTaskHandle(TASK_ID, BUILTIN_PLUGIN_ID);

  const stop = watch(
    [isChecking, downloadStatus, downloadPercent, downloadError],
    () => {
      const status = downloadStatus.value;
      const active =
        isChecking.value ||
        status === 'downloading' ||
        status === 'downloaded' ||
        status === 'installing' ||
        status === 'error';

      if (!active) {
        handle.dismiss();
        return;
      }

      let taskStatus: 'running' | 'completed' | 'error' | 'aborted' = 'running';
      let label = '';
      if (isChecking.value) label = '检查中…';
      else if (status === 'downloading') label = `${downloadPercent.value}%`;
      else if (status === 'downloaded') {
        taskStatus = 'completed';
        label = '下载完成';
      } else if (status === 'installing') label = '安装中…';
      else if (status === 'error') {
        taskStatus = 'error';
        label = '失败';
      }

      const progress = label
        ? {
            label,
            percent:
              status === 'downloading'
                ? downloadPercent.value
                : status === 'installing'
                  ? 100
                  : undefined,
          }
        : undefined;

      const actions: TaskAction[] = [];

      if (status === 'downloading') {
        actions.push(
          {
            id: 'detail',
            label: '查看详情',
            variant: 'ghost',
            onClick: () => {
              updateStore.dialogOpen = true;
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'cancel',
            label: '中止',
            variant: 'ghost',
            onClick: () => updateStore.cancelDownload(),
          },
        );
      } else if (status === 'downloaded') {
        actions.push(
          {
            id: 'detail',
            label: '查看详情',
            variant: 'ghost',
            onClick: () => {
              updateStore.dialogOpen = true;
              taskPanelOpen.value = false;
            },
          },
          {
            id: 'install',
            label: '立即安装',
            variant: 'primary',
            onClick: () => {
              void updateStore.install();
            },
          },
        );
      } else if (status === 'error') {
        actions.push(
          {
            id: 'detail',
            label: '详情',
            variant: 'ghost',
            onClick: () => {
              updateStore.dialogOpen = true;
              taskPanelOpen.value = false;
            },
          },
          { id: 'retry', label: '重试', variant: 'ghost', onClick: () => updateStore.download() },
        );
      }

      handle.set({
        id: TASK_ID,
        name: '更新 EchoMusic',
        icon: iconCloudDownload,
        status: taskStatus,
        progress,
        error: status === 'error' ? downloadError.value || '未知错误' : undefined,
        actions,
      });
    },
    { immediate: true },
  );

  return stop;
};
