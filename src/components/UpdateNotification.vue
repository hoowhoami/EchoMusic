<template>
  <n-modal v-model:show="showModal" :mask-closable="false">
    <n-card style="width: 500px" :bordered="false" size="huge">
      <template #header>
        <div class="flex items-center gap-2">
          <n-icon size="24" :component="CloudDownloadOutline" />
          <span>发现新版本</span>
        </div>
      </template>

      <div class="space-y-4">
        <p>发现新版本 {{ updateInfo?.version }}</p>
        <p class="text-sm text-gray-500 mt-2">{{ updateInfo?.releaseNotes }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="closeModal">稍后提醒</n-button>
          <n-button type="primary" @click="openReleasePage">前往下载</n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { CloudDownloadOutline } from '@vicons/ionicons5';

const showModal = ref(false);
const updateInfo = ref<any>(null);

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

const openReleasePage = () => {
  const { shell } = window.require('electron');
  shell.openExternal('https://github.com/hoowhoami/EchoMusic/releases');
  closeModal();
};

const closeModal = () => {
  showModal.value = false;
};

const checkForUpdates = () => {
  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    ipcRenderer.send('check-for-updates');
  }
};

onMounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.on('update-available', (_event: any, info: any) => {
    showModal.value = true;
    updateInfo.value = info;
  });
});

onUnmounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.removeAllListeners('update-available');
});

defineExpose({
  checkForUpdates,
});
</script>
