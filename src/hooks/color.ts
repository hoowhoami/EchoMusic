import { ref, computed, watch } from 'vue';
import { mix } from 'color2k';
import { useTheme } from '@/hooks';

export function useGradientColor({
  steps = 10,
  lightColors = {
    start: '#3b82f6',
    end: '#60a5fa',
  },
  darkColors = {
    start: '#1e40af',
    end: '#3b82f6',
  },
} = {}) {
  // 主题
  const { effectiveMode } = useTheme();

  // 当前主题状态
  const isDark = computed(() => effectiveMode.value === 'dark');

  // 当前渐变位置索引
  const currentIndex = ref(0);

  // 基于主题的当前颜色配置
  const currentColorConfig = computed(() => (isDark.value ? darkColors : lightColors));

  // 生成完整的渐变色数组
  const gradientColors = computed(() => {
    const { start, end } = currentColorConfig.value;

    return Array.from({ length: steps }, (_, i) => {
      const ratio = i / (steps - 1);
      return mix(start, end, ratio);
    });
  });

  // 获取当前颜色
  const currentColor = computed(() => gradientColors.value[currentIndex.value]);

  // 获取下一个渐变色（循环）
  const getNextColor = () => {
    currentIndex.value = currentIndex.value + 1;
    if (currentIndex.value > steps - 1) {
      currentIndex.value = 0;
    }
    // currentIndex.value = (currentIndex.value + 1) % steps;
    return currentColor.value;
  };

  // 获取上一个渐变色（循环）
  const getPrevColor = () => {
    if (currentIndex.value === 0) {
      currentIndex.value = steps - 1;
    } else {
      currentIndex.value = currentIndex.value - 1;
    }
    // currentIndex.value = (currentIndex.value - 1 + steps) % steps;
    return currentColor.value;
  };

  // 重置到初始颜色
  const reset = () => {
    currentIndex.value = 0;
  };

  // 监听主题变化，重置渐变序列
  watch(
    () => effectiveMode.value,
    newTheme => {
      console.log('newTheme', newTheme);
      reset(); // 主题变化时重置到初始颜色
    },
  );

  return {
    isDark,
    gradientColors,
    currentColor,
    currentIndex,
    getNextColor,
    getPrevColor,
    reset,
    steps,
    setSteps: (newSteps: number) => {
      steps = newSteps;
      // 确保索引在有效范围内
      if (currentIndex.value >= steps) {
        currentIndex.value = steps - 1;
      }
    },
  };
}
