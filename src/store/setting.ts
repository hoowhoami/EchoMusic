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
