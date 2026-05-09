import { computed, ref } from 'vue';
import {
  DEFAULT_LYRIC_PLAYED_COLOR,
  DEFAULT_LYRIC_UNPLAYED_COLOR,
  useLyricStore,
} from '@/stores/lyric';

// 歌词颜色预设（用于页面歌词的颜色选择器）
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

type LyricColorField = 'playedColor' | 'unplayedColor';

// 页面歌词颜色选择器的公共状态与操作
export const useLyricColorPicker = () => {
  const lyricStore = useLyricStore();
  const activeField = ref<LyricColorField | null>(null);

  const activeValue = computed(() => {
    if (!activeField.value) return DEFAULT_LYRIC_PLAYED_COLOR;
    return (
      lyricStore[activeField.value] ||
      (activeField.value === 'playedColor'
        ? DEFAULT_LYRIC_PLAYED_COLOR
        : DEFAULT_LYRIC_UNPLAYED_COLOR)
    );
  });

  const isOpen = computed(() => activeField.value !== null);

  const activeTitle = computed(() =>
    activeField.value === 'unplayedColor' ? '选择未播字色' : '选择已播字色',
  );

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
    presets: LYRIC_COLOR_PRESETS,
    open,
    close,
    apply,
    reset,
  };
};
