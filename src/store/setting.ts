import { defineStore } from 'pinia';
import type { SongQuality } from '@/types';

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
  // 音质降级设置
  qualityFallback: boolean;
  fallbackQualities: SongQuality[];
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
    // 音质降级设置默认值
    qualityFallback: true,
    fallbackQualities: ['320', '128'],
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
    setQualityFallback(enabled: boolean) {
      this.qualityFallback = enabled;
    },
    setFallbackQualities(qualities: SongQuality[]) {
      this.fallbackQualities = qualities;
    },
  },
});
