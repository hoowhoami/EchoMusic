<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme="naiveTheme"
  >
    <n-global-style />
    <router-view />
  </NConfigProvider>
</template>

<script setup lang="ts">
import { NConfigProvider, NGlobalStyle } from 'naive-ui';
import { zhCN, dateZhCN } from 'naive-ui';
import { useTheme } from '@/hooks';
import { onMounted, onUnmounted, watch } from 'vue';
import { useUserStore, useSettingStore } from '@/store';
import { autoSignService } from '@/utils/sign';

const { naiveTheme } = useTheme();
const userStore = useUserStore();
const settingStore = useSettingStore();

// 监听用户登录状态变化
watch(() => userStore.isAuthenticated, (isAuthenticated) => {
  if (isAuthenticated) {
    autoSignService.start();
  } else {
    autoSignService.stop();
  }
});

// 监听自动签到和自动领取VIP配置变化
watch(() => [settingStore.autoSign, settingStore.autoReceiveVip], () => {
  if (userStore.isAuthenticated) {
    autoSignService.restart();
  }
});

onMounted(() => {
  // 如果用户已登录，启动自动签到服务
  if (userStore.isAuthenticated) {
    autoSignService.start();
  }
});

onUnmounted(() => {
  // 组件卸载时停止服务
  autoSignService.stop();
});
</script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
