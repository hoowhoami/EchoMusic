import { computed, ref, type Ref } from 'vue';
import { reloadOtherPluginRuntimes, refreshPlugins } from '@/plugins/runtime';
import { useToastStore } from '@/stores/toast';
import type { PluginLocalInstallItemResult } from '../../../shared/plugins';
import { getPluginInstallErrorMessage } from './pluginInstallErrors';

interface UsePluginLocalInstallOptions {
  marketplaceLoaded: Ref<boolean>;
  loadMarketplace: (refreshSource?: boolean) => Promise<unknown> | unknown;
}

const hasDraggedFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

const normalizeLocalInstallPaths = (paths: string[]) =>
  Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));

const summarizeLocalInstallFailure = (results: PluginLocalInstallItemResult[]) => {
  const firstFailure = results.find((result) => !result.ok);
  return firstFailure?.ok === false ? firstFailure.error : '';
};

export const usePluginLocalInstall = ({
  marketplaceLoaded,
  loadMarketplace,
}: UsePluginLocalInstallOptions) => {
  const toastStore = useToastStore();
  const isLocalInstallDragging = ref(false);
  const isLocalInstalling = ref(false);
  const localInstallDragDepth = ref(0);
  const localInstallCount = ref(0);
  const droppedFilePaths = ref<string[]>([]);

  const localInstallOverlayTitle = computed(() =>
    isLocalInstalling.value
      ? `正在安装 ${localInstallCount.value || ''} 个插件`.trim()
      : '松开安装插件',
  );
  const localInstallOverlayDescription = computed(() =>
    isLocalInstalling.value ? '安装完成后会自动刷新插件列表' : '支持 .zip 压缩包和插件文件夹',
  );

  const installLocalPlugins = async (paths: string[]) => {
    if (isLocalInstalling.value) return;
    const sourcePaths = normalizeLocalInstallPaths(paths);
    droppedFilePaths.value = sourcePaths;
    if (sourcePaths.length === 0) {
      toastStore.warning('未读取到可安装的插件路径');
      return;
    }

    isLocalInstalling.value = true;
    localInstallCount.value = sourcePaths.length;
    try {
      const result = await window.electron.plugins?.installLocal(sourcePaths, {
        enableAfterInstall: false,
      });
      if (!result) throw new Error('插件安装 API 不可用');

      if (result.installed > 0) {
        await refreshPlugins({ reloadActive: true });
        await reloadOtherPluginRuntimes();
        if (marketplaceLoaded.value) await loadMarketplace(false);
      }

      if (result.failed > 0) {
        const failure = summarizeLocalInstallFailure(result.results);
        toastStore.warning(
          `插件安装完成：成功 ${result.installed} 个，失败 ${result.failed} 个${failure ? `。${failure}` : ''}`,
          6000,
        );
        return;
      }

      if (result.installed === 1) {
        const installed = result.results.find((item) => item.ok);
        toastStore.actionCompleted(
          installed?.ok && installed.updated ? '插件已更新' : '插件已安装',
        );
        return;
      }

      toastStore.actionCompleted(`已安装 ${result.installed} 个插件`);
    } catch (error) {
      toastStore.warning(getPluginInstallErrorMessage(error));
    } finally {
      isLocalInstalling.value = false;
      localInstallCount.value = 0;
    }
  };

  const handlePluginDragEnter = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    localInstallDragDepth.value += 1;
    isLocalInstallDragging.value = true;
  };

  const handlePluginDragOver = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = isLocalInstalling.value ? 'none' : 'copy';
    }
    isLocalInstallDragging.value = true;
  };

  const handlePluginDragLeave = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    localInstallDragDepth.value = Math.max(0, localInstallDragDepth.value - 1);
    if (localInstallDragDepth.value === 0) isLocalInstallDragging.value = false;
  };

  const handlePluginDrop = (event: DragEvent) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    localInstallDragDepth.value = 0;
    isLocalInstallDragging.value = false;

    if (isLocalInstalling.value) {
      toastStore.info('插件正在安装中');
      return;
    }

    const files = Array.from(event.dataTransfer?.files ?? []);
    void installLocalPlugins(window.electron.plugins?.getDroppedFilePaths(files) ?? []);
  };

  return {
    isLocalInstallDragging,
    isLocalInstalling,
    droppedFilePaths,
    localInstallOverlayTitle,
    localInstallOverlayDescription,
    installLocalPlugins,
    handlePluginDragEnter,
    handlePluginDragOver,
    handlePluginDragLeave,
    handlePluginDrop,
  };
};
