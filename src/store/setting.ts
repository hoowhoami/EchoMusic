import { defineStore } from 'pinia';

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
}

export const useSettingStore = defineStore('setting', {
  persist: true,
  state: (): Setting => ({
    mainHeight: 0,
    theme: 'light',
    keepAlive: false,
    unblock: false,
    volumeFade: false,
    volumeFadeTime: 1000,
    showPlaylistCount: true,
    autoNextOnError: false,
    autoNextOnErrorTime: 3000,
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
  },
});
