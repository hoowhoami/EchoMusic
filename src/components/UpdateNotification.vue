<template>
  <n-modal v-model:show="showModal" :mask-closable="false">
    <n-card style="width: 500px" :bordered="false" size="huge">
      <template #header>
        <div class="flex items-center gap-2">
          <n-icon size="24" :component="CloudDownloadOutline" />
          <span>{{ title }}</span>
        </div>
      </template>

      <div class="space-y-4">
        <div v-if="updateStatus === 'checking'">
          <n-spin size="small" />
          <span class="ml-2">正在检查更新...</span>
        </div>

        <div v-else-if="updateStatus === 'available'">
          <p>发现新版本 {{ updateInfo?.version }}</p>
          <p class="text-sm text-gray-500 mt-2">{{ updateInfo?.releaseNotes }}</p>
        </div>

        <div v-else-if="updateStatus === 'downloading'">
          <n-progress type="line" :percentage="downloadProgress" :show-indicator="true" />
          <p class="text-sm text-gray-500 mt-2">
            下载速度: {{ formatSpeed(progressInfo?.bytesPerSecond) }} |
            已下载: {{ formatBytes(progressInfo?.transferred) }} / {{ formatBytes(progressInfo?.total) }}
          </p>
        </div>

        <div v-else-if="updateStatus === 'downloaded'">
          <p>新版本已下载完成，重启应用即可安装</p>
        </div>

        <div v-else-if="updateStatus === 'not-available'">
          <p>当前已是最新版本</p>
        </div>

        <div v-else-if="updateStatus === 'error'">
          <p class="text-red-500">更新失败: {{ errorMessage }}</p>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button v-if="updateStatus === 'available'" @click="downloadUpdate">立即下载</n-button>
          <n-button v-if="updateStatus === 'downloaded'" type="primary" @click="quitAndInstall">立即安装</n-button>
          <n-button v-if="updateStatus !== 'downloading'" @click="closeModal">{{ updateStatus === 'downloaded' ? '稍后安装' : '关闭' }}</n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { CloudDownloadOutline } from '@vicons/ionicons5';

const showModal = ref(false);
const updateStatus = ref<'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'>('checking');
const updateInfo = ref<any>(null);
const progressInfo = ref<any>(null);
const downloadProgress = ref(0);
const errorMessage = ref('');

const title = computed(() => {
  switch (updateStatus.value) {
    case 'checking': return '检查更新';
    case 'available': return '发现新版本';
    case 'downloading': return '正在下载';
    case 'downloaded': return '下载完成';
    case 'not-available': return '已是最新版本';
    case 'error': return '更新失败';
    default: return '应用更新';
  }
});

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSecond: number) => {
  return formatBytes(bytesPerSecond) + '/s';
};

const getIpcRenderer = () => {
  if (typeof window !== 'undefined' && window.require) {
    try {
      const { ipcRenderer } = window.require('electron');
      return ipcRenderer;
    } catch (error) {
      console.error('Failed to get ipcRenderer:', error);
      return null;
    }
  }
  return null;
};

const downloadUpdate = () => {
  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    ipcRenderer.send('download-update');
  }
};

const quitAndInstall = () => {
  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    ipcRenderer.send('quit-and-install');
  }
};

const closeModal = () => {
  showModal.value = false;
};

const checkForUpdates = () => {
  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    showModal.value = true;
    updateStatus.value = 'checking';
    ipcRenderer.send('check-for-updates');
  }
};

onMounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.on('update-checking', () => {
    showModal.value = true;
    updateStatus.value = 'checking';
  });

  ipcRenderer.on('update-available', (_event: any, info: any) => {
    updateStatus.value = 'available';
    updateInfo.value = info;
  });

  ipcRenderer.on('update-not-available', () => {
    updateStatus.value = 'not-available';
    // 不自动关闭，让用户手动关闭
  });

  ipcRenderer.on('update-download-progress', (_event: any, progress: any) => {
    updateStatus.value = 'downloading';
    progressInfo.value = progress;
    downloadProgress.value = Math.round(progress.percent);
  });

  ipcRenderer.on('update-downloaded', (_event: any, info: any) => {
    updateStatus.value = 'downloaded';
    updateInfo.value = info;
  });

  ipcRenderer.on('update-error', (_event: any, error: string) => {
    updateStatus.value = 'error';
    errorMessage.value = error;
  });
});

onUnmounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.removeAllListeners('update-checking');
  ipcRenderer.removeAllListeners('update-available');
  ipcRenderer.removeAllListeners('update-not-available');
  ipcRenderer.removeAllListeners('update-download-progress');
  ipcRenderer.removeAllListeners('update-downloaded');
  ipcRenderer.removeAllListeners('update-error');
});

defineExpose({
  checkForUpdates,
});
</script>
