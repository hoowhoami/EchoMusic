import { defineStore } from 'pinia';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  applyAccentToRoot,
  extractDominantColor,
  getNormalizedAccent,
} from '@/utils/color';
import { useLyricStore } from './lyric';

export type AccentMode = 'cover' | 'preset' | 'custom';

// 判断当前是否为深色模式
const isDarkMode = (): boolean => document.documentElement.classList.contains('dark');

export const useThemeStore = defineStore('theme', {
  state: () => ({
    // 主题色来源
    accentMode: 'cover' as AccentMode,
    // 预设 id
    presetId: 'default',
    // 自定义颜色
    customColor: DEFAULT_ACCENT,
    // 全局主题色：true 时影响整个 App，false 时仅影响播放相关区域
    globalAccent: true,
    // 歌词已播字色是否跟随主题色
    lyricAccentSync: true,
    // 当前生效的主题色源（未归一化，用于重算）
    sourceColor: DEFAULT_ACCENT,
  }),
  getters: {
    currentPreset: (state) =>
      ACCENT_PRESETS.find((item) => item.id === state.presetId) ?? ACCENT_PRESETS[0],
  },
  actions: {
    // 根据当前模式计算 source 并应用
    applyCurrent() {
      let source = DEFAULT_ACCENT;
      if (this.accentMode === 'preset') {
        source = this.currentPreset.color;
      } else if (this.accentMode === 'custom') {
        source = this.customColor || DEFAULT_ACCENT;
      } else {
        // cover 模式，用保存的 sourceColor；无值时先用默认
        source = this.sourceColor || DEFAULT_ACCENT;
      }
      this.sourceColor = source;
      applyAccentToRoot(source, isDarkMode());
      this.syncGlobalScope();
      this.syncLyricAccent();
    },
    // 切换模式
    setMode(mode: AccentMode) {
      this.accentMode = mode;
      // 切回封面模式时重置 sourceColor，等待 App 层 watch 根据当前封面重新提取
      if (mode === 'cover') {
        this.sourceColor = DEFAULT_ACCENT;
      }
      this.applyCurrent();
    },
    // 选择预设
    setPreset(id: string) {
      const preset = ACCENT_PRESETS.find((item) => item.id === id);
      if (!preset) return;
      this.presetId = id;
      this.accentMode = 'preset';
      this.applyCurrent();
    },
    // 设置自定义颜色
    setCustomColor(hex: string) {
      this.customColor = hex;
      this.accentMode = 'custom';
      this.applyCurrent();
    },
    // 切换全局主题色开关
    setGlobalAccent(enabled: boolean) {
      this.globalAccent = enabled;
      this.syncGlobalScope();
    },
    // 切换歌词跟随主题色
    setLyricAccentSync(enabled: boolean) {
      this.lyricAccentSync = enabled;
      this.syncLyricAccent();
    },
    // 从封面提取主色（仅在 cover 模式下有效）
    async refreshFromCover(coverUrl: string) {
      if (this.accentMode !== 'cover') return;
      if (!coverUrl) return;
      const extracted = await extractDominantColor(coverUrl);
      const next = extracted || DEFAULT_ACCENT;
      this.sourceColor = next;
      applyAccentToRoot(next, isDarkMode());
      this.syncLyricAccent();
    },
    // 明暗切换时重新应用归一化
    onThemeChange() {
      applyAccentToRoot(this.sourceColor || DEFAULT_ACCENT, isDarkMode());
      this.syncLyricAccent();
    },
    // 同步全局作用范围：通过 body 上的 class 控制 CSS 作用域
    syncGlobalScope() {
      const body = document.body;
      if (this.globalAccent) {
        body.classList.add('accent-global');
        body.classList.remove('accent-scoped');
      } else {
        body.classList.remove('accent-global');
        body.classList.add('accent-scoped');
      }
    },
    // 把主题色同步到歌词 store，用于歌词已播色
    syncLyricAccent() {
      const lyricStore = useLyricStore();
      if (!this.lyricAccentSync) {
        lyricStore.accentPlayedColor = '';
        return;
      }
      const normalized = getNormalizedAccent(this.sourceColor || DEFAULT_ACCENT, isDarkMode());
      lyricStore.accentPlayedColor = normalized;
    },
  },
  persist: {
    pick: ['accentMode', 'presetId', 'customColor', 'globalAccent', 'lyricAccentSync'],
  },
});
