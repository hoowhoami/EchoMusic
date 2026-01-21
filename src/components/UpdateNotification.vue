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
        <n-spin v-if="checking" size="small" />
        <template v-else>
          <p v-if="hasUpdate">发现新版本 {{ updateInfo?.version }}</p>
          <p v-else>当前已是最新版本</p>
          <div v-if="hasUpdate && updateInfo?.releaseNotes" class="text-sm text-gray-500 mt-2" v-html="updateInfo.releaseNotes"></div>
        </template>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="closeModal">关闭</n-button>
          <n-button v-if="hasUpdate" type="primary" @click="openReleasePage">前往下载</n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { CloudDownloadOutline } from '@vicons/ionicons5';

const showModal = ref(false);
const checking = ref(false);
const hasUpdate = ref(false);
const updateInfo = ref<any>(null);

const title = computed(() => {
  if (checking.value) return '检查更新';
  if (hasUpdate.value) return '发现新版本';
  return '已是最新版本';
});

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
  checking.value = false;
};

const checkForUpdates = () => {
  const ipcRenderer = getIpcRenderer();
  if (ipcRenderer) {
    showModal.value = true;
    checking.value = true;
    hasUpdate.value = false;
    updateInfo.value = null;
    ipcRenderer.send('check-for-updates');
  }
};

onMounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.on('update-available', (_event: any, info: any) => {
    checking.value = false;
    hasUpdate.value = true;
    updateInfo.value = info;
    if (!showModal.value) {
      showModal.value = true;
    }
  });

  ipcRenderer.on('update-not-available', () => {
    checking.value = false;
    hasUpdate.value = false;
  });
});

onUnmounted(() => {
  const ipcRenderer = getIpcRenderer();
  if (!ipcRenderer) return;

  ipcRenderer.removeAllListeners('update-available');
  ipcRenderer.removeAllListeners('update-not-available');
});

defineExpose({
  checkForUpdates,
});
</script>
