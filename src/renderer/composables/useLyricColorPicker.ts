import { computed, ref } from 'vue';
import {
  DEFAULT_LYRIC_PLAYED_COLOR,
  LYRIC_COVER_COLOR_VALUE,
  currentLyricPageIsDark,
  useLyricStore,
} from '@/stores/lyric';
import { useThemeStore } from '@/stores/theme';
import { DEFAULT_ACCENT, getNormalizedAccent } from '@/utils/color';

// 歌词颜色预设（用于播放页歌词的颜色选择器）
export const LYRIC_COLOR_PRESETS = [
  '#31cfa1',
  '#0071e3',
  '#8b5cf6',
  '#ef476f',
  '#f59e0b',
  '#22c55e',
  '#60a5fa',
  '#f97316',
  '#e11d48',
  '#14b8a6',
  '#a855f7',
  '#ffffff',
];

/** 按歌词页外观分档返回预设：浅色页剔除纯白预设，避免用户选到白字白底。 */
export const lyricColorPresetsFor = (isDark: boolean): string[] =>
  isDark ? LYRIC_COLOR_PRESETS : LYRIC_COLOR_PRESETS.filter((color) => color !== '#ffffff');

type LyricColorField = 'playedColor' | 'unplayedColor';

/** 独立导出：取歌词页外观下的封面取色选项，供各皮肤设置复用。 */
export const getLyricCoverDynamicOption = (): {
  label: string;
  value: string;
  color: string;
} => {
  const themeStore = useThemeStore();
  return {
    label: '跟随封面取色',
    value: LYRIC_COVER_COLOR_VALUE,
    color: getNormalizedAccent(themeStore.coverColor || DEFAULT_ACCENT, currentLyricPageIsDark()),
  };
};

// 播放页歌词颜色选择器的公共状态与操作
export const useLyricColorPicker = () => {
  const lyricStore = useLyricStore();
  const themeStore = useThemeStore();
  const activeField = ref<LyricColorField | null>(null);

  const activeValue = computed(() => {
    if (!activeField.value) return DEFAULT_LYRIC_PLAYED_COLOR;
    // 默认值随歌词页外观分档：浅色页已播回退加深绿、未播回退深色文字
    return (
      lyricStore[activeField.value] ||
      (activeField.value === 'playedColor'
        ? lyricStore.effectivePlayedColor
        : lyricStore.effectiveUnplayedColor)
    );
  });

  const isOpen = computed(() => activeField.value !== null);

  const activeTitle = computed(() =>
    activeField.value === 'unplayedColor' ? '选择未播字色' : '选择已播字色',
  );

  const coverColor = computed(() =>
    getNormalizedAccent(themeStore.coverColor || DEFAULT_ACCENT, currentLyricPageIsDark()),
  );

  const dynamicOption = computed(() => ({
    label: '跟随封面取色',
    value: LYRIC_COVER_COLOR_VALUE,
    color: coverColor.value,
  }));

  const open = (field: LyricColorField) => {
    activeField.value = field;
  };

  const close = () => {
    activeField.value = null;
  };

  const apply = (value: string) => {
    if (!activeField.value) return;
    lyricStore[activeField.value] = value;
    close();
  };

  const reset = () => {
    lyricStore.playedColor = '';
    lyricStore.unplayedColor = '';
  };

  return {
    activeField,
    activeValue,
    activeTitle,
    isOpen,
    dynamicOption,
    // 预设随歌词页外观分档（浅色页剔除纯白）
    presets: computed(() => lyricColorPresetsFor(currentLyricPageIsDark())),
    open,
    close,
    apply,
    reset,
  };
};
