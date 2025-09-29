import { useSettingStore } from '@/store';

/**
 * 桌面歌词IPC通信相关逻辑
 */
export function useLyrics() {
  const settingStore = useSettingStore();

  /**
   * 设置桌面歌词IPC监听器
   */
  const setupDesktopLyricsIPC = () => {
    if (typeof window !== 'undefined' && window.require) {
      try {
        const { ipcRenderer } = window.require('electron');

        // 监听桌面歌词设置更新请求
        ipcRenderer.on(
          'update-pinia-desktop-lyrics-setting',
          (_event: any, data: { key: string; value: any }) => {
            // 更新Pinia设置
            if (data.key === 'fontSize') {
              settingStore.desktopLyrics.fontSize = data.value;
            } else if (data.key === 'songInfoFontSize') {
              settingStore.desktopLyrics.songInfoFontSize = data.value;
            } else if (data.key === 'windowWidth') {
              settingStore.desktopLyrics.windowWidth = data.value;
            } else if (data.key === 'windowHeight') {
              settingStore.desktopLyrics.windowHeight = data.value;
            }
          },
        );

        // 监听获取桌面歌词设置请求
        ipcRenderer.on('get-pinia-desktop-lyrics-settings-request', () => {
          // 只发送纯数据对象，避免序列化错误
          const settings = {
            fontSize: settingStore.desktopLyrics.fontSize,
            songInfoFontSize: settingStore.desktopLyrics.songInfoFontSize,
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
        console.warn('[Desktop Lyrics] Failed to setup IPC listeners:', error);
      }
    }
  };

  return {
    setupDesktopLyricsIPC,
  };
}