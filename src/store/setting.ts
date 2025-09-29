import { defineStore } from 'pinia';
import type { AudioQuality } from '@/types';

interface Setting {
  // 主内容高度
  mainHeight: number;
  // 主题
  theme: 'light' | 'dark' | 'auto';
  // 展示播放列表歌曲数量
  showPlaylistCount: boolean;
  // 播放设置
  volumeFade: boolean;
  volumeFadeTime: number;
  autoNextOnError: boolean;
  autoNextOnErrorTime: number;
  preventSleep: boolean;
  addSongsToPlaylist: boolean;
  replacePlaylist: boolean;
  // 音质设置
  compatibilityMode: boolean;
  backupQuality: AudioQuality;
  // 桌面歌词设置
  desktopLyrics: {
    fontSize: number;
    songInfoFontSize: number; // 歌曲信息字体大小
    windowWidth: number;
    windowHeight: number;
    lightTheme: {
      lyricsTextColor: string; // 未高亮歌词颜色
      lyricsHighlightColor: string; // 高亮歌词颜色
      songInfoColor: string; // 歌曲信息颜色
    };
    darkTheme: {
      lyricsTextColor: string; // 未高亮歌词颜色
      lyricsHighlightColor: string; // 高亮歌词颜色
      songInfoColor: string; // 歌曲信息颜色
    };
  };
  // 实验功能
  unblock: boolean;
  keepAlive: boolean;
  autoSign: boolean;
  autoReceiveVip: boolean;
}

// 默认音质设置
const DEFAULT_AUDIO_QUALITY: AudioQuality = 'flac';

export const useSettingStore = defineStore('setting', {
  persist: true,
  state: (): Setting => ({
    mainHeight: 0,
    theme: 'auto',
    showPlaylistCount: false,

    preventSleep: false,
    addSongsToPlaylist: false,
    replacePlaylist: false,
    volumeFade: true,
    volumeFadeTime: 1000,
    autoNextOnError: false,
    autoNextOnErrorTime: 3000,

    compatibilityMode: true,
    backupQuality: DEFAULT_AUDIO_QUALITY,

    // 桌面歌词默认设置
    desktopLyrics: {
      fontSize: 24,
      songInfoFontSize: 24, // 歌曲信息默认字体大小，与歌词字体大小一致
      windowWidth: 600, // 更新默认窗口宽度为600
      windowHeight: 150, // 增加高度以容纳两行歌词
      lightTheme: {
        lyricsTextColor: '#333333', // 亮色主题下未高亮歌词颜色
        lyricsHighlightColor: '#EF0CDCFF', // 亮色主题下高亮歌词颜色
        songInfoColor: '#249C09FF', // 亮色主题下歌曲信息颜色
      },
      darkTheme: {
        lyricsTextColor: '#ffffff', // 暗色主题下未高亮歌词颜色
        lyricsHighlightColor: '#EF0CDCFF', // 暗色主题下高亮歌词颜色
        songInfoColor: '#249C09FF', // 暗色主题下歌曲信息颜色
      },
    },

    keepAlive: false,
    unblock: false,
    autoSign: false,
    autoReceiveVip: false,
  }),
  getters: {
    getTheme: state => state.theme,
    getKeepAlive: state => state.keepAlive,
  },
  actions: {
    setMainHeight(height: number) {
      this.mainHeight = height;
    },
    setTheme(theme: 'light' | 'dark' | 'auto') {
      this.theme = theme;
    },
  },
});
