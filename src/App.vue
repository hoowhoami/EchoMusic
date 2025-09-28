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

  // 设置桌面歌词相关的IPC监听器
  if (typeof window !== 'undefined' && window.require) {
    try {
      const { ipcRenderer } = window.require('electron');

      // 监听桌面歌词设置更新请求
      ipcRenderer.on('update-pinia-desktop-lyrics-setting', (_event: any, data: { key: string; value: any }) => {
        // 更新Pinia设置
        if (data.key === 'fontSize') {
          settingStore.desktopLyrics.fontSize = data.value;
        } else if (data.key === 'windowWidth') {
          settingStore.desktopLyrics.windowWidth = data.value;
        } else if (data.key === 'windowHeight') {
          settingStore.desktopLyrics.windowHeight = data.value;
        }
      });

      // 监听获取桌面歌词设置请求
      ipcRenderer.on('get-pinia-desktop-lyrics-settings-request', () => {
        // 只发送纯数据对象，避免序列化错误
        const settings = {
          fontSize: settingStore.desktopLyrics.fontSize,
          windowWidth: settingStore.desktopLyrics.windowWidth,
          windowHeight: settingStore.desktopLyrics.windowHeight,
          lightTheme: {
            lyricsTextColor: settingStore.desktopLyrics.lightTheme.lyricsTextColor,
            lyricsHighlightColor: settingStore.desktopLyrics.lightTheme.lyricsHighlightColor,
            songInfoColor: settingStore.desktopLyrics.lightTheme.songInfoColor,
          },
          darkTheme: {
            lyricsTextColor: settingStore.desktopLyrics.darkTheme.lyricsTextColor,
            lyricsHighlightColor: settingStore.desktopLyrics.darkTheme.lyricsHighlightColor,
            songInfoColor: settingStore.desktopLyrics.darkTheme.songInfoColor,
          },
        };
        ipcRenderer.send('get-pinia-desktop-lyrics-settings-response', settings);
      });

    } catch (error) {
      console.warn('[Main App] Failed to setup desktop lyrics IPC listeners:', error);
    }
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
