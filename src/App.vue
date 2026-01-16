<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme="naiveTheme"
  >
    <n-global-style />
    <router-view />
    <UserAgreementDialog />
  </NConfigProvider>
</template>

<script setup lang="ts">
import { NConfigProvider, NGlobalStyle } from 'naive-ui';
import { zhCN, dateZhCN } from 'naive-ui';
import { useTheme, useSign, useLyrics } from '@/hooks';
import { onMounted, onUnmounted } from 'vue';
import UserAgreementDialog from '@/components/UserAgreementDialog.vue';

const { naiveTheme } = useTheme();
const { initAutoSign, cleanup } = useSign();
const { setupDesktopLyricsIPC } = useLyrics();

onMounted(() => {
  // 初始化自动签到
  initAutoSign();

  // 设置桌面歌词IPC监听器
  setupDesktopLyricsIPC();
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
