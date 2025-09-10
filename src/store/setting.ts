import { defineStore } from 'pinia';
import type { AudioQuality } from '@/types';

interface Setting {
  mainHeight: number;
  theme: 'light' | 'dark' | 'auto';
  keepAlive: boolean;
  unblock: boolean;
  volumeFade: boolean;
  volumeFadeTime: number;
  showPlaylistCount: boolean;
  autoNextOnError: boolean;
  autoNextOnErrorTime: number;
  compatibilityMode: boolean;
  backupQuality: AudioQuality;
  preventSleep: boolean;
  addSongsToPlaylist: boolean;
  replacePlaylist: boolean;
}

// 默认音质设置
const DEFAULT_AUDIO_QUALITY: AudioQuality = 'flac';

export const useSettingStore = defineStore('setting', {
  persist: true,
  state: (): Setting => ({
    mainHeight: 0,
    theme: 'auto',
    keepAlive: false,
    unblock: false,
    volumeFade: true,
    volumeFadeTime: 1000,
    showPlaylistCount: false,
    autoNextOnError: false,
    autoNextOnErrorTime: 3000,
    compatibilityMode: true,
    backupQuality: DEFAULT_AUDIO_QUALITY,
    preventSleep: false,
    addSongsToPlaylist: false,
    replacePlaylist: false,
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
    setKeepAlive(keepAlive: boolean) {
      this.keepAlive = keepAlive;
    },
    setCompatibilityMode(enabled: boolean) {
      this.compatibilityMode = enabled;
    },
    setBackupQuality(quality: AudioQuality) {
      this.backupQuality = quality;
    },
    setPreventSleep(prevent: boolean) {
      this.preventSleep = prevent;
    },
  },
});
