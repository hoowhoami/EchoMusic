import { defineStore } from 'pinia';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  applyAccentToRoot,
  extractDominantColor,
  getNormalizedAccent,
  hexToRgb,
} from '@/utils/color';

export type AccentMode = 'cover' | 'preset' | 'custom';
type CoverColorSource = string | readonly string[];

// 判断当前是否为深色模式
const isDarkMode = (): boolean => document.documentElement.classList.contains('dark');

const resolveCoverColorSources = (coverUrl: CoverColorSource): string[] => {
  const urls = Array.isArray(coverUrl) ? coverUrl : [coverUrl];
  return Array.from(new Set(urls.map((url) => String(url ?? '').trim()).filter(Boolean)));
};

let coverColorRequestSeq = 0;

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
    // 当前生效的主题色源（未归一化，用于重算）
    sourceColor: DEFAULT_ACCENT,
    // 当前歌曲封面提取色（供歌词页面“跟随封面取色”使用）
    coverColor: DEFAULT_ACCENT,
    // 主窗口实际生效的深浅色状态，由 App.vue 的主题流程同步
    isDark: isDarkMode(),
  }),
  getters: {
    currentPreset: (state) =>
      ACCENT_PRESETS.find((item) => item.id === state.presetId) ?? ACCENT_PRESETS[0],
    // 最终生效的主题色（已按深浅色归一化）。对应主题色过渡动画的“目标色”，
    // 切歌/切主题时立即变到终值，不随 600ms 动画逐帧抖动。供组件与插件稳定消费。
    accentColor: (state): string =>
      getNormalizedAccent(state.sourceColor || DEFAULT_ACCENT, state.isDark),
    // 最终主题色的 RGB 形式，格式为 "r, g, b"，方便插件拼 rgba()。
    accentColorRgb(): string {
      const rgb = hexToRgb(this.accentColor) ?? hexToRgb(DEFAULT_ACCENT);
      return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : '49, 207, 161';
    },
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
    // 从封面提取主色（仅在 cover 模式下有效）
    async refreshFromCover(coverUrl: CoverColorSource) {
      if (this.accentMode !== 'cover') return;
      const next = await this.refreshCoverColor(coverUrl);
      if (!next || this.accentMode !== 'cover') return;
      this.sourceColor = next;
      applyAccentToRoot(next, isDarkMode());
    },
    // 提取当前封面颜色，供歌词页单独使用
    async refreshCoverColor(coverUrl: CoverColorSource): Promise<string | null> {
      const seq = ++coverColorRequestSeq;
      const urls = resolveCoverColorSources(coverUrl);
      if (urls.length === 0) {
        this.coverColor = DEFAULT_ACCENT;
        return this.coverColor;
      }

      let extracted: string | null = null;
      for (const url of urls) {
        extracted = await extractDominantColor(url);
        if (seq !== coverColorRequestSeq) return null;
        if (extracted) break;
      }

      this.coverColor = extracted || DEFAULT_ACCENT;
      return this.coverColor;
    },
    // 明暗切换时重新应用归一化
    onThemeChange() {
      this.isDark = isDarkMode();
      applyAccentToRoot(this.sourceColor || DEFAULT_ACCENT, this.isDark);
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
  },
  persist: {
    pick: ['accentMode', 'presetId', 'customColor', 'globalAccent'],
  },
});
