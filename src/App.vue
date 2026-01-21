<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme="naiveTheme"
  >
    <n-global-style />
    <router-view />
    <UserAgreementDialog />
    <UpdateNotification ref="updateNotificationRef" />
  </NConfigProvider>
</template>

<script setup lang="ts">
import { NConfigProvider, NGlobalStyle } from 'naive-ui';
import { zhCN, dateZhCN } from 'naive-ui';
import { useTheme, useSign, useLyrics } from '@/hooks';
import { onMounted, onUnmounted, ref } from 'vue';
import UserAgreementDialog from '@/components/UserAgreementDialog.vue';
import UpdateNotification from '@/components/UpdateNotification.vue';

const { naiveTheme } = useTheme();
const { initAutoSign, cleanup } = useSign();
const { setupDesktopLyricsIPC } = useLyrics();
const updateNotificationRef = ref<InstanceType<typeof UpdateNotification> | null>(null);

// 检查是否在 Electron 环境中
const isElectron = () => {
  return typeof window !== 'undefined' && window.require;
};

onMounted(() => {
  // 初始化自动签到
  initAutoSign();

  // 设置桌面歌词IPC监听器
  setupDesktopLyricsIPC();

  // 在 Electron 环境中静默检查更新
  if (isElectron()) {
    setTimeout(() => {
      updateNotificationRef.value?.checkForUpdatesSilently();
    }, 3000);
  }
});

onUnmounted(() => {
  // 清理资源
  cleanup();
});
</script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
