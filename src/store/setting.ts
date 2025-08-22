import { defineStore } from 'pinia';

interface Setting {
  theme: 'light' | 'dark' | 'auto';
  keepAlive: boolean;
}

export const useSettingStore = defineStore('setting', {
  persist: true,
  state: (): Setting => ({
    theme: 'light',
    keepAlive: true,
  }),
  getters: {
    getTheme: state => state.theme,
    getKeepAlive: state => state.keepAlive,
  },
  actions: {
    setTheme(theme: 'light' | 'dark' | 'auto') {
      this.theme = theme;
    },
    setKeepAlive(keepAlive: boolean) {
      this.keepAlive = keepAlive;
    },
  },
});
